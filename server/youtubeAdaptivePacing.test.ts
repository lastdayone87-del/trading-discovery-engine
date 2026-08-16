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

test('repeated runtime 429s increase outbound spacing without exposing a binary scheduler cooldown', async () => {
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

  assert.deepEqual(starts, [0, 1_000, 3_000]);
  assert.ok(traces.includes('adaptive-rate-pressure 1000ms'));
  assert.ok(traces.includes('adaptive-rate-pressure 2000ms'));
  assert.ok(traces.includes('adaptive-rate-pressure 4000ms'));
  assert.equal(scheduler.isRateLimited(), false);
  assert.equal(scheduler.getCooldownUntil(), null);
});

test('adaptive pacing is bounded and recovers gradually after sustained successes', async () => {
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

  assert.deepEqual(starts, [0, 1_000, 3_000, 5_000, 7_000, 9_000, 10_000]);
  assert.ok(traces.filter(trace => trace === 'adaptive-rate-pressure 2000ms').length >= 2);
  assert.ok(traces.includes('adaptive-rate-recovery 1000ms'));
  assert.ok(traces.includes('adaptive-rate-recovery 500ms'));
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
