import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

test('youtubeFetch feeds provider 429 outcomes back into the shared request scheduler', () => {
  const source = readFileSync(new URL('./youtube.ts', import.meta.url), 'utf8');
  const youtubeFetch = source.slice(
    source.indexOf('async function youtubeFetch'),
    source.indexOf('/** Preserve both legacy')
  );

  assert.match(youtubeFetch, /youtubeRequestScheduler\.succeeded\(\)/);
  assert.match(youtubeFetch, /isYouTubeRateLimited\(error\)/);
  assert.match(youtubeFetch, /youtubeRequestScheduler\.rateLimited\(\)/);
});

test('YouTube scheduler keeps a process-wide exponential rate-limit backoff', () => {
  const source = readFileSync(new URL('./youtubeRequestScheduler.ts', import.meta.url), 'utf8');
  assert.match(source, /initialRateLimitBackoffMs/);
  assert.match(source, /maxRateLimitBackoffMs/);
  assert.match(source, /this\.rateLimitBackoffMs \* 2/);
  assert.match(source, /this\.nextStartAt = Math\.max/);
});
