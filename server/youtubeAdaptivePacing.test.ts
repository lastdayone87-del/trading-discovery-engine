import test from 'node:test';
import assert from 'node:assert/strict';
import { YouTubeRequestScheduler } from './youtubeRequestScheduler';

const runtime429 = () => Object.assign(new Error('Provider rate limit reached.'), {
  errorClass: 'RATE_LIMIT',
  retryable: true,
  status: 429,
  quotaExceeded: false,
  providerReasons: ['rateLimitExceeded']
});

test('repeated provider-local runtime 429s keep normal scheduler spacing', async () => {
  let now = 0;
  const starts: number[] = [];
  const traces: string[] = [];
  const scheduler = new YouTubeRequestScheduler({
    minIntervalMs: 100,
    initialRateLimitBackoffMs: 500,
    maxRateLimitBackoffMs: 2_000,
    runtimeRateLimitFloorMs: 1_000,
    maxAdaptiveIntervalMs: 4_000,
    adaptiveRecoverySuccesses: 4,
    now: () => now,
    sleep: async ms => { now += ms; }
  });

  await assert.rejects(scheduler.run(async () => {
    starts.push(now);
    throw runtime429();
  }, trace => traces.push(trace)));
  await assert.rejects(scheduler.run(async () => {
    starts.push(now);
    throw runtime429();
  }, trace => traces.push(trace)));
  await assert.rejects(scheduler.run(async () => {
    starts.push(now);
    throw runtime429();
  }, trace => traces.push(trace)));

  assert.deepEqual(starts, [0, 100, 200]);
  assert.equal(traces.some(trace => trace.startsWith('adaptive-rate-pressure ')), false);
  assert.equal(scheduler.getRatePressureSnapshot().adaptiveIntervalMs, 100);
  assert.equal(scheduler.isRateLimited(), false);
  assert.equal(scheduler.getCooldownUntil(), null);
});

test('provider-local runtime 429s do not create adaptive pacing that later needs recovery', async () => {
  let now = 0;
  const starts: number[] = [];
  const traces: string[] = [];
  const scheduler = new YouTubeRequestScheduler({
    minIntervalMs: 100,
    initialRateLimitBackoffMs: 500,
    maxRateLimitBackoffMs: 2_000,
    runtimeRateLimitFloorMs: 1_000,
    maxAdaptiveIntervalMs: 2_000,
    adaptiveRecoverySuccesses: 2,
    now: () => now,
    sleep: async ms => { now += ms; }
  });

  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(scheduler.run(async () => {
      starts.push(now);
      throw runtime429();
    }, trace => traces.push(trace)));
  }

  for (let i = 0; i < 4; i += 1) {
    await scheduler.run(async () => { starts.push(now); }, trace => traces.push(trace));
  }

  assert.deepEqual(starts, [0, 100, 200, 300, 400, 500, 600]);
  assert.equal(traces.some(trace => trace.startsWith('adaptive-rate-pressure ')), false);
  assert.equal(traces.some(trace => trace.startsWith('adaptive-rate-recovery ')), false);
  assert.equal(scheduler.getRatePressureSnapshot().adaptiveIntervalMs, 100);
});

test('daily quota exhaustion does not activate adaptive runtime pacing', async () => {
  let now = 0;
  const starts: number[] = [];
  const scheduler = new YouTubeRequestScheduler({
    minIntervalMs: 100,
    initialRateLimitBackoffMs: 500,
    maxRateLimitBackoffMs: 2_000,
    runtimeRateLimitFloorMs: 1_000,
    maxAdaptiveIntervalMs: 4_000,
    now: () => now,
    sleep: async ms => { now += ms; }
  });

  const dailyQuota = Object.assign(new Error('Daily quota exhausted'), {
    errorClass: 'RATE_LIMIT',
    retryable: true,
    status: 403,
    quotaExceeded: true,
    providerReasons: ['quotaExceeded']
  });

  await assert.rejects(scheduler.run(async () => {
    starts.push(now);
    throw dailyQuota;
  }));
  await scheduler.run(async () => { starts.push(now); });

  assert.deepEqual(starts, [0, 100]);
});
