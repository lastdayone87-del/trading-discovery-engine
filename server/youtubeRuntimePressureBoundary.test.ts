import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { YouTubeRequestScheduler } from './youtubeRequestScheduler';

function runtime429(providerKey = 'provider-a'): Error {
  return Object.assign(new Error('Provider rate limit reached.'), {
    errorClass: 'RATE_LIMIT',
    retryable: true,
    status: 429,
    quotaExceeded: false,
    providerReasons: ['rateLimitExceeded', 'RATE_LIMIT_EXCEEDED'],
    providerKey
  });
}

test('first raw runtime 429 immediately re-dispatches the same logical request without adaptive sleep', async () => {
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
    maxRuntimeRateLimitRetries: 4,
    now: () => now,
    sleep: async ms => { sleeps.push(ms); now += ms; }
  });

  const result = await scheduler.run(async () => {
    attempts += 1;
    if (attempts === 1) throw runtime429('provider-a');
    return 'ok';
  }, stage => traces.push(stage), 'autonomous');

  assert.equal(result, 'ok');
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, []);
  assert.ok(traces.includes('runtime-rate-limit-provider-failover 1/4'));
  assert.equal(traces.some(stage => stage.startsWith('runtime-rate-limit-retry ')), false);
  assert.equal(traces.some(stage => stage.startsWith('adaptive-rate-pressure ')), false);
  assert.equal(scheduler.getRatePressureSnapshot().adaptiveIntervalMs, 250);
});

test('bounded provider failovers surface retryable runtime pressure without minute-scale waits', async () => {
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
      throw runtime429(`provider-${attempts}`);
    }, stage => traces.push(stage), 'autonomous');
  } catch (error) {
    rejected = error;
  }

  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, []);
  assert.equal(rejected?.code, 'YOUTUBE_RUNTIME_RATE_PRESSURE');
  assert.equal(rejected?.retryable, true);
  assert.ok(traces.includes('runtime-rate-limit-provider-failover 1/2'));
  assert.ok(traces.includes('runtime-rate-limit-provider-failover 2/2'));
  assert.ok(traces.includes('runtime-rate-limit-failover-exhausted 2/2'));
  assert.equal(traces.some(stage => stage.includes('wait 30000ms')), false);
});

test('runtime 429 is provider-cooled inside youtubeFetch so scheduler re-dispatch can select a healthy key', () => {
  const source = fs.readFileSync(new URL('./youtube.ts', import.meta.url), 'utf8');
  const youtubeFetch = source.slice(source.indexOf('async function youtubeFetch'), source.indexOf('export type YouTubeAdditionalQuotaCallback'));
  assert.match(youtubeFetch, /const runtimeRateLimited=isYouTubeRateLimited\(error\)/);
  assert.match(youtubeFetch, /else if\(runtimeRateLimited\)youtubeProviderCooldown\.failed\(dispatchedProviderKey,'RATE_LIMITED'\)/);
  assert.match(youtubeFetch, /selectYouTubeDispatchProviderIndex\(livePool,providerKey,key=>youtubeProviderCooldown\.eligible\(key\)/);
});

test('production raw 429 path no longer contains adaptive 30-second retry waits', () => {
  const source = fs.readFileSync(new URL('./youtubeRequestScheduler.ts', import.meta.url), 'utf8');
  const rateLimitRecorder = source.slice(source.indexOf('private noteRuntimeRateLimit'), source.indexOf('private noteSuccessfulCall'));
  const selectedRequest = source.slice(source.indexOf('private async runSelectedRequest'), source.indexOf('private async processQueue'));
  assert.doesNotMatch(rateLimitRecorder, /adaptive-rate-pressure/);
  assert.doesNotMatch(selectedRequest, /runtime-rate-limit-retry /);
  assert.doesNotMatch(selectedRequest, /await this\.wait\(waitMs\);[\s\S]*runtime-rate-limit-provider-failover/);
  assert.match(selectedRequest, /runtime-rate-limit-provider-failover/);
  assert.match(selectedRequest, /shared-runtime-cooling-wait/);
});
