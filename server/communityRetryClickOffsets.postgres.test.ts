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

maybe('partial retry enqueues and progress writes deep-merge per-seed click offsets', async t => {
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

  // A manual/partial retry re-inspected only seed B. Enqueueing its directive
  // must advance B while preserving A's durable offset.
  const directive: CommunityRetryDirective = {
    attemptFree: false,
    code: 'COMMUNITY_ACQUISITION_REQUIRED',
    reason: 'partial manual retry',
    retryReason: 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE',
    clickOffsets: { 'https://seed-b.test/': 3 },
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
