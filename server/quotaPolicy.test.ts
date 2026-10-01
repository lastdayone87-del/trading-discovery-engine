import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateEffectiveYouTubeBudget, calculateYouTubeDailyBudget, describeQuotaProjectMap, quotaAllocationBudget } from './quotaPolicy';

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

test('distinct QUOTA_GROUPs remain independent projects (one key per Cloud project)', () => {
  const distinct = [{ quotaGroup: 'A' }, { quotaGroup: 'B' }, { quotaGroup: 'C' }];
  assert.deepEqual(describeQuotaProjectMap(distinct).projectCount, 3);
  assert.equal(describeQuotaProjectMap(distinct).sharedProjectDetected, false);
  assert.equal(calculateEffectiveYouTubeBudget(distinct, 10_000), calculateYouTubeDailyBudget(3, 10_000));
});

test('shared QUOTA_GROUP collapses to one project budget', () => {
  const shared = [{ quotaGroup: 'A' }, { quotaGroup: 'A' }, { quotaGroup: 'B' }];
  const map = describeQuotaProjectMap(shared);
  assert.equal(map.projectCount, 2);
  assert.equal(map.sharedProjectDetected, true);
  assert.equal(calculateEffectiveYouTubeBudget(shared, 10_000), 20_000);
});

test('ungrouped keys retain legacy per-key assumption', () => {
  const ungrouped = [{}, {}, {}];
  assert.equal(calculateEffectiveYouTubeBudget(ungrouped, 10_000), calculateYouTubeDailyBudget(3, 10_000));
});
