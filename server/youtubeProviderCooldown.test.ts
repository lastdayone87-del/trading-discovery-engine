import test from 'node:test';
import assert from 'node:assert/strict';
import { YouTubeProviderCooldown, YouTubeProvidersCoolingDownError } from './youtubeProviderCooldown';

test('runtime rate limits briefly pause the shared runtime without poisoning individual providers', () => {
  let now = 1_000;
  const providers = new YouTubeProviderCooldown({initialRateLimitCooldownMs:5_000,maxRateLimitCooldownMs:300_000,runtimeRateLimitPauseMs:100,now:()=>now});
  assert.equal(providers.failed('project-a', 'RATE_LIMITED'), 1_100);
  assert.equal(providers.eligible('project-a'), false);
  assert.equal(providers.eligible('project-b'), false);
  assert.deepEqual(providers.status('project-a'), { status: 'Cooling Down', retryAt: 1_100 });
  assert.deepEqual(providers.status('project-b'), { status: 'Cooling Down', retryAt: 1_100 });
  now = 1_100;
  assert.equal(providers.eligible('project-a'), true);
  assert.equal(providers.eligible('project-b'), true);
  assert.deepEqual(providers.status('project-a'), { status: 'Active', retryAt: null });
});

test('repeated runtime 429s extend one fixed pause rather than creating exponential key cooldowns', () => {
  let now = 1_000;
  const providers = new YouTubeProviderCooldown({initialRateLimitCooldownMs:5_000,maxRateLimitCooldownMs:300_000,runtimeRateLimitPauseMs:100,now:()=>now});
  assert.equal(providers.failed('project-a', 'RATE_LIMITED'), 1_100);
  now = 1_050;
  assert.equal(providers.failed('project-b', 'RATE_LIMITED'), 1_150);
  assert.equal(providers.retryAt('project-a'), 1_150);
  assert.equal(providers.retryAt('project-b'), 1_150);
  now = 1_150;
  assert.equal(providers.eligible('project-a'), true);
  assert.equal(providers.eligible('project-b'), true);
  assert.equal(providers.failed('project-a', 'RATE_LIMITED'), 1_250);
});

test('stale success cannot erase a newer runtime rate-limit generation', () => {
  let now = 1_000;
  const providers = new YouTubeProviderCooldown({initialRateLimitCooldownMs:100,maxRateLimitCooldownMs:400,runtimeRateLimitPauseMs:100,now:()=>now});
  const responseGeneration = providers.failureGeneration('project-a');
  assert.equal(responseGeneration, 0);
  assert.equal(providers.failed('project-a', 'RATE_LIMITED'), 1_100);
  assert.equal(providers.failureGeneration('project-a'), 1);
  assert.equal(providers.succeeded('project-a', responseGeneration), false);
  assert.equal(providers.eligible('project-a'), false);
  now = 1_100;
  assert.equal(providers.eligible('project-a'), true);
});

test('success does not prematurely clear a shared runtime pause', () => {
  let now = 1_000;
  const providers = new YouTubeProviderCooldown({initialRateLimitCooldownMs:100,maxRateLimitCooldownMs:400,runtimeRateLimitPauseMs:100,now:()=>now});
  providers.failed('project-a', 'RATE_LIMITED');
  const generation = providers.failureGeneration('project-a');
  assert.equal(providers.succeeded('project-a', generation), true);
  assert.equal(providers.eligible('project-a'), false);
  assert.equal(providers.eligible('project-b'), false);
  now = 1_100;
  assert.equal(providers.eligible('project-a'), true);
  assert.equal(providers.eligible('project-b'), true);
});

test('daily quota exhaustion cools only that provider until the next Pacific quota day', () => {
  let now = Date.parse('2026-07-30T12:00:00Z');
  const providers = new YouTubeProviderCooldown({initialRateLimitCooldownMs:100,maxRateLimitCooldownMs:400,runtimeRateLimitPauseMs:100,now:()=>now});
  const reset = providers.failed('project-a', 'DAILY_QUOTA_EXHAUSTED');
  assert.ok(reset > now);
  assert.equal(providers.eligible('project-a'), false);
  assert.deepEqual(providers.status('project-a'), { status: 'Daily Quota Exhausted', retryAt: reset });
  assert.equal(providers.eligible('project-b'), true);
  now = reset;
  assert.equal(providers.eligible('project-a'), true);
  assert.deepEqual(providers.status('project-a'), { status: 'Active', retryAt: null });
});

test('runtime pause preserves daily-exhausted provider state after healthy projects resume', () => {
  let now = Date.parse('2026-07-30T12:00:00Z');
  const providers = new YouTubeProviderCooldown({initialRateLimitCooldownMs:100,maxRateLimitCooldownMs:400,runtimeRateLimitPauseMs:100,now:()=>now});
  const dailyReset = providers.failed('project-a', 'DAILY_QUOTA_EXHAUSTED');
  const runtimeRetry = providers.failed('project-b', 'RATE_LIMITED');
  assert.equal(runtimeRetry, now + 100);
  assert.equal(providers.eligible('project-a'), false);
  assert.equal(providers.eligible('project-b'), false);
  now += 100;
  assert.equal(providers.eligible('project-b'), true);
  assert.equal(providers.eligible('project-a'), false);
  assert.deepEqual(providers.status('project-a'), { status: 'Daily Quota Exhausted', retryAt: dailyReset });
});

test('availability and recovery status scale across the configured provider pool independently', () => {
  let now = Date.parse('2026-07-30T12:00:00Z');
  const providers = new YouTubeProviderCooldown({initialRateLimitCooldownMs:100,maxRateLimitCooldownMs:400,runtimeRateLimitPauseMs:100,now:()=>now});
  const keys = Array.from({ length: 10 }, (_, index) => `project-${index + 1}`);
  keys.slice(0, 9).forEach(key => providers.failed(key, 'DAILY_QUOTA_EXHAUSTED'));
  assert.equal(providers.earliestRetryAtIfAllCooling(keys), null);
  assert.equal(providers.status(keys[9]).status, 'Active');
  providers.failed(keys[9], 'RATE_LIMITED');
  assert.equal(providers.earliestRetryAtIfAllCooling(keys), now + 100);
  now += 100;
  assert.equal(providers.status(keys[9]).status, 'Active');
  assert.equal(providers.earliestRetryAtIfAllCooling(keys), null);
});

test('all-provider daily exhaustion exposes the earliest pool retry time', () => {
  const now = Date.parse('2026-07-30T12:00:00Z');
  const providers = new YouTubeProviderCooldown({initialRateLimitCooldownMs:100,maxRateLimitCooldownMs:400,runtimeRateLimitPauseMs:100,now:()=>now});
  const retryA = providers.failed('project-a', 'DAILY_QUOTA_EXHAUSTED');
  assert.equal(providers.earliestRetryAtIfAllCooling(['project-a', 'project-b']), null);
  const retryB = providers.failed('project-b', 'DAILY_QUOTA_EXHAUSTED');
  assert.equal(retryA, retryB);
  assert.equal(providers.earliestRetryAtIfAllCooling(['project-a', 'project-b']), retryA);
});

test('all-provider cooldown error is explicitly retryable and typed as rate limit', () => {
  const retryAt = Date.now() + 5_000;
  const error = new YouTubeProvidersCoolingDownError(retryAt);
  assert.equal(error.code, 'YOUTUBE_PROVIDERS_COOLING_DOWN');
  assert.equal(error.retryable, true);
  assert.equal(error.errorClass, 'RATE_LIMIT');
  assert.equal(error.retryAt, retryAt);
  assert.ok(error.retryAfterMs >= 0);
});
