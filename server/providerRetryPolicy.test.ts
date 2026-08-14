import test from 'node:test';
import assert from 'node:assert/strict';
import { decideJobFailure } from './db';

test('provider retry policy honors explicit hints and bounded exponential fallback', () => {
  const now = Date.now();
  assert.equal(decideJobFailure({ retryable: true, errorClass: 'RATE_LIMIT', retryAfterMs: 12_345 }, 1, 5, now).runAfter, now + 12_345);
  assert.equal(decideJobFailure({ retryable: true, errorClass: 'RATE_LIMIT', retryAt: now + 54_321 }, 1, 5, now).runAfter, now + 54_321);
  assert.equal(decideJobFailure({ code: 'ETIMEDOUT' }, 1, 5, now).runAfter, now + 30_000);
  assert.equal(decideJobFailure({ code: 'ETIMEDOUT' }, 20, 5, now).runAfter, now + 15 * 60_000);
});

test('provider retry policy stops retrying after the wall-clock ceiling', () => {
  const now = Date.now();
  const decision = decideJobFailure({ code: 'ETIMEDOUT' }, 1, 5, now, now - 7 * 60 * 60_000);
  assert.deepEqual(decision, { disposition: 'FAILED', operationallyBlocked: true });
});
