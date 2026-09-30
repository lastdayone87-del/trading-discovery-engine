import assert from 'node:assert/strict';
import test from 'node:test';
import { contextualArmScore, selectThompsonArm, thompsonSample } from './allocationChallengers';

test('thompson sampling is deterministic and favors proven arms', () => {
  const a = thompsonSample(10, 1, 'salt-1');
  const b = thompsonSample(10, 1, 'salt-1');
  assert.equal(a, b);
  const low = thompsonSample(0, 10, 'salt-1');
  assert.ok(a > low);
  assert.throws(() => thompsonSample(-1, 0, 's'), /INVALID_ARM/);
  assert.throws(() => thompsonSample(0, 0, 's', 0, 1), /INVALID_PRIOR/);
});

test('thompson arm selection is replay-safe', () => {
  const arms = [{ successes: 20, failures: 2 }, { successes: 1, failures: 10 }];
  assert.equal(selectThompsonArm(arms, 'opp-x'), selectThompsonArm(arms, 'opp-x'));
  assert.throws(() => selectThompsonArm([], 'opp'), /NO_ARMS/);
});

test('contextual score combines value, exploration, and cost', () => {
  const high = contextualArmScore({ expectedValue: 0.9, uncertainty: 0.8, coverageGap: 0.8, cost: 0.1 });
  const low = contextualArmScore({ expectedValue: 0.1, uncertainty: 0.1, coverageGap: 0.1, cost: 0.9 });
  assert.ok(high > low);
  assert.throws(() => contextualArmScore({ expectedValue: NaN, uncertainty: 0, coverageGap: 0, cost: 0 }), /INVALID_ARM_FEATURES/);
});
