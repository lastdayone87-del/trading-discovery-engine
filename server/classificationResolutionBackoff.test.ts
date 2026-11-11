import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { recordClassificationResolutionBackoff } from './classificationResolutionRecovery';

const source = readFileSync(new URL('./classificationResolutionRecovery.ts', import.meta.url), 'utf8');

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

test('non-materialized exhausted reviews leave the head of the next recovery sweep', () => {
  assert.equal((source.match(/EXHAUSTED_REVIEW_NOT_MATERIALIZED/g) || []).length, 2);
  assert.match(source, /if \(review\.materialized\) exhaustedReviews \+= 1;\s*else \{\s*skipped \+= 1;\s*await recordClassificationResolutionBackoff/);

  const candidateStart = source.indexOf('const result = await db.query(');
  const candidateEnd = source.indexOf('const items:', candidateStart);
  const candidate = source.slice(candidateStart, candidateEnd);
  assert.ok(candidate.includes("recent_failure.event_key LIKE '${FAILURE_PREFIX}%'"));
  assert.ok(candidate.includes("recent_failure.created_at>=now()-interval '15 minutes'"));
  assert.ok(candidate.indexOf('recent_failure.event_key') < candidate.indexOf('ORDER BY recovery_cooldown_active'));
  assert.ok(candidate.indexOf('recent_failure.created_at') < candidate.indexOf('LIMIT $4'));
});
