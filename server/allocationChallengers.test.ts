import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { ALLOCATION_CHALLENGER_VERSION, contextualArmScore, selectThompsonArm, thompsonSample } from './allocationChallengers';

test('thompson sampling is deterministic and favors proven arms', () => {
  const a = thompsonSample(10, 1, 'salt-1');
  const b = thompsonSample(10, 1, 'salt-1');
  assert.equal(a, b);
  const low = thompsonSample(0, 10, 'salt-1');
  assert.ok(a > low);
  assert.throws(() => thompsonSample(-1, 0, 's'), /INVALID_ARM/);
  assert.throws(() => thompsonSample(0, 0, 's', 0, 1), /INVALID_PRIOR/);
});

test('thompson draws are genuine Beta quantiles: Beta(1,1) equals the driving uniform', () => {
  for (const salt of ['salt-a', 'salt-b', 'salt-c']) {
    const digest = createHash('sha256').update(`${ALLOCATION_CHALLENGER_VERSION}:thompson:${salt}:0:0:1:1`).digest('hex');
    const expected = Number.parseInt(digest.slice(0, 8), 16) / 0xffffffff;
    assert.ok(Math.abs(thompsonSample(0, 0, salt) - expected) < 1e-9, `Beta(1,1) draw must equal its uniform ${expected}`);
  }
});

test('thompson draws match posterior moments and cover the tails', () => {
  // Fixed salt sets: fully deterministic, generous tolerances, neutral Beta(2,2).
  const samples: number[] = [];
  for (let i = 0; i < 200; i++) samples.push(thompsonSample(1, 1, `moment-${i}`));
  const mean = samples.reduce((acc, v) => acc + v, 0) / samples.length;
  assert.ok(Math.abs(mean - 0.5) < 0.05, `mean ${mean} far from Beta(2,2) mean 0.5`);
  assert.ok(Math.min(...samples) < 0.25, 'draws never reach the lower tail');
  assert.ok(Math.max(...samples) > 0.75, 'draws never reach the upper tail');
  for (const v of samples) assert.ok(v >= 0 && v <= 1);
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

test('configured Thompson prior drives selection identically to persisted scores', async () => {
  const { selectThompsonArm, thompsonSample } = await import('./allocationChallengers');
  const arms = [
    { successes: 8, failures: 2 },
    { successes: 1, failures: 9 },
    { successes: 0, failures: 0 },
  ];
  const prior = { alpha0: 2, beta0: 5 };
  const first = selectThompsonArm(arms, 'opp-prior', prior);
  const second = selectThompsonArm(arms, 'opp-prior', prior);
  assert.equal(first, second);
  const scores = arms.map((counts, index) => thompsonSample(counts.successes, counts.failures, `opp-prior:${index}`, prior.alpha0, prior.beta0));
  let argmax = 0;
  scores.forEach((score, index) => {
    if (score > scores[argmax]) argmax = index;
  });
  assert.equal(first, argmax);
  const unconfigured = selectThompsonArm(arms, 'opp-prior');
  const implicit = selectThompsonArm(arms, 'opp-prior', {});
  assert.equal(unconfigured, implicit);
});
