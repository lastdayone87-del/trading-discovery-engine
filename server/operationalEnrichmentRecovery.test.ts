import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  reconcileOperationalEnrichmentRecovery,
  shouldReactivateOperationalEnrichment,
  reactivateOperationalEnrichment,
} from './operationalEnrichmentRecovery';

const base = (overrides: Record<string, unknown> = {}) => ({
  channel_id: 'channel-1',
  scan_status: 'FAILED' as const,
  trading_status: 'UNCERTAIN' as const,
  country_status: 'UNCERTAIN' as const,
  discord_validation_status: 'NOT_STARTED' as const,
  last_checked: '2026-08-20T00:00:00.000Z',
  inspection_trail: [],
  ...overrides
});

test('operational enrichment recovery reopens an old machine-owned failure', () => {
  const decision = shouldReactivateOperationalEnrichment(base(), Date.parse('2026-08-24T00:00:00.000Z'));
  assert.equal(decision.reactivate, true);
  assert.deepEqual(decision.reasonCodes, ['OPERATIONALLY_BLOCKED_ENRICHMENT_FAILURE', 'OPERATIONAL_RECOVERY_COOLDOWN_EXPIRED']);
  const updated = reactivateOperationalEnrichment(base() as any, decision.reasonCodes, '2026-08-24T00:00:00.000Z');
  assert.equal(updated.scan_status, 'ENRICHMENT_PENDING');
  assert.equal(updated.trading_status, 'UNCERTAIN');
  assert.equal(updated.last_checked, '2026-08-24T00:00:00.000Z');
});

test('operational enrichment recovery preserves a positive trading decision while recovering independent enrichment', () => {
  const channel = base({ trading_status: 'TRADING_CONFIRMED' });
  const decision = shouldReactivateOperationalEnrichment(channel, Date.parse('2026-08-24T00:00:00.000Z'));
  assert.equal(decision.reactivate, true);
  const updated = reactivateOperationalEnrichment(channel as any, decision.reasonCodes, '2026-08-24T00:00:00.000Z');
  assert.equal(updated.scan_status, 'ENRICHMENT_PENDING');
  assert.equal(updated.trading_status, 'TRADING_CONFIRMED');
});

test('operational enrichment recovery preserves negative semantic, human, and completed Discord terminal decisions', () => {
  for (const overrides of [
    { trading_status: 'NON_TRADING' },
    { trading_status: 'HUMAN_REJECTED' },
    { country_status: 'REJECTED' },
    { discord_validation_status: 'COMPLETED' },
    { scan_status: 'COMPLETED' }
  ]) {
    const decision = shouldReactivateOperationalEnrichment(base(overrides), Date.parse('2026-08-24T00:00:00.000Z'));
    assert.equal(decision.reactivate, false, JSON.stringify(overrides));
    assert.equal(decision.reasonCodes[0], overrides.discord_validation_status === 'COMPLETED'
      ? 'COMPLETED_DISCORD_OUTCOME_PRESERVED'
      : overrides.trading_status === 'NON_TRADING' || overrides.trading_status === 'HUMAN_REJECTED' || overrides.country_status === 'REJECTED'
        ? 'SEMANTIC_OR_HUMAN_DECISION_PRESERVED'
        : 'SCAN_STATUS_NOT_RECOVERABLE_FAILURE');
  }
});

test('operational enrichment recovery respects the 24-hour cooldown', () => {
  const decision = shouldReactivateOperationalEnrichment(base({ last_checked: '2026-08-23T12:00:00.000Z' }), Date.parse('2026-08-24T00:00:00.000Z'));
  assert.equal(decision.reactivate, false);
  assert.deepEqual(decision.reasonCodes, ['OPERATIONAL_RECOVERY_COOLDOWN_ACTIVE']);
});

test('runtime reconciliation lets the latest enrichment attempt supersede an older failure', () => {
  const source = readFileSync(new URL('./operationalEnrichmentRecovery.ts', import.meta.url), 'utf8');
  assert.match(source, /SELECT latest_job\.id, latest_job\.attempts, latest_job\.status, latest_job\.last_error/);
  assert.match(source, /JOIN LATERAL \([\s\S]*?latest_job\.type IN\('ENRICH_CHANNEL','POST_APPROVAL_ENRICH','FORCE_REVIEW_RESCAN'\)[\s\S]*?ORDER BY latest_job\.updated_at DESC[\s\S]*?\) failed_job ON true[\s\S]*?failed_job\.status='FAILED'[\s\S]*?failed_job\.last_error ILIKE 'OPERATIONALLY_BLOCKED_RETRY_REQUIRED:%'/);
  assert.doesNotMatch(source, /latest_job\.type IN\([^)]*RETRY_COMMUNITY_ACQUISITION/,
    'community acquisition is a separate lane and must not hide an enrichment failure');
});

