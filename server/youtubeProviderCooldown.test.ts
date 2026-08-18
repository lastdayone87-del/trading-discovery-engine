import test from 'node:test';
import assert from 'node:assert/strict';
import { YouTubeProviderCooldown, YouTubeProvidersCoolingDownError } from './youtubeProviderCooldown';

test('first runtime 429 quarantines only the failing provider so another provider can be tried', () => {
  let now = 1_000;
  const providers = new YouTubeProviderCooldown({initialRateLimitCooldownMs:100,maxRateLimitCooldownMs:400,runtimeRateLimitPauseMs:50,now:()=>now});
  assert.equal(providers.failed('project-a', 'RATE_LIMITED'), 1_400);
  assert.equal(providers.eligible('project-a'), false);
  assert.equal(providers.eligible('project-b'), true);
  assert.deepEqual(providers.status('project-a'), { status: 'Cooling Down', retryAt: 1_400 });
  assert.deepEqual(providers.status('project-b'), { status: 'Active', retryAt: null });
  assert.equal(providers.earliestRetryAtIfAllCooling(['project-a', 'project-b']), null);
});

test('second distinct runtime 429 promotes a short shared pause without forgetting failed providers', () => {
  let now = 1_000;
  const providers = new YouTubeProviderCooldown({initialRateLimitCooldownMs:100,maxRateLimitCooldownMs:400,runtimeRateLimitPauseMs:50,now:()=>now});
  providers.failed('project-a', 'RATE_LIMITED');
  now = 1_025;
  assert.equal(providers.failed('project-b', 'RATE_LIMITED'), 1_075);
  assert.equal(providers.eligible('project-a'), false);
  assert.equal(providers.eligible('project-b'), false);
  assert.equal(providers.eligible('project-c'), false);
  assert.deepEqual(providers.status('project-c'), { status: 'Cooling Down', retryAt: 1_075 });
  assert.equal(providers.earliestRetryAtIfAllCooling(['project-a','project-b','project-c']), 1_075);
  now = 1_075;
  assert.equal(providers.eligible('project-a'), false);
  assert.equal(providers.eligible('project-b'), false);
  assert.equal(providers.eligible('project-c'), true);
  assert.deepEqual(providers.status('project-a'), { status: 'Cooling Down', retryAt: 1_400 });
  assert.deepEqual(providers.status('project-b'), { status: 'Cooling Down', retryAt: 1_425 });
});

test('subsequent distinct runtime 429 keeps advancing to an untried provider after each shared pause', () => {
  let now = 1_000;
  const providers = new YouTubeProviderCooldown({initialRateLimitCooldownMs:100,maxRateLimitCooldownMs:400,runtimeRateLimitPauseMs:50,now:()=>now});
  providers.failed('project-a', 'RATE_LIMITED');
  now = 1_025;
  providers.failed('project-b', 'RATE_LIMITED');
  now = 1_075;
  assert.equal(providers.eligible('project-c'), true);
  providers.failed('project-c', 'RATE_LIMITED');
  assert.equal(providers.eligible('project-d'), false);
  now = 1_125;
  assert.equal(providers.eligible('project-a'), false);
  assert.equal(providers.eligible('project-b'), false);
  assert.equal(providers.eligible('project-c'), false);
  assert.equal(providers.eligible('project-d'), true);
});

test('a successful independent provider does not trigger shared pressure', () => {
  let now = 1_000;
  const providers = new YouTubeProviderCooldown({initialRateLimitCooldownMs:100,maxRateLimitCooldownMs:400,runtimeRateLimitPauseMs:50,now:()=>now});
  providers.failed('project-a', 'RATE_LIMITED');
  assert.equal(providers.eligible('project-b'), true);
  assert.equal(providers.succeeded('project-b'), true);
  assert.equal(providers.eligible('project-b'), true);
  assert.equal(providers.eligible('project-c'), true);
  assert.equal(providers.status('project-a').status, 'Cooling Down');
});

test('same provider cannot immediately re-enter the acquisition after its confirmation window', () => {
  let now = 1_000;
  const providers = new YouTubeProviderCooldown({initialRateLimitCooldownMs:100,maxRateLimitCooldownMs:400,runtimeRateLimitPauseMs:50,now:()=>now});
  providers.failed('project-a', 'RATE_LIMITED');
  now = 1_100;
  assert.equal(providers.eligible('project-a'), false);
  assert.equal(providers.eligible('project-b'), true);
  now = 1_400;
  assert.equal(providers.eligible('project-a'), true);
  assert.equal(providers.failed('project-a', 'RATE_LIMITED'), 1_800);
});

test('daily quota exhaustion remains provider-specific until the next Pacific quota day', () => {
  let now = Date.parse('2026-07-30T12:00:00Z');
  const providers = new YouTubeProviderCooldown({initialRateLimitCooldownMs:100,maxRateLimitCooldownMs:400,runtimeRateLimitPauseMs:50,now:()=>now});
  const reset = providers.failed('project-a', 'DAILY_QUOTA_EXHAUSTED');
  assert.ok(reset > now);
  assert.equal(providers.eligible('project-a'), false);
  assert.equal(providers.eligible('project-b'), true);
  assert.deepEqual(providers.status('project-a'), { status: 'Daily Quota Exhausted', retryAt: reset });
  now = reset;
  assert.equal(providers.eligible('project-a'), true);
});

test('shared runtime pause does not erase longer provider-specific cooldowns or daily exhaustion', () => {
  let now = Date.parse('2026-07-30T12:00:00Z');
  const providers = new YouTubeProviderCooldown({initialRateLimitCooldownMs:100,maxRateLimitCooldownMs:400,runtimeRateLimitPauseMs:50,now:()=>now});
  const reset = providers.failed('project-a', 'DAILY_QUOTA_EXHAUSTED');
  providers.failed('project-b', 'RATE_LIMITED');
  now += 25;
  providers.failed('project-c', 'RATE_LIMITED');
  assert.deepEqual(providers.status('project-a'), { status: 'Daily Quota Exhausted', retryAt: reset });
  assert.equal(providers.status('project-b').status, 'Cooling Down');
  now += 50;
  assert.equal(providers.status('project-b').status, 'Cooling Down');
  assert.equal(providers.status('project-c').status, 'Cooling Down');
  assert.deepEqual(providers.status('project-a'), { status: 'Daily Quota Exhausted', retryAt: reset });
});

test('stale success cannot clear a newer provider-local rate-limit generation', () => {
  let now = 1_000;
  const providers = new YouTubeProviderCooldown({initialRateLimitCooldownMs:100,maxRateLimitCooldownMs:400,runtimeRateLimitPauseMs:50,now:()=>now});
  const responseGeneration = providers.failureGeneration('project-a');
  providers.failed('project-a', 'RATE_LIMITED');
  assert.equal(providers.succeeded('project-a', responseGeneration), false);
  assert.equal(providers.eligible('project-a'), false);
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