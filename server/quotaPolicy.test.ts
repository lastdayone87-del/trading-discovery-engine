import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateYouTubeDailyBudget, quotaAllocationBudget } from './quotaPolicy';

test('daily budget reflects every configured YouTube API key', () => {
  assert.equal(calculateYouTubeDailyBudget(10), 100_000);
  assert.equal(calculateYouTubeDailyBudget(0), 0);
});

test('manual and autonomous allocations use the same real capacity', () => {
  const budget = calculateYouTubeDailyBudget(10);
  assert.equal(quotaAllocationBudget(budget, 20), 20_000);
  assert.equal(quotaAllocationBudget(budget, 70), 70_000);
  assert.equal(quotaAllocationBudget(budget, 10), 10_000);
});
