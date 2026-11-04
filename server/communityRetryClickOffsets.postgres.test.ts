import test from 'node:test';
import assert from 'node:assert/strict';
import {
  enqueueJob,
  getDb,
} from './dbCore';
import {
  communityAcquisitionRetryKey,
  enqueueCommunityAcquisitionRetry,
  persistCommunityRetryClickOffsets,
} from './queueManager';
import type { CommunityRetryDirective } from './communityRetryPolicy';

const enabled = Boolean(process.env.DATABASE_URL);
const maybe = enabled ? test : test.skip;

maybe('concurrent retry writers merge disjoint and overlapping click offsets monotonically', async t => {
  const db = await getDb();
  const channelId = 'UCclickoffsetsconcurrent0001';
  const key = communityAcquisitionRetryKey(channelId);
  const cleanup = async () => {
    await db.query(`DELETE FROM jobs WHERE idempotency_key=$1`, [key]);
  };
  await cleanup();
  t.after(cleanup);

  await enqueueJob(
    'RETRY_COMMUNITY_ACQUISITION',
    { channelId, clickOffsets: { 'https://seed-a.test/': 2 } },
    { idempotencyKey: key, maxAttempts: 5 },
  );

  const directive = (offsets: Record<string, number>, reason: string): CommunityRetryDirective => ({
    attemptFree: false,
    code: 'COMMUNITY_ACQUISITION_REQUIRED',
    reason,
    retryReason: 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE',
    clickOffsets: offsets,
  });
  // Two workers write the same durable row without an application-level
  // lock. The SQL merge must keep the greater offset for every seed even when
  // the updates interleave, and must not lose either writer's new seeds.
  await Promise.all([
    enqueueCommunityAcquisitionRetry(channelId, directive({
      'https://seed-a.test/': 5,
      'https://seed-b.test/': 1,
    }, 'worker one'), 'INSPECTION'),
    enqueueCommunityAcquisitionRetry(channelId, directive({
      'https://seed-a.test/': 3,
      'https://seed-c.test/': 4,
    }, 'worker two'), 'RECOVERY'),
  ]);

  const row = await db.query(`SELECT payload FROM jobs WHERE idempotency_key=$1`, [key]);
  assert.deepEqual(row.rows[0].payload.clickOffsets, {
    'https://seed-a.test/': 5,
    'https://seed-b.test/': 1,
    'https://seed-c.test/': 4,
  });
});

maybe('partial retries and fresh scans merge per-seed click progress monotonically', async t => {
  const db = await getDb();
  const channelId = 'UCclickoffsetsmerge00000000001';
  const key = communityAcquisitionRetryKey(channelId);
  const cleanup = async () => {
    await db.query(`DELETE FROM jobs WHERE idempotency_key=$1`, [key]);
  };
  await cleanup();
  t.after(cleanup);

  const seeded = await enqueueJob(
    'RETRY_COMMUNITY_ACQUISITION',
    { channelId, clickOffsets: { 'https://seed-a.test/': 4, 'https://seed-b.test/': 2 } },
    { idempotencyKey: key, maxAttempts: 5 },
  );

  // A fresh scan starts without the retry payload's previous offsets, so it
  // can report seed A's first-page progress (1) while the active retry already
  // advanced to 4. Enqueueing that scan must not rewind A, while seed B's
  // genuinely higher progress (3) still advances.
  const directive: CommunityRetryDirective = {
    attemptFree: false,
    code: 'COMMUNITY_ACQUISITION_REQUIRED',
    reason: 'fresh scan while retry is active',
    retryReason: 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE',
    clickOffsets: { 'https://seed-a.test/': 1, 'https://seed-b.test/': 3 },
  };
  await enqueueCommunityAcquisitionRetry(channelId, directive, 'INSPECTION');
  let row = await db.query(`SELECT payload FROM jobs WHERE id=$1`, [seeded.id]);
  assert.equal(row.rows[0].payload.retryCode, 'COMMUNITY_ACQUISITION_REQUIRED', 'the click-offset branch still merges the incoming retry code');
  assert.equal(row.rows[0].payload.retryReason, 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE');
  assert.deepEqual(row.rows[0].payload.clickOffsets, {
    'https://seed-a.test/': 4,
    'https://seed-b.test/': 3,
  });

  // Retry-execution progress is also append-only: a partial next-offset map
  // from the current attempt may not erase seeds it never touched.
  await db.query(`UPDATE jobs SET status='PROCESSING' WHERE id=$1`, [seeded.id]);
  await persistCommunityRetryClickOffsets(seeded.id, { 'https://seed-c.test/': 1 });
  row = await db.query(`SELECT payload FROM jobs WHERE id=$1`, [seeded.id]);
  assert.deepEqual(row.rows[0].payload.clickOffsets, {
    'https://seed-a.test/': 4,
    'https://seed-b.test/': 3,
    'https://seed-c.test/': 1,
  });
});
