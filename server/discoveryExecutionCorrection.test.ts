import test from 'node:test';
import assert from 'node:assert/strict';
import { discoveryDiversityKeys } from './discoveryDiversity';
import { shouldSkipTargetFallback } from './discoveryFallbackPolicy';

test('batch diversity keys allow equivalent intent across countries but dedupe within a country', () => {
  const canada = discoveryDiversityKeys('Canada', 'strategy', 'market structure');
  const france = discoveryDiversityKeys('France', 'strategy', 'market structure');
  const canadaAgain = discoveryDiversityKeys('canada', 'strategy', 'market structure');
  assert.notEqual(canada.intentKey, france.intentKey);
  assert.notEqual(canada.primaryTermKey, france.primaryTermKey);
  assert.deepEqual(canada, canadaAgain);
});

test('target fallback is skipped only when portfolio capacity is exhausted and no free provider exists', () => {
  assert.equal(shouldSkipTargetFallback(['PORTFOLIO_BUDGET_EXHAUSTED', 'NO_QUOTA_FREE_PROVIDER', 'FAIL_CLOSED']), true);
  assert.equal(shouldSkipTargetFallback(['PORTFOLIO_BUDGET_EXHAUSTED']), false);
  assert.equal(shouldSkipTargetFallback(['NO_QUOTA_FREE_PROVIDER']), false);
  assert.equal(shouldSkipTargetFallback(null), false);
});
