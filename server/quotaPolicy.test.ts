import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateYouTubeDailyBudget, quotaAllocationBudget } from './quotaPolicy';

test('daily budget reflects every configured YouTube API key', () => {
  assert.equal(calculateYouTubeDailyBudget(6), 60_000);
  assert.equal(calculateYouTubeDailyBudget(0), 0);
});

test('manual and autonomous allocations use the same real capacity', () => {
  const budget = calculateYouTubeDailyBudget(6);
  assert.equal(quotaAllocationBudget(budget, 20), 12_000);
  assert.equal(quotaAllocationBudget(budget, 70), 42_000);
  assert.equal(quotaAllocationBudget(budget, 10), 6_000);
});
