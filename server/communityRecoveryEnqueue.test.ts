import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { communityAcquisitionRetryKey, enqueueCommunityAcquisitionRetry } from './queueManager';
import { operationsTelemetrySnapshot, resetOperationsTelemetry } from './operationsTelemetry';

const jobRow = {
  id: 'job-community-1',
  type: 'RETRY_COMMUNITY_ACQUISITION',
  status: 'PENDING',
  payload: '{}',
  attempts: 0,
  max_attempts: 5,
  run_after: '2026-09-01T00:00:00.000Z',
  locked_by: null,
  locked_at: null,
  last_error: null,
  created_at: '2026-09-01T00:00:00.000Z',
};

function mockClient() {
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  const jobs = new Set<string>();
  return {
    queries,
    get durableJobs() {
      return jobs.size;
    },
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      if (sql.includes('INSERT INTO jobs')) {
        const key = String(values?.[5] ?? '');
        const created = !jobs.has(key);
        jobs.add(key);
        // enqueueJob uses ON CONFLICT ... RETURNING *, so the existing row is
        // returned too; the durable-job count is what stays at one.
        return { rows: [jobRow], rowCount: 1, created };
      }
      return { rows: [], rowCount: 1 };
    },
  };
}

const saturationDirective = {
  attemptFree: true as const,
  code: 'BROWSER_RUNTIME_UNAVAILABLE',
  reason: 'RENDERED_FALLBACK_SATURATED',
  retryReason: 'BROWSER_RUNTIME_UNAVAILABLE' as const,
};

test('community retry enqueue is idempotent per channel and keeps the bounded attempt ceiling', async () => {
  const client = mockClient();
  await enqueueCommunityAcquisitionRetry('UC_IDEMPOTENT', saturationDirective, 'RECOVERY', client as any);
  await enqueueCommunityAcquisitionRetry('UC_IDEMPOTENT', saturationDirective, 'RECOVERY', client as any);
  const inserts = client.queries.filter(q => q.sql.includes('INSERT INTO jobs'));
  assert.equal(inserts.length, 2, 'both requests may attempt the idempotent upsert');
  assert.equal(client.durableJobs, 1, 'only one durable job may exist for the channel key');
  for (const insert of inserts) {
    assert.equal(insert.values?.[3], 5, 'bounded maxAttempts stays 5');
    assert.equal(insert.values?.[5], communityAcquisitionRetryKey('UC_IDEMPOTENT'), 'same per-channel idempotency key');
    const payload = JSON.parse(String(insert.values?.[1]));
    assert.equal(payload.retryLifecycleVersion, 2);
    assert.equal(payload.retryReason, 'BROWSER_RUNTIME_UNAVAILABLE');
  }
  assert.equal(communityAcquisitionRetryKey('UC_IDEMPOTENT'), 'community-acquisition-retry:UC_IDEMPOTENT');
});

test('saturation deferrals are counted at the durable community enqueue point', async () => {
  resetOperationsTelemetry();
  const client = mockClient();
  await enqueueCommunityAcquisitionRetry('UC_SAT', saturationDirective, 'INSPECTION', client as any);
  const snapshot = operationsTelemetrySnapshot();
  assert.equal(snapshot.communitySaturationDeferralsTotal, 1);

  // A non-saturation retry reason must never inflate the metric.
  const otherClient = mockClient();
  await enqueueCommunityAcquisitionRetry(
    'UC_OTHER',
    { attemptFree: true, code: 'COMMUNITY_ACQUISITION_CAPACITY_UNAVAILABLE', reason: 'TRANSIENT_ACQUISITION_FAILURE', retryReason: 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE' },
    'INSPECTION',
    otherClient as any,
  );
  assert.equal(operationsTelemetrySnapshot().communitySaturationDeferralsTotal, 1);
});

test('retry worker counts saturation on the attempt-free deferral branch', () => {
  const queue = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
  assert.match(queue, /includes\('RENDERED_FALLBACK_SATURATED'\)\)bumpCommunitySaturationDeferral\(\)/);
  assert.match(queue, /directive\.retryReason===COMMUNITY_RETRY_REASON\.BROWSER_RUNTIME_UNAVAILABLE/);
});
