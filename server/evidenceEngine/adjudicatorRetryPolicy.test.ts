import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADJUDICATOR_RETRY_DELAYS_MS,
  adjudicatorRetryDelayMs,
  nextAdjudicatorRetryAt,
  summarizeAdjudicatorDeferrals,
} from './adjudicatorRetryPolicy';

test('adjudicator retry backoff grows and caps at 24 hours', () => {
  assert.equal(adjudicatorRetryDelayMs(1), ADJUDICATOR_RETRY_DELAYS_MS[0]);
  assert.equal(adjudicatorRetryDelayMs(3), ADJUDICATOR_RETRY_DELAYS_MS[2]);
  assert.equal(adjudicatorRetryDelayMs(99), ADJUDICATOR_RETRY_DELAYS_MS.at(-1));
  assert.equal(nextAdjudicatorRetryAt(1, 1_000), 1_000 + 60_000);
});

test('deferral metrics separate due, resolved, oldest and reasons', () => {
  const now = 10_000_000;
  const metrics = summarizeAdjudicatorDeferrals([
    { channelId: 'a', attempts: 1, reason: 'PRECISION_ADJUDICATOR_UNAVAILABLE_DEFERRED', nextRetryAt: now - 20_000 },
    { channelId: 'b', attempts: 4, reason: 'PRECISION_ADJUDICATOR_UNAVAILABLE_DEFERRED', nextRetryAt: now + 60_000 },
    { channelId: 'c', attempts: 2, reason: 'PRECISION_ADJUDICATOR_UNAVAILABLE_DEFERRED', nextRetryAt: now - 30_000, resolvedAt: now - 5_000 },
  ], now);
  assert.equal(metrics.total, 3);
  assert.equal(metrics.due, 1);
  assert.equal(metrics.resolved, 1);
  assert.equal(metrics.oldestAgeMs, 20_000);
  assert.equal(metrics.maxAttempts, 4);
  assert.equal(metrics.byReason.PRECISION_ADJUDICATOR_UNAVAILABLE_DEFERRED, 3);
});
