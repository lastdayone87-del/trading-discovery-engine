import assert from 'node:assert/strict';
import test from 'node:test';
import { paceRobotsOrigin } from './robotsPacing';

test('concurrent crawls serialize their wait windows per origin', async () => {
  const origin = `https://pace-${Date.now()}-${Math.random()}.example`;
  const budgetA = { spentMs: 0 };
  const budgetB = { spentMs: 0 };
  const started = Date.now();
  const first = await paceRobotsOrigin(origin, 40, budgetA);
  const second = await paceRobotsOrigin(origin, 40, budgetB);
  assert.equal(first, true);
  assert.equal(second, true);
  assert.ok(Date.now() - started >= 30, 'the second caller must wait for the shared interval');
  assert.ok(budgetB.spentMs >= 20, 'the second caller owns the wait it actually performed');
});

test('a crawl delay budget stops the next request instead of over-waiting', async () => {
  const origin = `https://budget-${Date.now()}-${Math.random()}.example`;
  const first = await paceRobotsOrigin(origin, 40, { spentMs: 0 });
  assert.equal(first, true);
  const second = await paceRobotsOrigin(origin, 40, { spentMs: 0 }, 10);
  assert.equal(second, false);
});

test('different origins do not serialize each other', async () => {
  const a = `https://a-${Date.now()}-${Math.random()}.example`;
  const b = `https://b-${Date.now()}-${Math.random()}.example`;
  const started = Date.now();
  const results = await Promise.all([
    paceRobotsOrigin(a, 80, { spentMs: 0 }),
    paceRobotsOrigin(b, 80, { spentMs: 0 }),
  ]);
  assert.deepEqual(results, [true, true]);
  assert.ok(Date.now() - started < 60, 'origin pacing must not globally serialize unrelated hosts');
});
