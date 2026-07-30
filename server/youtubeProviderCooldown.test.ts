import test from 'node:test';
import assert from 'node:assert/strict';
import { YouTubeProviderCooldown } from './youtubeProviderCooldown';

test('rate-limited providers are skipped until their exponential cooldown expires', () => {
  let now = 1_000;
  const providers = new YouTubeProviderCooldown({initialRateLimitCooldownMs:100,maxRateLimitCooldownMs:400,now:()=>now});
  assert.equal(providers.failed('project-a', 'RATE_LIMITED'), 1_100);
  assert.equal(providers.eligible('project-a'), false);
  assert.equal(providers.eligible('project-b'), true);
  now = 1_100;
  assert.equal(providers.eligible('project-a'), true);
});

test('daily quota exhaustion cools only that provider until the next UTC day', () => {
  let now = Date.parse('2026-07-30T12:00:00Z');
  const providers = new YouTubeProviderCooldown({initialRateLimitCooldownMs:100,maxRateLimitCooldownMs:400,now:()=>now});
  assert.equal(providers.failed('project-a', 'DAILY_QUOTA_EXHAUSTED'), Date.parse('2026-07-31T00:00:00Z'));
  assert.equal(providers.eligible('project-a'), false);
  assert.equal(providers.eligible('project-b'), true);
  now = Date.parse('2026-07-31T00:00:00Z');
  assert.equal(providers.eligible('project-a'), true);
});

test('final eligible provider failure exposes the earliest pool retry time', () => {
  const now = Date.parse('2026-07-30T12:00:00Z');
  const providers = new YouTubeProviderCooldown({initialRateLimitCooldownMs:100,maxRateLimitCooldownMs:400,now:()=>now});
  providers.failed('project-a', 'DAILY_QUOTA_EXHAUSTED');
  assert.equal(providers.earliestRetryAtIfAllCooling(['project-a', 'project-b']), null);
  providers.failed('project-b', 'RATE_LIMITED');
  assert.equal(providers.earliestRetryAtIfAllCooling(['project-a', 'project-b']), now + 100);
});
