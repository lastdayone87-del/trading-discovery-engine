import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { communityAcquisitionRetryKey, enqueueCommunityAcquisitionRetry, persistCommunityRetryClickOffsets } from './queueManager';
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
  return {
    queries,
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      if (sql.includes('INSERT INTO jobs')) return { rows: [jobRow], rowCount: 1 };
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
  assert.equal(inserts.length, 2);
  for (const insert of inserts) {
    assert.equal(insert.values?.[3], 5, 'bounded maxAttempts stays 5');
    assert.equal(insert.values?.[5], communityAcquisitionRetryKey('UC_IDEMPOTENT'), 'same per-channel idempotency key');
    const payload = JSON.parse(String(insert.values?.[1]));
    assert.equal(payload.retryLifecycleVersion, 2);
    assert.equal(payload.retryReason, 'BROWSER_RUNTIME_UNAVAILABLE');
  }
  assert.equal(communityAcquisitionRetryKey('UC_IDEMPOTENT'), 'community-acquisition-retry:UC_IDEMPOTENT');
});

test('community retry enqueue merges per-seed click progress monotonically against the current row', async () => {
  const client = mockClient();
  await enqueueCommunityAcquisitionRetry('UC_CLICK', {
    ...saturationDirective,
    clickOffsets: { 'https://creator.test': 4 },
  }, 'INSPECTION', client as any);
  const insert = client.queries.find(q => q.sql.includes('INSERT INTO jobs'));
  const payload = JSON.parse(String(insert?.values?.[1]));
  assert.deepEqual(payload.clickOffsets, { 'https://creator.test': 4 });
  const merge = client.queries.find(q => q.sql.includes('UPDATE jobs SET payload=CASE'));
  assert.ok(merge, 'enqueue merges into the pending durable payload');
  assert.match(merge.sql, /jsonb_typeof\(\$2::jsonb->'clickOffsets'\)='object'/, 'only a real offset map triggers the nested merge');
  assert.match(merge.sql, /\(payload \|\| \(\$2::jsonb - 'clickOffsets'\)\)/, 'the rest of the incoming retry metadata still merges');
  assert.match(merge.sql, /jsonb_object_keys\(/, 'the merge reads the current database map, not enqueueJob\'s earlier copy');
  assert.match(merge.sql, /GREATEST\(/, 'a lower offset from a fresh scan cannot rewind stored retry progress');
  assert.match(merge.sql, /#>> '\{\}'/, 'only numeric stored/incoming offsets participate in the maximum');
  assert.deepEqual(JSON.parse(String(merge?.values?.[1])).clickOffsets, { 'https://creator.test': 4 }, 'the statement carries only this enqueue\'s offsets; other seeds are preserved by the SQL merge');
  assert.equal(JSON.parse(String(merge?.values?.[1])).retryCode, 'BROWSER_RUNTIME_UNAVAILABLE', 'retry reason/code metadata is not dropped by the offset branch');
});

test('community retry enqueue without offsets leaves the durable offset map untouched', async () => {
  const client = mockClient();
  await enqueueCommunityAcquisitionRetry('UC_NO_CLICK_MAP', saturationDirective, 'INSPECTION', client as any);
  const merge = client.queries.find(q => q.sql.includes('UPDATE jobs SET payload=CASE'));
  assert.ok(merge);
  assert.equal(JSON.parse(String(merge?.values?.[1])).clickOffsets, undefined);
  assert.match(merge.sql, /ELSE payload \|\| \$2::jsonb END/);
});

test('a partial retry-progress write preserves other seeds', async () => {
  const client = mockClient();
  await persistCommunityRetryClickOffsets('job-community-1', { 'https://seed-b.test': 2 }, client as any);
  const update = client.queries.find(q => q.sql.includes("UPDATE jobs SET payload=(payload - 'clickOffsets')"));
  assert.ok(update);
  assert.match(update.sql, /COALESCE\(payload->'clickOffsets','\{\}'::jsonb\) \|\| \$2::jsonb/);
  assert.deepEqual(update.values, ['job-community-1', JSON.stringify({ 'https://seed-b.test': 2 })]);
});

test('saturation deferrals are counted at the durable community enqueue point', async () => {  resetOperationsTelemetry();
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
