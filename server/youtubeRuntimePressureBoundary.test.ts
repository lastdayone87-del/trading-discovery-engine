import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { YouTubeRequestScheduler } from './youtubeRequestScheduler';

function runtime429(): Error {
  return Object.assign(new Error('Provider rate limit reached.'), {
    errorClass: 'RATE_LIMIT',
    retryable: true,
    status: 429,
    quotaExceeded: false,
    providerReasons: ['rateLimitExceeded', 'RATE_LIMIT_EXCEEDED'],
    providerKey: 'provider-a'
  });
}

test('production-style scheduler absorbs raw runtime 429s and retries the same logical request with adaptive spacing', async () => {
  let now = 0;
  let attempts = 0;
  const sleeps: number[] = [];
  const traces: string[] = [];
  const scheduler = new YouTubeRequestScheduler({
    minIntervalMs: 250,
    initialRateLimitBackoffMs: 5_000,
    maxRateLimitBackoffMs: 300_000,
    runtimeRateLimitFloorMs: 1_000,
    maxAdaptiveIntervalMs: 8_000,
    maxRuntimeRateLimitRetries: 3,
    now: () => now,
    sleep: async ms => { sleeps.push(ms); now += ms; }
  });

  const result = await scheduler.run(async () => {
    attempts += 1;
    if (attempts <= 3) throw runtime429();
    return 'ok';
  }, stage => traces.push(stage), 'autonomous');

  assert.equal(result, 'ok');
  assert.equal(attempts, 4);
  assert.deepEqual(sleeps, [1_000, 2_000, 4_000]);
  assert.ok(traces.includes('runtime-rate-limit-retry 1/3 wait 1000ms'));
  assert.ok(traces.includes('runtime-rate-limit-retry 2/3 wait 2000ms'));
  assert.ok(traces.includes('runtime-rate-limit-retry 3/3 wait 4000ms'));
});

test('bounded runtime retries surface one retryable pressure result instead of retrying forever', async () => {
  let now = 0;
  let attempts = 0;
  const sleeps: number[] = [];
  const traces: string[] = [];
  const scheduler = new YouTubeRequestScheduler({
    minIntervalMs: 250,
    initialRateLimitBackoffMs: 5_000,
    maxRateLimitBackoffMs: 300_000,
    runtimeRateLimitFloorMs: 1_000,
    maxAdaptiveIntervalMs: 30_000,
    maxRuntimeRateLimitRetries: 2,
    now: () => now,
    sleep: async ms => { sleeps.push(ms); now += ms; }
  });

  let rejected: any;
  try {
    await scheduler.run(async () => {
      attempts += 1;
      throw runtime429();
    }, stage => traces.push(stage), 'autonomous');
  } catch (error) {
    rejected = error;
  }

  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [1_000, 2_000]);
  assert.equal(rejected?.code, 'YOUTUBE_RUNTIME_RATE_PRESSURE');
  assert.equal(rejected?.retryable, true);
  assert.ok(traces.includes('runtime-rate-limit-retry-exhausted 2/2'));
});

test('runtime 429 is not retained as a failed dispatch provider and aborts outer key-pool failover after scheduler exhaustion', () => {
  const source = fs.readFileSync(new URL('./youtube.ts', import.meta.url), 'utf8');
  const recorder = source.slice(source.indexOf('function recordProviderFailure'), source.indexOf('export function selectYouTubeDispatchProviderIndex'));
  assert.match(recorder, /if \(isYouTubeRateLimited\(error\)\) \{[\s\S]*throw error;/);

  const youtubeFetch = source.slice(source.indexOf('async function youtubeFetch'), source.indexOf('export type YouTubeAdditionalQuotaCallback'));
  assert.match(youtubeFetch, /const runtimeRateLimited=isYouTubeRateLimited\(error\)/);
  assert.match(youtubeFetch, /if\(!runtimeRateLimited\)failedDispatchProviders\(acquisition\)\?\.add\(dispatchedProviderKey\)/);
});

test('production runtime pressure can exceed the old five-second adaptive ceiling but remains bounded and configurable', () => {
  const source = fs.readFileSync(new URL('./youtubeRequestScheduler.ts', import.meta.url), 'utf8');
  assert.match(source, /YOUTUBE_MAX_ADAPTIVE_REQUEST_INTERVAL_MS, 30_000/);
  assert.match(source, /YOUTUBE_RUNTIME_RATE_LIMIT_RETRIES, 4/);
});
