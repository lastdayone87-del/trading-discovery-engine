import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import type { ChannelRecord } from '../src/types';
import type { ValidationResult } from './countryValidator';
import { revalidateConfirmedCountryForPreservedRow } from './ingestionPipeline';
import { enqueueClassificationJobAtomic } from './dbCore';
import { ProbeQuotaUnavailableError } from './quotaKeyCapShadow';
import { YouTubeQuotaAccountingError } from './youtubeKeyHealth';

const now = '2026-11-09T00:00:00.000Z';

function confirmedChannel(overrides: Partial<ChannelRecord> = {}): ChannelRecord {
  return {
    channel_id: 'UCbowie',
    channel_name: 'Bowie',
    youtube_url: 'https://www.youtube.com/channel/UCbowie',
    country: '',
    country_status: 'UNCERTAIN',
    trading_status: 'TRADING_CONFIRMED',
    scan_status: 'COMPLETED',
    subscriber_count: '120000',
    inspection_trail: [],
    ...overrides,
  } as ChannelRecord;
}

function candidate() {
  return {
    channelId: 'UCbowie',
    channelName: 'Bowie',
    youtubeUrl: 'https://www.youtube.com/channel/UCbowie',
    description: '',
    videoTitles: [],
    channelLinks: [],
  } as any;
}

function validation(overrides: Partial<ValidationResult>): ValidationResult {
  return {
    status: 'UNCERTAIN',
    score: 0,
    detectedCreatorCountry: null,
    decisionLogs: '',
    evidence: {},
    ...overrides,
  } as ValidationResult;
}

test('confirmed unresolved-country rediscovery hydrates country evidence without reclassifying trading', async () => {
  const existing = confirmedChannel();
  let hydrations = 0;
  const result = await revalidateConfirmedCountryForPreservedRow(candidate(), existing, 'Netherlands', now, {
    hydrate: async () => {
      hydrations += 1;
      return validation({ status: 'CONFIRMED', detectedCreatorCountry: 'Netherlands', score: 88 });
    },
  });

  assert.equal(hydrations, 1);
  assert.deepEqual(result, { countryChecked: true, rejectionApplied: false });
  assert.equal(existing.trading_status, 'TRADING_CONFIRMED');
  assert.equal(existing.country_status, 'CONFIRMED');
  assert.equal(existing.country, 'Netherlands');
  assert.equal(existing.confidence_score, 88);
});

test('a country rejection is projected while the confirmed trading decision stays untouched', async () => {
  const existing = confirmedChannel();
  const result = await revalidateConfirmedCountryForPreservedRow(candidate(), existing, 'Netherlands', now, {
    hydrate: async () => validation({ status: 'REJECTED', detectedCreatorCountry: 'Germany', score: 95, decisionLogs: 'excluded country' }),
  });

  assert.deepEqual(result, { countryChecked: true, rejectionApplied: true });
  assert.equal(existing.country_status, 'REJECTED');
  assert.equal(existing.country, 'Germany');
  assert.equal(existing.trading_status, 'TRADING_CONFIRMED');
  assert.equal(existing.scan_status, 'COMPLETED');
});

test('sparse evidence that stays uncertain still reports the country pass as complete', async () => {
  const existing = confirmedChannel();
  const result = await revalidateConfirmedCountryForPreservedRow(candidate(), existing, 'Netherlands', now, {
    hydrate: async () => validation({ status: 'UNCERTAIN' }),
  });

  assert.deepEqual(result, { countryChecked: true, rejectionApplied: false });
  assert.equal(existing.country_status, 'UNCERTAIN');
  assert.equal(existing.trading_status, 'TRADING_CONFIRMED');
});

test('probe quota and accounting failures propagate instead of being counted as processed', async () => {
  const probe = new ProbeQuotaUnavailableError('probe allocation unavailable');
  await assert.rejects(
    revalidateConfirmedCountryForPreservedRow(candidate(), confirmedChannel(), 'Netherlands', now, {
      hydrate: async () => { throw probe; },
    }),
    probe,
  );
  const accounting = new YouTubeQuotaAccountingError(1, 'key');
  await assert.rejects(
    revalidateConfirmedCountryForPreservedRow(candidate(), confirmedChannel(), 'Netherlands', now, {
      hydrate: async () => { throw accounting; },
    }),
    accounting,
  );
});

