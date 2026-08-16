import test from 'node:test';
import assert from 'node:assert/strict';
import { YouTubeProviderCooldown, YouTubeProvidersCoolingDownError } from './youtubeProviderCooldown';

test('rate-limited provider is quarantined without cooling healthy providers', () => {
  let now = 1_000;
  const providers = new YouTubeProviderCooldown({initialRateLimitCooldownMs:100,maxRateLimitCooldownMs:400,runtimeRateLimitPauseMs:50,now:()=>now});
  assert.equal(providers.failed('project-a', 'RATE_LIMITED'), 1_100);
  assert.equal(providers.eligible('project-a'), false);
  assert.equal(providers.eligible('project-b'), true);
  assert.deepEqual(providers.status('project-a'), { status: 'Cooling Down', retryAt: 1_100 });
  assert.deepEqual(providers.status('project-b'), { status: 'Active', retryAt: null });
  assert.equal(providers.earliestRetryAtIfAllCooling(['project-a', 'project-b']), null);
  now = 1_100;
  assert.equal(providers.eligible('project-a'), true);
});

test('repeated 429 after cooldown preserves provider-local exponential history until success', () => {
  let now = 1_000;
  const providers = new YouTubeProviderCooldown({initialRateLimitCooldownMs:100,maxRateLimitCooldownMs:400,now:()=>now});
  assert.equal(providers.failed('project-a', 'RATE_LIMITED'), 1_100);
  now = 1_100;
  assert.equal(providers.eligible('project-a'), true);
  assert.equal(providers.failed('project-a', 'RATE_LIMITED'), 1_300);
  now = 1_300;
  assert.equal(providers.eligible('project-a'), true);
  assert.equal(providers.failed('project-a', 'RATE_LIMITED'), 1_700);
  now = 1_700;
  assert.equal(providers.failed('project-a', 'RATE_LIMITED'), 2_100);
  providers.succeeded('project-a');
  assert.equal(providers.failed('project-a', 'RATE_LIMITED'), 1_800);
});

test('stale success cannot clear a newer provider cooldown', () => {
  let now = 1_000;
  const providers = new YouTubeProviderCooldown({initialRateLimitCooldownMs:100,maxRateLimitCooldownMs:400,now:()=>now});
  const responseGeneration = providers.failureGeneration('project-a');
  assert.equal(responseGeneration, 0);
  assert.equal(providers.failed('project-a', 'RATE_LIMITED'), 1_100);
  assert.equal(providers.failureGeneration('project-a'), 1);
  assert.equal(providers.succeeded('project-a', responseGeneration), false);
  assert.equal(providers.eligible('project-a'), false);
  assert.equal(providers.retryAt('project-a'), 1_100);
  now = 1_100;
  assert.equal(providers.eligible('project-a'), true);
});

test('success at the current failure generation clears cooldown history', () => {
  let now = 1_000;
  const providers = new YouTubeProviderCooldown({initialRateLimitCooldownMs:100,maxRateLimitCooldownMs:400,now:()=>now});
  providers.failed('project-a', 'RATE_LIMITED');
  now = 1_100;
  const generation = providers.failureGeneration('project-a');
  assert.equal(providers.succeeded('project-a', generation), true);
  assert.equal(providers.retryAt('project-a'), 0);
  assert.equal(providers.failed('project-a', 'RATE_LIMITED'), 1_200);
});

test('daily quota exhaustion cools only that provider until the next Pacific quota day', () => {
  let now = Date.parse('2026-07-30T12:00:00Z');
  const providers = new YouTubeProviderCooldown({initialRateLimitCooldownMs:100,maxRateLimitCooldownMs:400,now:()=>now});
  const reset = providers.failed('project-a', 'DAILY_QUOTA_EXHAUSTED');
  assert.ok(reset > now);
  assert.equal(providers.eligible('project-a'), false);
  assert.deepEqual(providers.status('project-a'), { status: 'Daily Quota Exhausted', retryAt: reset });
  assert.equal(providers.eligible('project-b'), true);
  now = reset;
  assert.equal(providers.eligible('project-a'), true);
  assert.deepEqual(providers.status('project-a'), { status: 'Active', retryAt: null });
});

test('availability and recovery status scale across the configured provider pool independently', () => {
  let now = Date.parse('2026-07-30T12:00:00Z');
  const providers = new YouTubeProviderCooldown({initialRateLimitCooldownMs:100,maxRateLimitCooldownMs:400,now:()=>now});
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

test('final eligible provider failure exposes the earliest pool retry time', () => {
  const now = Date.parse('2026-07-30T12:00:00Z');
  const providers = new YouTubeProviderCooldown({initialRateLimitCooldownMs:100,maxRateLimitCooldownMs:400,now:()=>now});
  providers.failed('project-a', 'DAILY_QUOTA_EXHAUSTED');
  assert.equal(providers.earliestRetryAtIfAllCooling(['project-a', 'project-b']), null);
  providers.failed('project-b', 'RATE_LIMITED');
  assert.equal(providers.earliestRetryAtIfAllCooling(['project-a', 'project-b']), now + 100);
});

test('rate-limited providers recover independently when several projects are affected', () => {
  let now = 1_000;
  const providers = new YouTubeProviderCooldown({initialRateLimitCooldownMs:100,maxRateLimitCooldownMs:400,now:()=>now});
  providers.failed('project-a', 'RATE_LIMITED');
  now = 1_050;
  providers.failed('project-b', 'RATE_LIMITED');
  assert.equal(providers.earliestRetryAtIfAllCooling(['project-a', 'project-b']), 1_100);
  now = 1_100;
  assert.equal(providers.eligible('project-a'), true);
  assert.equal(providers.eligible('project-b'), false);
  assert.equal(providers.earliestRetryAtIfAllCooling(['project-a', 'project-b']), null);
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