import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { decideJobFailure } from './db';
import {
  OPERATIONAL_ENRICHMENT_MAX_RECOVERY_CYCLES,
  operationalEnrichmentCycleEventKey,
  operationalEnrichmentTerminalEventKey,
  reconcileOperationalEnrichmentRecovery,
} from './operationalEnrichmentRecovery';
import { operationsTelemetrySnapshot, resetOperationsTelemetry } from './operationsTelemetry';

const T0 = Date.parse('2026-09-02T00:00:00.000Z');

const channelBase = (overrides: Record<string, unknown> = {}) => ({
  channel_id: 'channel-1',
  channel_name: 'Recovery Channel',
  youtube_url: 'https://youtube.com/channel/UC_RECOVERY',
  country: 'Germany',
  subscriber_count: 5000,
  scan_status: 'PROVIDER_DEFERRED' as const,
  trading_status: 'UNCERTAIN' as const,
  country_status: 'UNCERTAIN' as const,
  discord_validation_status: 'NOT_STARTED' as const,
  last_checked: '2026-08-30T00:00:00.000Z',
  inspection_trail: [],
  ...overrides,
});

function mockDb(rows: Array<Record<string, unknown>>, options: { eventInserts?: number[] } = {}) {
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  let insertIndex = 0;
  const db = {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      if (sql.includes('SELECT c.channel_id')) return { rows, rowCount: rows.length };
      if (sql.includes('INSERT INTO operational_enrichment_recovery_events')) {
        const rowCount = options.eventInserts ? options.eventInserts[insertIndex++] ?? 1 : 1;
        return { rows: [], rowCount };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  return { db, queries };
}

test('bounded provider-cooling terminals carry the operational-blocked marker (root-cause firing condition)', () => {
  const now = 1_700_000_000_000;
  // Before the fix this returned {disposition:'FAILED'} without the marker, so
  // the persisted last_error never matched the recovery gate's
  // OPERATIONALLY_BLOCKED_RETRY_REQUIRED:% predicate.
  assert.deepEqual(
    decideJobFailure({ code: 'YOUTUBE_PROVIDERS_COOLING_DOWN', retryAt: now + 60_000 }, 4, 4, now),
    { disposition: 'FAILED', operationallyBlocked: true },
  );
  assert.deepEqual(
    decideJobFailure({ code: 'YOUTUBE_PROVIDER_POOL_EXHAUSTED', retryAt: now + 60_000 }, 4, 4, now),
    { disposition: 'FAILED', operationallyBlocked: true },
  );
});

test('recovery predicate admits historical raw provider-cooling terminal messages and is cycle-bounded', () => {
  const source = readFileSync(new URL('./operationalEnrichmentRecovery.ts', import.meta.url), 'utf8');
  assert.match(source, /latest_job\.last_error ILIKE 'OPERATIONALLY_BLOCKED_RETRY_REQUIRED:%'/);
  assert.match(source, /latest_job\.last_error ILIKE 'Every configured YouTube provider is cooling down%'/);
  assert.match(source, /OPERATIONAL_ENRICHMENT_MAX_RECOVERY_CYCLES = 3/);
  assert.match(source, /cycle_event\.event_key LIKE 'operational-enrichment:%'/);
  assert.match(source, /terminal_event\.event_key LIKE 'operational-enrichment-terminal:%'/);
});

test('a first recovery cycle reactivates, enqueues once, and records a per-job/attempt/cycle event', async () => {
  resetOperationsTelemetry();
  const { db, queries } = mockDb([
    { channel_id: 'channel-1', failed_job_id: 'job-9', failed_job_attempts: 4, recovery_cycles: 0 },
  ]);
  const upserts: any[] = [];
  const enqueued: string[] = [];
  const reconciled = await reconcileOperationalEnrichmentRecovery(
    async () => db,
    async id => (id === 'channel-1' ? (channelBase() as any) : null),
    async updated => { upserts.push(updated); },
    async (channel) => { enqueued.push(channel.channel_id); },
    20,
    T0,
  );
  assert.equal(reconciled, 1);
  assert.deepEqual(enqueued, ['channel-1']);
  assert.equal(upserts[0].scan_status, 'ENRICHMENT_PENDING');
  assert.equal(upserts[0].trading_status, 'UNCERTAIN');
  const insert = queries.find(q => q.sql.includes('INSERT INTO operational_enrichment_recovery_events'));
  assert.ok(insert, 'the durable recovery ledger must be written at runtime');
  assert.equal(insert?.values?.[0], operationalEnrichmentCycleEventKey('channel-1', 'job-9', 4, 1));
  assert.match(insert!.sql, /ON CONFLICT\(event_key\) DO NOTHING/);
  const snapshot = operationsTelemetrySnapshot();
  assert.equal(snapshot.operationalEnrichmentRecoveryEnqueuedTotal, 1);
  assert.equal(snapshot.operationalEnrichmentRecoveryExhaustedTotal, 0);
});

test('recovery does not fire while the durable cooldown is active', async () => {
  resetOperationsTelemetry();
  const now = T0 + 120_000;
  const { db } = mockDb([
    { channel_id: 'channel-1', failed_job_id: 'job-9', failed_job_attempts: 4, recovery_cycles: 0 },
  ]);
  const upserts: any[] = [];
  const enqueued: string[] = [];
  const reconciled = await reconcileOperationalEnrichmentRecovery(
    async () => db,
    async () => (channelBase({ last_checked: new Date(now - 60 * 60_000).toISOString() }) as any),
    async updated => { upserts.push(updated); },
    async (channel) => { enqueued.push(channel.channel_id); },
    20,
    now,
  );
  assert.equal(reconciled, 0);
  assert.equal(upserts.length, 0);
  assert.equal(enqueued.length, 0);
});

test('a colliding cycle event is a counted idempotent duplicate, never a second cycle', async () => {
  resetOperationsTelemetry();
  const now = T0 + 240_000;
  const { db, queries } = mockDb(
    [{ channel_id: 'channel-1', failed_job_id: 'job-9', failed_job_attempts: 4, recovery_cycles: 0 }],
    { eventInserts: [0, 0] },
  );
  const enqueued: string[] = [];
  // Model the durable queue's per-channel idempotency key: the second replay
  // may call enqueue again, but it must not create a second job.
  const durableJobs = new Set<string>();
  const reconcile = (at: number) => reconcileOperationalEnrichmentRecovery(
    async () => db,
    async () => (channelBase() as any),
    async () => undefined,
    async (channel) => {
      if (!durableJobs.has(channel.channel_id)) {
        durableJobs.add(channel.channel_id);
        enqueued.push(channel.channel_id);
      }
    },
    20,
    at,
  );
  assert.equal(await reconcile(now), 1);
  assert.equal(await reconcile(now + 120_000), 1);
  assert.deepEqual(enqueued, ['channel-1'], 'replay must not create a second durable job');
  assert.ok(queries.some(q => q.sql.includes('INSERT INTO operational_enrichment_recovery_events')));
  const snapshot = operationsTelemetrySnapshot();
  assert.equal(snapshot.operationalEnrichmentRecoveryDuplicateEventsTotal, 2);
  assert.equal(snapshot.operationalEnrichmentRecoveryEnqueuedTotal, 0);
});

test('the recovery ceiling writes one terminal marker and never re-enqueues', async () => {
  resetOperationsTelemetry();
  const now = T0 + 480_000;
  const { db, queries } = mockDb(
    [{
      channel_id: 'channel-1',
      failed_job_id: 'job-9',
      failed_job_attempts: 4,
      recovery_cycles: OPERATIONAL_ENRICHMENT_MAX_RECOVERY_CYCLES,
    }],
    { eventInserts: [1, 0] },
  );
  const upserts: any[] = [];
  const enqueued: string[] = [];
  const reconcile = (at: number) => reconcileOperationalEnrichmentRecovery(
    async () => db,
    async () => (channelBase() as any),
    async updated => { upserts.push(updated); },
    async (channel) => { enqueued.push(channel.channel_id); },
    20,
    at,
  );
  assert.equal(await reconcile(now), 0);
  assert.equal(upserts.length, 0, 'an exhausted channel must not be reactivated');
  assert.equal(enqueued.length, 0, 'an exhausted channel must not be re-enqueued');
  const terminalInsert = queries.find(q => q.values?.[0] === operationalEnrichmentTerminalEventKey('channel-1'));
  assert.ok(terminalInsert, 'the terminal marker is the durable stop condition');
  assert.match(String(terminalInsert?.values?.[4]), /OPERATIONAL_RECOVERY_ATTEMPTS_EXHAUSTED/);
  // Replaying the same reconciliation must not double-count or re-enqueue: the
  // marker insert collides (rowCount 0) and the counter stays at one.
  assert.equal(await reconcile(now + 120_000), 0);
  const snapshot = operationsTelemetrySnapshot();
  assert.equal(snapshot.operationalEnrichmentRecoveryExhaustedTotal, 1);
  assert.equal(snapshot.operationalEnrichmentRecoveryEnqueuedTotal, 0);
});

test('reconciliation is a no-op inside the throttle window and without qualifying rows', async () => {
  resetOperationsTelemetry();
  const now = T0 + 720_000;
  const { db } = mockDb([]);
  let getDbCalls = 0;
  const getDb = async () => { getDbCalls++; return db; };
  const reconciled = await reconcileOperationalEnrichmentRecovery(getDb, async () => null, async () => undefined, async () => undefined, 20, now);
  assert.equal(reconciled, 0);
  const throttled = await reconcileOperationalEnrichmentRecovery(getDb, async () => null, async () => undefined, async () => undefined, 20, now + 30_000);
  assert.equal(throttled, 0);
  assert.equal(getDbCalls, 1, 'a call inside the 60s throttle must not touch the database');
});