test('recovery enqueue and ledger write roll back together when the ledger write fails', async () => {
  const channel = base({ channel_id: 'channel-tx', last_checked: '2026-08-20T00:00:00.000Z' });
  const upserts: Array<Record<string, unknown>> = [];
  const statements: string[] = [];
  const pool = {
    totalCount: 1,
    query: async (sql: string) => {
      statements.push(sql);
      if (sql.includes('FROM channels c')) {
        return {
          rows: [{
            channel_id: channel.channel_id,
            failed_job_id: 'job-1',
            failed_job_attempts: 2,
            recovery_cycles: 0,
          }],
        };
      }
      throw new Error(`unexpected pool query: ${sql}`);
    },
    connect: async () => ({
      query: async (sql: string) => {
        statements.push(sql);
        if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
        if (sql.includes('INSERT INTO operational_enrichment_recovery_events')) {
          throw new Error('injected ledger failure');
        }
        return { rows: [] };
      },
      release: () => undefined,
    }),
  };

  await assert.rejects(
    reconcileOperationalEnrichmentRecovery(
      async () => pool,
      async () => channel as any,
      async updated => { upserts.push(updated as unknown as Record<string, unknown>); },
      async () => undefined,
      20,
      Date.now() + 120_000,
    ),
    /injected ledger failure/
  );
  assert.ok(statements.includes('BEGIN'));
  assert.ok(statements.includes('ROLLBACK'));
  assert.ok(!statements.includes('COMMIT'));
  assert.equal(upserts.length, 2, 'reactivated channel is restored after the transaction fails');
});

test('runtime reconciliation admits confirmed trading rows and is null-safe for unresolved metadata', () => {
  const source = readFileSync(new URL('./operationalEnrichmentRecovery.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /c\.trading_status='UNCERTAIN'/);
  assert.match(source, /c\.trading_status IS DISTINCT FROM 'NON_TRADING'/);
  assert.match(source, /c\.trading_status IS DISTINCT FROM 'HUMAN_REJECTED'/);
  assert.match(source, /c\.discord_validation_status IS DISTINCT FROM 'COMPLETED'/);
  assert.match(source, /c\.country_status IS DISTINCT FROM 'REJECTED'/);
});

test('migration 121 is narrow, transactional, and resets stale transient-age provenance only for requeued jobs', () => {
  const migration = readFileSync(new URL('./db/migrations/121_recover_operational_enrichment_failures.sql', import.meta.url), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS operational_enrichment_recovery_events/);
  assert.match(migration, /trading_status='UNCERTAIN'/);
  assert.match(migration, /discord_validation_status.*COMPLETED/);
  assert.match(migration, /country_status.*REJECTED/);
  assert.match(migration, /active_job\.status IN \('PENDING','PROCESSING'\)/);
  assert.match(migration, /first_transient_failure_at=NULL/);
  assert.match(migration, /ON CONFLICT\(event_key\) DO NOTHING/);
  assert.doesNotMatch(migration, /DELETE FROM channels|TRUNCATE|DROP TABLE/);
});

test('worker invokes operational enrichment recovery before claiming the next job', () => {
  const source = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
  assert.match(source, /await reconcileOperationalEnrichmentRecovery\(getDb, getChannelById, upsertChannel, enqueueOperationalEnrichmentRecoveryJob/);
  assert.match(source, /operationalEnrichmentRecoveryKey\(channel\.channel_id\)/);
  assert.match(source, /recoveryReasonCodes/);
  assert.match(source, /UPDATE jobs SET first_transient_failure_at=NULL WHERE id=\$1 AND status='PENDING'/);
});


test('provider-deferred enrichment remains governed and reactivates after cooldown',()=>{
  const channel=base({scan_status:'PROVIDER_DEFERRED'});
  const decision=shouldReactivateOperationalEnrichment(channel,Date.parse('2026-08-24T00:00:00.000Z'));
  assert.equal(decision.reactivate,true);
  const updated=reactivateOperationalEnrichment(channel as any,decision.reasonCodes,'2026-08-24T00:00:00.000Z');
  assert.equal(updated.scan_status,'ENRICHMENT_PENDING');
  assert.equal(updated.trading_status,'UNCERTAIN');
});

test('provider-deferred projection is bounded and preserves semantic exclusions',()=>{
  const source=readFileSync(new URL('./operationalEnrichmentRecovery.ts',import.meta.url),'utf8');
  assert.match(source,/projectProviderDeferredEnrichment/);
  assert.match(source,/failed_job\.last_error ILIKE 'OPERATIONALLY_BLOCKED_RETRY_REQUIRED:%'/);
  assert.match(source,/c\.trading_status IS DISTINCT FROM 'NON_TRADING'/);
  assert.match(source,/c\.discord_validation_status IS DISTINCT FROM 'COMPLETED'/);
  assert.match(source,/LIMIT \$1/);
});


test('queue worker projects provider-owned enrichment failures distinctly from ordinary failures',()=>{
  const source=readFileSync(new URL('./queueManager.ts',import.meta.url),'utf8');
  assert.match(source,/isProviderDeferredEnrichmentError\(err\) \? 'PROVIDER_DEFERRED' : 'FAILED'/);
  assert.match(source,/await projectProviderDeferredEnrichment\(getDb, getChannelById, upsertChannel, 100\)/);
});
