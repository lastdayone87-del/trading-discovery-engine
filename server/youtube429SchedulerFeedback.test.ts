import assert from 'node:assert/strict';
import test from 'node:test';
import { YouTubeRequestScheduler } from './youtubeRequestScheduler';

function schedulerClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => { now += ms; },
    value: () => now,
  };
}

test('a provider 429 does not globally delay the next healthy provider attempt', async () => {
  const clock = schedulerClock();
  const starts: number[] = [];
  const scheduler = new YouTubeRequestScheduler({
    minIntervalMs: 100,
    initialRateLimitBackoffMs: 500,
    maxRateLimitBackoffMs: 2_000,
    now: clock.now,
    sleep: clock.sleep,
  });
  const rateLimit = Object.assign(new Error('YouTube HTTP 429 RESOURCE_EXHAUSTED (rateLimitExceeded)'), {
    status: 429,
    quotaExceeded: false,
    providerReasons: ['rateLimitExceeded'],
  });

  await assert.rejects(scheduler.run(async () => { starts.push(clock.value()); throw rateLimit; }));
  await scheduler.run(async () => { starts.push(clock.value()); });

  assert.deepEqual(starts, [0, 100]);
  assert.equal(scheduler.isRateLimited(), false);
  assert.equal(scheduler.getCooldownUntil(), null);
});

test('repeated provider 429s retain ordinary shared pacing instead of exponential global backoff', async () => {
  const clock = schedulerClock();
  const starts: number[] = [];
  const scheduler = new YouTubeRequestScheduler({
    minIntervalMs: 100,
    initialRateLimitBackoffMs: 500,
    maxRateLimitBackoffMs: 800,
    now: clock.now,
    sleep: clock.sleep,
  });
  const rateLimit = () => Object.assign(new Error('YouTube HTTP 429 RESOURCE_EXHAUSTED (rateLimitExceeded)'), {
    status: 429,
    quotaExceeded: false,
    providerReasons: ['rateLimitExceeded'],
  });

  await assert.rejects(scheduler.run(async () => { starts.push(clock.value()); throw rateLimit(); }));
  await assert.rejects(scheduler.run(async () => { starts.push(clock.value()); throw rateLimit(); }));
  await scheduler.run(async () => { starts.push(clock.value()); });

  assert.deepEqual(starts, [0, 100, 200]);
});

test('daily quota exhaustion also leaves global pacing unchanged', async () => {
  const clock = schedulerClock();
  const starts: number[] = [];
  const scheduler = new YouTubeRequestScheduler({
    minIntervalMs: 100,
    initialRateLimitBackoffMs: 500,
    maxRateLimitBackoffMs: 2_000,
    now: clock.now,
    sleep: clock.sleep,
  });
  const quota = Object.assign(new Error('YouTube HTTP 403 (quotaExceeded)'), {
    status: 403,
    quotaExceeded: true,
    providerReasons: ['quotaExceeded'],
  });

  await assert.rejects(scheduler.run(async () => { starts.push(clock.value()); throw quota; }));
  await scheduler.run(async () => { starts.push(clock.value()); });

  assert.deepEqual(starts, [0, 100]);
});
