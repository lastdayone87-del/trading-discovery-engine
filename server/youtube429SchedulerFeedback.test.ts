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

test('runtime 429s automatically feed the shared exponential scheduler backoff', async () => {
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

  assert.deepEqual(starts, [0, 500, 1_300]);
});

test('daily quota exhaustion does not trigger runtime request-rate backoff', async () => {
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

test('a successful request resets the exponential 429 backoff level', async () => {
  const clock = schedulerClock();
  const starts: number[] = [];
  const scheduler = new YouTubeRequestScheduler({
    minIntervalMs: 100,
    initialRateLimitBackoffMs: 500,
    maxRateLimitBackoffMs: 2_000,
    now: clock.now,
    sleep: clock.sleep,
  });
  const rateLimit = () => Object.assign(new Error('YouTube HTTP 429'), { status: 429, quotaExceeded: false });

  await assert.rejects(scheduler.run(async () => { starts.push(clock.value()); throw rateLimit(); }));
  await scheduler.run(async () => { starts.push(clock.value()); });
  await assert.rejects(scheduler.run(async () => { starts.push(clock.value()); throw rateLimit(); }));
  await scheduler.run(async () => { starts.push(clock.value()); });

  assert.deepEqual(starts, [0, 500, 600, 1_100]);
});
