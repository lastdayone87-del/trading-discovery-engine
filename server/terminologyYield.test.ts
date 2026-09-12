import assert from 'node:assert/strict';
import test from 'node:test';
import { scopeWeightedYield } from './terminologyIntelligence';

test('terminology yield weights in-scope share with legacy fallback', () => {
  assert.equal(scopeWeightedYield(10, 8, 2), 0.2);
  assert.equal(scopeWeightedYield(10, 8, undefined), 0.8);
  assert.equal(scopeWeightedYield(0, 0, 0), 0);
});
