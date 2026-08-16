import test from 'node:test';
import assert from 'node:assert/strict';
import { YouTubeProviderCooldown, YouTubeProvidersCoolingDownError } from './youtubeProviderCooldown';

test('runtime 429 creates one shared short pause instead of quarantining keys individually', () => {
  let now = 1_000;
  const providers = new YouTubeProviderCooldown({initialRateLimitCooldownMs:100,maxRateLimitCooldownMs:400,runtimeRateLimitPauseMs:50,now:()=>now});
  assert.equal(providers.failed('project-a', 'RATE_LIMITED'), 1_050);
  assert.equal(providers.eligible('project-a'), false);
  assert.equal(providers.eligible('project-b'), false);
  assert.deepEqual(providers.status('project-a'), { status: 'Cooling Down', retryAt: 1_050 });
  assert.deepEqual(providers.status('project-b'), { status: 'Cooling Down', retryAt: 1_050 });
  assert.equal(providers.earliestRetryAtIfAllCooling(['project-a', 'project-b']), 1_050);
  now = 1_050;
  assert.equal(providers.eligible('project-a'), true);
  assert.equal(providers.eligible('project-b'), true);
});

test('repeated runtime 429s extend only the fixed shared pause and do not accumulate per-key exponential cooldown', () => {
  let now = 1_000;
  const providers = new YouTubeProviderCooldown({initialRateLimitCooldownMs:100,maxRateLimitCooldownMs:400,runtimeRateLimitPauseMs:50,now:()=>now});
  assert.equal(providers.failed('project-a', 'RATE_LIMITED'), 1_050);
  now = 1_025;
  assert.equal(providers.failed('project-b', 'RATE_LIMITED'), 1_075);
  assert.equal(providers.retryAt('project-a'), 1_075);
  assert.equal(providers.retryAt('project-b'), 1_075);
  now = 1_075;
  assert.equal(providers.eligible('project-a'), true);
  assert.equal(providers.eligible('project-b'), true);
  assert.equal(providers.failed('project-a', 'RATE_LIMITED'), 1_125);
});

test('success cannot clear a shared runtime pause raised by another request', () => {
  let now = 1_000;
  const providers = new YouTubeProviderCooldown({initialRateLimitCooldownMs:100,maxRateLimitCooldownMs:400,runtimeRateLimitPauseMs:50,now:()=>now});
  const generation = providers.failureGeneration('project-a');
  providers.failed('project-a', 'RATE_LIMITED');
  assert.equal(providers.succeeded('project-a', generation), false);
  assert.equal(providers.eligible('project-b'), false);
  now = 1_050;
  assert.equal(providers.eligible('project-b'), true);
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

test('runtime pause does not erase a longer provider-specific daily exhaustion boundary', () => {
  let now = Date.parse('2026-07-30T12:00:00Z');
  const providers = new YouTubeProviderCooldown({initialRateLimitCooldownMs:100,maxRateLimitCooldownMs:400,runtimeRateLimitPauseMs:50,now:()=>now});
  const reset = providers.failed('project-a', 'DAILY_QUOTA_EXHAUSTED');
  providers.failed('project-b', 'RATE_LIMITED');
  assert.deepEqual(providers.status('project-a'), { status: 'Daily Quota Exhausted', retryAt: reset });
  assert.equal(providers.status('project-b').status, 'Cooling Down');
  now += 50;
  assert.equal(providers.status('project-b').status, 'Active');
  assert.deepEqual(providers.status('project-a'), { status: 'Daily Quota Exhausted', retryAt: reset });
});

test('all-provider cooling exposes the shared retry boundary for scheduler absorption', () => {
  let now = 1_000;
  const providers = new YouTubeProviderCooldown({initialRateLimitCooldownMs:100,maxRateLimitCooldownMs:400,runtimeRateLimitPauseMs:50,now:()=>now});
  providers.failed('project-a', 'RATE_LIMITED');
  assert.equal(providers.earliestRetryAtIfAllCooling(['project-a','project-b','project-c']), 1_050);
  now = 1_050;
  assert.equal(providers.earliestRetryAtIfAllCooling(['project-a','project-b','project-c']), null);
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
