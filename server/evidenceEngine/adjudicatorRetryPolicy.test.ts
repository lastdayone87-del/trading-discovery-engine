import assert from 'node:assert/strict';
import test from 'node:test';
import {
  nextAdjudicatorDeferralPayload,
  nextAdjudicatorRetryAt,
  adjudicatorRetryDelayMs,
  summarizeAdjudicatorDeferrals,
} from './adjudicatorRetryPolicy';

test('adjudicator retry backoff grows and caps at 24 hours', () => {
  assert.equal(adjudicatorRetryDelayMs(1), 60_000);
  assert.equal(adjudicatorRetryDelayMs(2), 5 * 60_000);
  assert.equal(adjudicatorRetryDelayMs(3), 30 * 60_000);
  assert.equal(adjudicatorRetryDelayMs(4), 2 * 60 * 60_000);
  assert.equal(adjudicatorRetryDelayMs(5), 6 * 60 * 60_000);
  assert.equal(adjudicatorRetryDelayMs(6), 24 * 60 * 60_000);
  assert.equal(adjudicatorRetryDelayMs(99), 24 * 60 * 60_000);
  assert.equal(nextAdjudicatorRetryAt(1, 1_000), 61_000);
});

test('deferral payload preserves the first deferral time across retries', () => {
  const first = nextAdjudicatorDeferralPayload(undefined, undefined, 1_000);
  assert.deepEqual(first, { attempts: 1, firstDeferredAt: 1_000, nextRetryAt: 61_000 });
  const second = nextAdjudicatorDeferralPayload(first.attempts, first.firstDeferredAt, 61_000);
  assert.deepEqual(second, { attempts: 2, firstDeferredAt: 1_000, nextRetryAt: 61_000 + 5 * 60_000 });
});

test('deferral metrics separate due, resolved, oldest, overdue and reasons', () => {
  const now = 10_000_000;
  const metrics = summarizeAdjudicatorDeferrals([
    { channelId: 'a', attempts: 1, reason: 'PRECISION_ADJUDICATOR_UNAVAILABLE_DEFERRED', nextRetryAt: now - 20_000, firstDeferredAt: now - 120_000 },
    { channelId: 'b', attempts: 4, reason: 'PRECISION_ADJUDICATOR_UNAVAILABLE_DEFERRED', nextRetryAt: now + 60_000, firstDeferredAt: now - 300_000 },
    { channelId: 'c', attempts: 2, reason: 'PRECISION_ADJUDICATOR_UNAVAILABLE_DEFERRED', nextRetryAt: now - 30_000, firstDeferredAt: now - 500_000, resolvedAt: now - 5_000 },
    { channelId: 'd', attempts: 3, reason: 'PRECISION_ADJUDICATOR_UNAVAILABLE_DEFERRED', nextRetryAt: now - 30_000, firstDeferredAt: now - 60_000 },
    { channelId: 'e', attempts: 3, reason: 'PRECISION_ADJUDICATOR_UNAVAILABLE_DEFERRED', nextRetryAt: now - 10_000, firstDeferredAt: now - 10_000, resolvedAt: 0 },
  ], now);
  assert.equal(metrics.total, 5);
  assert.equal(metrics.due, 2);
  // resolvedAt: 0 is a valid numeric timestamp and must count as resolved.
  assert.equal(metrics.resolved, 2);
  assert.equal(metrics.oldestAgeMs, 300_000);
  assert.equal(metrics.maxOverdueMs, 30_000);
  assert.equal(metrics.maxAttempts, 4);
  assert.equal(metrics.byReason.PRECISION_ADJUDICATOR_UNAVAILABLE_DEFERRED, 5);
  assert.equal(metrics.byReason.__proto__, undefined);
});

test('reason metrics use a null-prototype map', () => {
  const metrics = summarizeAdjudicatorDeferrals([
    { channelId: 'a', attempts: 1, reason: '__proto__', nextRetryAt: 0, firstDeferredAt: 0 },
  ], 1);
  assert.equal(metrics.byReason.__proto__, 1);
});
