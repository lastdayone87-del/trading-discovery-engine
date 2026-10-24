import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  OfficialYouTubeQuotaFenceError,
  assertOfficialYouTubeQuotaOriginKnown,
  currentOfficialYouTubeQuotaOrigin,
  isOfficialYouTubeQuotaOriginKnown,
  isProbeOfficialYouTubeQuotaOrigin,
  mergeQuotaOrigins,
  persistedQuotaOrigin,
  runWithOfficialYouTubeQuotaOrigin,
} from './officialYouTubeQuotaFence';
import {
  QuotaOriginUnavailableError,
  getChannelQuotaOrigin,
  resolveJobQuotaOrigin,
  resolvePipelineQuotaOrigin,
  type QuotaOriginDb,
} from './quotaOrigin';

test('origin merge is sticky: PROBE wins, UNKNOWN fails closed over NORMAL', () => {
  assert.equal(mergeQuotaOrigins('NORMAL', 'PROBE'), 'PROBE');
  assert.equal(mergeQuotaOrigins('PROBE', 'UNKNOWN'), 'PROBE');
  assert.equal(mergeQuotaOrigins('NORMAL', 'UNKNOWN'), 'UNKNOWN');
  assert.equal(mergeQuotaOrigins(undefined, 'NORMAL'), 'NORMAL');
});

test('ALS refuses to downgrade PROBE and fails closed without provenance', () => {
  assert.equal(currentOfficialYouTubeQuotaOrigin(), 'NORMAL');
  runWithOfficialYouTubeQuotaOrigin('PROBE', 'outer', () => {
    assert.equal(isProbeOfficialYouTubeQuotaOrigin(), true);
    runWithOfficialYouTubeQuotaOrigin('NORMAL', 'inner', () => {
      assert.equal(currentOfficialYouTubeQuotaOrigin(), 'PROBE');
    });
  });
  runWithOfficialYouTubeQuotaOrigin('UNKNOWN', 'unknown', () => {
    assert.equal(isOfficialYouTubeQuotaOriginKnown(), false);
    assert.throws(
      () => assertOfficialYouTubeQuotaOriginKnown('test'),
      (error: unknown) => error instanceof OfficialYouTubeQuotaFenceError
    );
  });
  assert.equal(persistedQuotaOrigin('UNKNOWN'), 'PROBE');
});

test('job origin: payload PROBE is sticky; persisted PROBE upgrades NORMAL', async () => {
  let queries = 0;
  const db: QuotaOriginDb = {
    query: async () => {
      queries++;
      return { rows: [{ channel_id: 'probe-channel', quota_origin: 'PROBE' }], rowCount: 1 };
    },
  };
  assert.equal(await resolveJobQuotaOrigin({ type: 'ENRICH_CHANNEL', payload: { channelId: 'probe-channel', quotaOrigin: 'PROBE' } }, db), 'PROBE');
  assert.equal(queries, 0, 'explicit PROBE evidence does not need a read');
  assert.equal(await resolveJobQuotaOrigin({ type: 'ENRICH_CHANNEL', payload: { channelId: 'probe-channel' } }, db), 'PROBE');
  assert.equal(queries, 1);
});

test('job origin: missing channel or malformed hint is terminal UNKNOWN; a DB failure is retryable', async () => {
  const missing: QuotaOriginDb = { query: async () => ({ rows: [], rowCount: 0 }) };
  assert.equal(await resolveJobQuotaOrigin({ type: 'ENRICH_CHANNEL', payload: { channelId: 'gone' } }, missing), 'UNKNOWN');
  assert.equal(await resolveJobQuotaOrigin({ type: 'ENRICH_CHANNEL', payload: { channelId: 'x', quotaOrigin: 'something' } }, missing), 'UNKNOWN');
  const failing: QuotaOriginDb = { query: async () => { throw new Error('db down'); } };
  await assert.rejects(
    resolveJobQuotaOrigin({ type: 'ENRICH_CHANNEL', payload: { channelId: 'x' } }, failing),
    (error: unknown) => error instanceof QuotaOriginUnavailableError
      && (error as QuotaOriginUnavailableError).code === 'QUOTA_ORIGIN_UNAVAILABLE'
      && (error as QuotaOriginUnavailableError).retryable === true,
  );
  assert.equal(await resolveJobQuotaOrigin({ type: 'SEARCH_YOUTUBE', payload: {} }, failing), 'NORMAL');
});

test('non-channel canary jobs default to NORMAL and still honor an explicit PROBE hint', async () => {
  const neverQueried: QuotaOriginDb = {
    query: async () => { throw new Error('non-channel jobs must not query channel provenance'); },
  };
  assert.equal(
    await resolveJobQuotaOrigin({ type: 'INSPECT_PLAYLIST', payload: { playlistId: 'PL123' } }, neverQueried),
    'NORMAL',
    'playlist canaries have their own adapter budget and no channel row'
  );
  assert.equal(
    await resolveJobQuotaOrigin({
      type: 'RELATIONSHIP_CANARY_EXPANSION',
      payload: { cohortId: 'cohort-1', seeds: [{ kind: 'channel', id: `UC${'a'.repeat(22)}` }] },
    }, neverQueried),
    'NORMAL',
    'relationship canaries are ordinary-quota jobs unless explicitly marked'
  );
  assert.equal(
    await resolveJobQuotaOrigin({ type: 'INSPECT_PLAYLIST', payload: { playlistId: 'PL123', quotaOrigin: 'PROBE' } }, neverQueried),
    'PROBE',
    'an explicit probe-origin hint remains authoritative'
  );
});

