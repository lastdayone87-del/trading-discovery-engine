import test from 'node:test';
import assert from 'node:assert/strict';
import { YouTubeRequestScheduler } from './youtubeRequestScheduler';
import { isYouTubeRateLimited } from './youtube';
import fs from 'node:fs';

test('serializes concurrent outbound calls and spaces their starts', async () => {
  let now = 0;
  const starts: number[] = [];
  const scheduler = new YouTubeRequestScheduler({
    minIntervalMs: 100,
    initialRateLimitBackoffMs: 500,
    maxRateLimitBackoffMs: 2_000,
    now: () => now,
    sleep: async ms => { now += ms; }
  });
  await Promise.all([
    scheduler.run(async () => { starts.push(now); }),
    scheduler.run(async () => { starts.push(now); }),
    scheduler.run(async () => { starts.push(now); })
  ]);
  assert.deepEqual(starts, [0, 100, 200]);
});

test('applies shared exponential cooldown after provider rate limiting', async () => {
  let now = 0;
  const starts: number[] = [];
  const scheduler = new YouTubeRequestScheduler({
    minIntervalMs: 100,
    initialRateLimitBackoffMs: 500,
    maxRateLimitBackoffMs: 800,
    now: () => now,
    sleep: async ms => { now += ms; }
  });
  await scheduler.run(async () => { starts.push(now); });
  scheduler.rateLimited();
  await scheduler.run(async () => { starts.push(now); });
  scheduler.rateLimited();
  await scheduler.run(async () => { starts.push(now); });
  assert.deepEqual(starts, [0, 500, 1_300]);
});

test('distinguishes runtime rate limiting from project quota exhaustion through wrapped errors', () => {
  const rateLimit = Object.assign(new Error('YouTube HTTP 429 RESOURCE_EXHAUSTED (rateLimitExceeded)'), { status: 429, providerReasons: ['rateLimitExceeded'], quotaExceeded: false });
  assert.equal(isYouTubeRateLimited(Object.assign(new Error('Provider rate limit reached.'), { cause: rateLimit })), true);
  assert.equal(isYouTubeRateLimited(Object.assign(new Error('YouTube HTTP 403 (quotaExceeded)'), { status: 403, providerReasons: ['quotaExceeded'], quotaExceeded: true })), false);
});

test('youtubeFetch always bounds the scheduler head request', () => {
  const source = fs.readFileSync(new URL('./youtube.ts', import.meta.url), 'utf8');
  const youtubeFetch = source.slice(source.indexOf('async function youtubeFetch'), source.indexOf('/** Preserve both legacy'));
  assert.match(youtubeFetch, /timeout=Number\.isFinite\(configuredTimeout\)&&configuredTimeout>0\?configuredTimeout:30_000/);
  assert.match(youtubeFetch, /timeoutMs:timeout,enabled:true/);
  assert.doesNotMatch(youtubeFetch, /provider_deadlines_enabled|PROVIDER_DEADLINES_ENABLED/);
});