test('ordinary provider failures preserve the confirmed row and report no update', async () => {
  const existing = confirmedChannel();
  const result = await revalidateConfirmedCountryForPreservedRow(candidate(), existing, 'Netherlands', now, {
    hydrate: async () => { throw new Error('network down'); },
  });

  assert.deepEqual(result, { countryChecked: false, rejectionApplied: false });
  assert.equal(existing.country_status, 'UNCERTAIN');
  assert.equal(existing.trading_status, 'TRADING_CONFIRMED');
});

test('active-work detection covers community retries and can exclude the terminalizing job',()=>{
  const source=readFileSync(new URL('./dbCore.ts',import.meta.url),'utf8');
  assert.match(source,/RETRY_COMMUNITY_ACQUISITION/);
  assert.match(source,/hasActiveEnrichmentJob\(channelId: string, excludeJobId\?: string \| null\)/);
  assert.match(source,/id <> \$3::uuid/);assert.match(source,/\[channelId, CLASSIFICATION_JOB_TYPE, excludeJobId \|\| null\]/);
  const pipeline=readFileSync(new URL('./ingestionPipeline.ts',import.meta.url),'utf8');
  assert.match(pipeline,/hasActiveEnrichmentJob\(existing\.channel_id, options\?\.jobId\)/);
  assert.doesNotMatch(pipeline,/shouldSkipDeepEnrichment && options\?\.forceClassification/);
});

test('classification admission wiring uses a shared atomic per-channel lock', () => {
  const db = readFileSync(new URL('./dbCore.ts', import.meta.url), 'utf8');
  const queue = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
  assert.match(db, /export async function enqueueClassificationJobAtomic/);
  assert.match(db, /classification-admit:/);
  assert.match(db, /pg_advisory_xact_lock/);
  assert.match(queue, /enqueueClassificationJobAtomic\(raw\.channelId/);
  assert.match(queue, /enqueueClassificationJobAtomic\(channel\.channel_id/);
});

function admissionClient(active: boolean) {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const client = {
    query: async (text: string, params: unknown[] = []) => {
      calls.push({ text, params });
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (text.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 0 };
      if (text.includes('SELECT 1 FROM jobs')) return { rows: active ? [{ exists: 1 }] : [], rowCount: active ? 1 : 0 };
      if (text.includes('INSERT INTO jobs')) {
        return { rows: [{
          id: 'job-1',
          type: 'CLASSIFY_DISCOVERED_CHANNEL',
          status: 'PENDING',
          payload: JSON.stringify({ channelId: 'chan-1' }),
          attempts: 0,
          max_attempts: 4,
          run_after: new Date().toISOString(),
          locked_by: null,
          locked_at: null,
          last_error: null,
          created_at: new Date().toISOString(),
          reopen_generation: 0,
        }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => calls.push({ text: 'RELEASE', params: [] }),
  };
  return { client, calls };
}

test('atomic classification admission locks, rechecks, and inserts one job', async () => {
  const { client, calls } = admissionClient(false);
  const job = await enqueueClassificationJobAtomic('chan-1', { channelId: 'chan-1' }, {
    priority: 1,
    maxAttempts: 4,
    idempotencyKey: 'classify:chan-1:2026-11-10',
    clientOverride: client as any,
  });
  assert.equal(job?.status, 'PENDING');
  assert.ok(calls.some(call => call.text.includes('pg_advisory_xact_lock')));
  assert.ok(calls.some(call => call.text.includes('SELECT 1 FROM jobs')));
  assert.equal(calls.filter(call => call.text.includes('INSERT INTO jobs')).length, 1);
  assert.ok(!calls.some(call => call.text === 'RELEASE'), 'an injected client is owned by the caller');
});

test('atomic classification admission refuses while another classification is active', async () => {
  const { client, calls } = admissionClient(true);
  const job = await enqueueClassificationJobAtomic('chan-1', { channelId: 'chan-1' }, {
    priority: 1,
    maxAttempts: 4,
    idempotencyKey: 'classify:chan-1:2026-11-10',
    clientOverride: client as any,
  });
  assert.equal(job, null);
  assert.equal(calls.filter(call => call.text.includes('INSERT INTO jobs')).length, 0);
});
