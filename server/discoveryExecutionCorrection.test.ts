import test from 'node:test';
import assert from 'node:assert/strict';
import { discoveryDiversityKeys } from './discoveryDiversity';
import { shouldSkipTargetedGeneration } from './discoveryFallbackPolicy';

test('batch diversity keys allow equivalent intent across countries but dedupe within a country', () => {
  const canada = discoveryDiversityKeys('Canada', 'strategy', 'market structure');
  const france = discoveryDiversityKeys('France', 'strategy', 'market structure');
  const canadaAgain = discoveryDiversityKeys('canada', 'strategy', 'market structure');
  assert.notEqual(canada.intentKey, france.intentKey);
  assert.notEqual(canada.primaryTermKey, france.primaryTermKey);
  assert.deepEqual(canada, canadaAgain);
});

test('primary-term keys normalize case, Unicode and whitespace variants', () => {
  const base = discoveryDiversityKeys('Canada', 'strategy', 'Market   Structure');
  assert.equal(base.primaryTermKey, discoveryDiversityKeys('Canada', 'strategy', 'market structure').primaryTermKey);
  assert.equal(
    discoveryDiversityKeys('Canada', 'strategy', 'Ｍａｒｋｅｔ Structure').primaryTermKey,
    base.primaryTermKey,
  );
  assert.equal(
    discoveryDiversityKeys('Canada', 'strategy', 'market\tstructure').primaryTermKey,
    base.primaryTermKey,
  );
});

test('only targeted generation is skipped when portfolio capacity is exhausted and no free provider exists', () => {
  assert.equal(shouldSkipTargetedGeneration(['PORTFOLIO_BUDGET_EXHAUSTED', 'NO_QUOTA_FREE_PROVIDER', 'FAIL_CLOSED']), true);
  assert.equal(shouldSkipTargetedGeneration(['PORTFOLIO_BUDGET_EXHAUSTED']), false);
  assert.equal(shouldSkipTargetedGeneration(['NO_QUOTA_FREE_PROVIDER']), false);
  assert.equal(shouldSkipTargetedGeneration(null), false);
});
