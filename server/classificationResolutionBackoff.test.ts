import assert from 'node:assert/strict';
import test from 'node:test';
import {
  reconcileClassificationResolutionGaps,
  recordClassificationResolutionBackoff,
} from './classificationResolutionRecovery';

const CUTOFF = '1970-01-01T00:00:00.000Z';

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    channel_id: 'UC1',
    channel_name: 'Creator',
    trading_status: 'UNCERTAIN',
    scan_status: 'FAILED',
    last_checked: '2026-01-01T00:00:00.000Z',
    latest_job_id: 'job-1',
    latest_job_status: 'FAILED',
    terminal_failure_class: 'RETRYABLE',
    latest_job_attempts: 1,
    latest_job_updated_at: '2026-01-01T00:00:00.000Z',
    channel_created_at: '2025-01-01T00:00:00.000Z',
    recovery_cycles: 3,
    last_recovery_at: null,
    terminal_recovery_marker: false,
    recovery_cooldown_active: false,
    ...overrides,
  };
}

function fakeDb(rows: Array<Record<string, unknown>>) {
  const inserts: unknown[][] = [];
  const client = {
    query: async () => ({ rows: [], rowCount: 0 }),
    release: () => undefined,
  };
  return {
    inserts,
    db: {
      query: async (sql: string, params: unknown[]) => {
        if (sql.includes('FROM channels c')) return { rows, rowCount: rows.length };
        if (sql.includes('INSERT INTO operational_enrichment_recovery_events')) {
          inserts.push(params);
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      connect: async () => client,
    },
  };
}

test('a non-materialized exhausted review writes a short-lived backoff event', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rowCount: 1, rows: [] };
    },
  };
  await recordClassificationResolutionBackoff(
    db,
    { channelId: 'UC1', latestJobId: 'job-1', scanStatus: 'FAILED' },
    ['EXHAUSTED_REVIEW_NOT_MATERIALIZED', 'CURRENT_PENDING_REVIEW_PRESERVED'],
  );
  assert.equal(calls.length, 1);
  const params = calls[0].params;
  assert.match(String(params[0]), /^classification-resolution-failure:UC1:/);
  assert.equal(params[1], 'UC1');
  assert.equal(params[2], 'job-1');
  assert.equal(params[3], 'FAILED');
  assert.deepEqual(JSON.parse(String(params[4])), [
    'EXHAUSTED_REVIEW_NOT_MATERIALIZED',
    'CURRENT_PENDING_REVIEW_PRESERVED',
  ]);
});

test('the exhausted-review branch backs off a non-materialized review', async () => {
  const { db, inserts } = fakeDb([candidate()]);
  const result = await reconcileClassificationResolutionGaps({
    dryRun: false,
    includeLegacy: true,
    cutoff: CUTOFF,
    limit: 1,
    db,
    materializeExhaustedReview: async () => ({
      materialized: false,
      reason: 'CURRENT_PENDING_REVIEW_PRESERVED',
      eligibilityDecisionId: 'decision-1',
    }),
    enqueueOperationalEnrichmentRecoveryJob: async () => false,
    channelRowToRecord: async () => null,
  } as any);

  assert.equal(result.exhaustedReviews, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.failures, 0);
  assert.equal(inserts.length, 1);
  assert.match(String(inserts[0][0]), /^classification-resolution-failure:UC1:/);
  assert.deepEqual(JSON.parse(String(inserts[0][4])), [
    'EXHAUSTED_REVIEW_NOT_MATERIALIZED',
    'CURRENT_PENDING_REVIEW_PRESERVED',
  ]);
});

test('the enqueue-blocked branch backs off a non-materialized review', async () => {
  const { db, inserts } = fakeDb([
    candidate({
      channel_id: 'UC2',
      scan_status: 'ENRICHMENT_PENDING',
      latest_job_id: null,
      latest_job_status: null,
      terminal_failure_class: null,
      latest_job_attempts: 0,
      latest_job_updated_at: null,
      recovery_cycles: 0,
    }),
  ]);
  const result = await reconcileClassificationResolutionGaps({
    dryRun: false,
    includeLegacy: true,
    cutoff: CUTOFF,
    limit: 1,
    db,
    materializeExhaustedReview: async () => ({
      materialized: false,
      reason: 'STALE_ELIGIBILITY_PROJECTION',
      eligibilityDecisionId: 'decision-2',
    }),
    enqueueOperationalEnrichmentRecoveryJob: async () => false,
    channelRowToRecord: async () => ({ channel_id: 'UC2' }) as any,
  } as any);

  assert.equal(result.exhaustedReviews, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.failures, 0);
  assert.equal(inserts.length, 1);
  assert.match(String(inserts[0][0]), /^classification-resolution-failure:UC2:/);
  assert.deepEqual(JSON.parse(String(inserts[0][4])), [
    'EXHAUSTED_REVIEW_NOT_MATERIALIZED',
    'STALE_ELIGIBILITY_PROJECTION',
  ]);
});
