import assert from 'node:assert/strict';
import test from 'node:test';
import { readYouTubeKeyCapSecondarySignals } from './youtubeKeyCapSecondarySignals';

test('secondary signals use the attempt ledger only and match structured/provider quota codes', async () => {
  let text = '';
  let values: unknown[] | undefined;
  const windowStart = new Date('2026-10-26T07:00:00.000Z');
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      text = sql;
      values = params;
      return { rows: [{ cap_unavailable: '4', quota_exhausted: '21' }] };
    },
  };

  const result = await readYouTubeKeyCapSecondarySignals(client, windowStart);
  assert.deepEqual(result, { capUnavailable: 4, quotaExhausted: 21 });
  assert.deepEqual(values, [windowStart]);
  assert.match(text, /FROM job_attempts/);
  assert.doesNotMatch(text, /FROM jobs\b/, 'jobs.last_error duplicates the attempt message');
  assert.match(text, /YOUTUBE_KEY_CAP_UNAVAILABLE/);
  assert.match(text, /QUOTA_ALLOCATION_EXHAUSTED/);
  assert.match(text, /YOUTUBE_QUOTA_EXCEEDED/);
  assert.match(text, /quotaExceeded/);
  assert.match(text, /dailyLimitExceeded/);
  assert.match(text, /COUNT\(\*\) FILTER/);
  assert.equal((text.match(/FROM job_attempts/g) || []).length, 1, 'one scan per sample');
  assert.match(text, /finished_at > \$1/);
  assert.match(text, /error IS NOT NULL/);
});

test('secondary signal reads normalize missing and non-numeric counts to zero', async () => {
  const client = {
    query: async () => ({ rows: [{ cap_unavailable: null, quota_exhausted: 'not-a-number' }] }),
  };
  assert.deepEqual(
    await readYouTubeKeyCapSecondarySignals(client, new Date('2026-10-26T07:00:00.000Z')),
    { capUnavailable: 0, quotaExhausted: 0 },
  );
  assert.deepEqual(
    await readYouTubeKeyCapSecondarySignals({ query: async () => ({ rows: [] }) }, new Date()),
    { capUnavailable: 0, quotaExhausted: 0 },
  );
});
