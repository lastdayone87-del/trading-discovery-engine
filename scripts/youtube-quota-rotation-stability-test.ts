import assert from 'node:assert/strict';
import test from 'node:test';
import { nextYouTubeDailyQuotaResetAt, youtubeQuotaDateKey, YouTubeProviderCooldown } from '../server/youtubeProviderCooldown';
import { YouTubePoolBackoff } from '../server/youtubePoolBackoff';

test('YouTube quota day follows Pacific time rather than UTC', () => {
  // 2026-08-12 06:30 UTC is still 2026-08-11 in Los Angeles (PDT).
  const now = Date.parse('2026-08-12T06:30:00.000Z');
  assert.equal(youtubeQuotaDateKey(now), '2026-08-11');
  assert.equal(new Date(nextYouTubeDailyQuotaResetAt(now)).toISOString(), '2026-08-12T07:00:00.000Z');
});

test('YouTube quota reset follows winter Pacific offset', () => {
  const now = Date.parse('2026-01-15T12:00:00.000Z');
  assert.equal(youtubeQuotaDateKey(now), '2026-01-15');
  assert.equal(new Date(nextYouTubeDailyQuotaResetAt(now)).toISOString(), '2026-01-16T08:00:00.000Z');
});

test('daily exhausted provider remains unavailable until Pacific reset while healthy provider stays eligible', () => {
  let now = Date.parse('2026-08-12T06:30:00.000Z');
  const cooldown = new YouTubeProviderCooldown({
    initialRateLimitCooldownMs: 5_000,
    maxRateLimitCooldownMs: 300_000,
    runtimeRateLimitPauseMs: 1_000,
    now: () => now
  });
  const exhausted = 'key-a';
  const healthy = 'key-b';
  const retryAt = cooldown.failed(exhausted, 'DAILY_QUOTA_EXHAUSTED');

  assert.equal(new Date(retryAt).toISOString(), '2026-08-12T07:00:00.000Z');
  assert.equal(cooldown.eligible(exhausted), false);
  assert.equal(cooldown.eligible(healthy), true);
  assert.equal(cooldown.earliestRetryAtIfAllCooling([exhausted, healthy]), null);

  now = Date.parse('2026-08-12T07:00:00.000Z');
  assert.equal(cooldown.eligible(exhausted), true);
});

test('runtime rate limit quarantines only the failing provider while healthy providers stay eligible', () => {
  let now = 1_000_000;
  const cooldown = new YouTubeProviderCooldown({
    initialRateLimitCooldownMs: 5_000,
    maxRateLimitCooldownMs: 300_000,
    runtimeRateLimitPauseMs: 1_000,
    now: () => now
  });
  const retryAt = cooldown.failed('key-a', 'RATE_LIMITED');
  assert.equal(retryAt, 1_005_000);
  assert.equal(cooldown.eligible('key-a'), false);
  assert.equal(cooldown.eligible('key-b'), true);
  assert.equal(cooldown.earliestRetryAtIfAllCooling(['key-a', 'key-b']), null);

  now += 5_000;
  assert.equal(cooldown.eligible('key-a'), true);
  assert.equal(cooldown.eligible('key-b'), true);
  assert.equal(cooldown.earliestRetryAtIfAllCooling(['key-a', 'key-b']), null);
});

test('daily exhausted provider retains daily status while another provider is rate-limited', () => {
  let now = Date.parse('2026-08-12T06:30:00.000Z');
  const cooldown = new YouTubeProviderCooldown({
    initialRateLimitCooldownMs: 5_000,
    maxRateLimitCooldownMs: 300_000,
    runtimeRateLimitPauseMs: 1_000,
    now: () => now
  });
  const dailyReset = cooldown.failed('key-a', 'DAILY_QUOTA_EXHAUSTED');
  const rateLimitRetryAt = cooldown.failed('key-b', 'RATE_LIMITED');

  assert.deepEqual(cooldown.status('key-a'), { status: 'Daily Quota Exhausted', retryAt: dailyReset });
  assert.deepEqual(cooldown.status('key-b'), { status: 'Cooling Down', retryAt: rateLimitRetryAt });
  assert.equal(cooldown.retryAt('key-a'), dailyReset);
});

test('production-disabled legacy pool breaker does not freeze healthy projects after one quota failure', () => {
  let now = 10_000;
  const breaker = new YouTubePoolBackoff({
    initialBackoffMs: 15 * 60_000,
    maxBackoffMs: 6 * 60 * 60_000,
    now: () => now,
    enabled: false
  });
  const first = breaker.beginAcquisition();
  first.providerFailed('QUOTA_EXHAUSTED');

  assert.equal(breaker.getRetryAt(), 0);
  assert.doesNotThrow(() => breaker.beginAcquisition().release());

  now += 1;
  assert.doesNotThrow(() => breaker.beginAcquisition().release());
});

test('explicitly enabled legacy breaker preserves historical backoff semantics', () => {
  let now = 10_000;
  const breaker = new YouTubePoolBackoff({
    initialBackoffMs: 1_000,
    maxBackoffMs: 4_000,
    now: () => now,
    enabled: true
  });
  breaker.beginAcquisition().providerFailed('QUOTA_EXHAUSTED');
  assert.equal(breaker.getRetryAt(), 11_000);
  assert.throws(() => breaker.beginAcquisition());

  now = 11_000;
  const probe = breaker.beginAcquisition();
  probe.providerSucceeded();
  assert.equal(breaker.getRetryAt(), 0);
});
