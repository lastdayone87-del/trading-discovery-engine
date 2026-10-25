import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dbCore = readFileSync(new URL('./dbCore.ts', import.meta.url), 'utf8');

test('queue status reads are served from the brief cache', () => {
  assert.match(dbCore, /export const QUEUE_STATUS_CACHE_TTL_MS = 1_000;/);
  assert.match(dbCore, /const queueStatusCache = createBriefCache\(loadQueueStatus, QUEUE_STATUS_CACHE_TTL_MS\);/);
  assert.match(dbCore, /export async function getQueueStatus\(\): Promise<QueueStatus> \{\s*return queueStatusCache\.get\(\);\s*\}/);
});

test('queue pause mutation invalidates the cache only after the write commits', () => {
  const start = dbCore.indexOf('export async function toggleQueuePause');
  assert.ok(start >= 0, 'toggleQueuePause must exist');
  const body = dbCore.slice(start, dbCore.indexOf('\n}', start) + 2);
  const writeAt = body.indexOf('await db.query(');
  const invalidateAt = body.indexOf('invalidateQueueStatusCache()');
  assert.ok(writeAt >= 0, 'the pause mutation must write the control row');
  assert.ok(invalidateAt > writeAt, 'invalidation must follow the committed write');
});