test('featured canary tolerates a missing source row but keeps an existing PROBE row', async () => {
  const missing: QuotaOriginDb = { query: async () => ({ rows: [], rowCount: 0 }) };
  assert.equal(
    await resolveJobQuotaOrigin({
      type: 'INSPECT_FEATURED_CHANNELS',
      payload: { sourceChannelId: `UC${'b'.repeat(22)}` },
    }, missing),
    'NORMAL',
    'a featured source may exist only in creator_outcome_records/entity_bindings'
  );
  assert.equal(
    await resolveJobQuotaOrigin({
      type: 'INSPECT_FEATURED_CHANNELS',
      payload: { sourceChannelId: `UC${'b'.repeat(22)}`, quotaOrigin: 'PROBE' },
    }, missing),
    'PROBE',
  );
  const probe: QuotaOriginDb = {
    query: async () => ({ rows: [{ channel_id: `UC${'b'.repeat(22)}`, quota_origin: 'PROBE' }], rowCount: 1 }),
  };
  assert.equal(
    await resolveJobQuotaOrigin({
      type: 'INSPECT_FEATURED_CHANNELS',
      payload: { sourceChannelId: `UC${'b'.repeat(22)}` },
    }, probe),
    'PROBE',
    'an existing probe-marked source remains sticky'
  );
  const malformed: QuotaOriginDb = {
    query: async () => ({ rows: [{ channel_id: `UC${'b'.repeat(22)}`, quota_origin: 'weird' }], rowCount: 1 }),
  };
  assert.equal(
    await resolveJobQuotaOrigin({
      type: 'INSPECT_FEATURED_CHANNELS',
      payload: { sourceChannelId: `UC${'b'.repeat(22)}` },
    }, malformed),
    'UNKNOWN',
    'a malformed persisted marker still fails closed'
  );
});

test('pipeline origin read failure is retryable infrastructure, not a terminal verdict', async () => {
  const failing: QuotaOriginDb = { query: async () => { throw new Error('db down'); } };
  await assert.rejects(
    resolvePipelineQuotaOrigin({ channelId: 'c' }, undefined, failing),
    (error: unknown) => error instanceof QuotaOriginUnavailableError
      && (error as QuotaOriginUnavailableError).code === 'QUOTA_ORIGIN_UNAVAILABLE'
      && (error as QuotaOriginUnavailableError).retryable === true,
  );
});

test('queue dispatcher routes provenance failures through the handler lifecycle', () => {
  const source = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
  const start = source.indexOf('const job = await claimNextJob');
  const dispatcher = source.slice(start, source.indexOf('export interface ProcessDiscoveredChannelOutcome'));
  assert.ok(start >= 0 && dispatcher.length > 0);
  assert.match(dispatcher, /try \{[\s\S]*resolveJobQuotaOrigin\(job\)/);
  assert.match(dispatcher, /throw new OfficialYouTubeQuotaFenceError/);
  assert.match(dispatcher, /return await runWithOfficialYouTubeQuotaOrigin\(quotaOrigin/);
  assert.doesNotMatch(dispatcher, /failJob\(job\.id, new OfficialYouTubeQuotaFenceError/,
    'terminal provenance failures must use the job-specific catch/cleanup path');
});

test('pipeline origin: existing PROBE is sticky; malformed persisted marker fails closed', async () => {
  const probe: QuotaOriginDb = { query: async () => ({ rows: [{ quota_origin: 'PROBE' }], rowCount: 1 }) };
  assert.equal(await resolvePipelineQuotaOrigin({ channelId: 'c' }, undefined, probe), 'PROBE');
  assert.equal(await resolvePipelineQuotaOrigin({ channelId: 'c', quotaOrigin: 'NORMAL' }, undefined, probe), 'PROBE');

  const malformed: QuotaOriginDb = { query: async () => ({ rows: [{ quota_origin: 'weird' }], rowCount: 1 }) };
  assert.equal(await getChannelQuotaOrigin('c', malformed), 'UNKNOWN');
  assert.equal(await resolvePipelineQuotaOrigin({ channelId: 'c' }, undefined, malformed), 'UNKNOWN');

  const absent: QuotaOriginDb = { query: async () => ({ rows: [], rowCount: 0 }) };
  assert.equal(await resolvePipelineQuotaOrigin({ channelId: 'new' }, undefined, absent), 'NORMAL');
  assert.equal(await resolvePipelineQuotaOrigin({ channelId: 'new', quotaOrigin: 'PROBE' }, undefined, absent), 'PROBE');
});
