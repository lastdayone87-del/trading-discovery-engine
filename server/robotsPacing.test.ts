import assert from 'node:assert/strict';
import test from 'node:test';
import { paceRobotsOrigin } from './robotsPacing';

test('concurrent crawls serialize their wait windows per origin', async () => {
  const origin = `https://pace-${Date.now()}-${Math.random()}.example`;
  const budgetA = { spentMs: 0 };
  const budgetB = { spentMs: 0 };
  const started = Date.now();
  const [first, second] = await Promise.all([
    paceRobotsOrigin(origin, 40, budgetA),
    paceRobotsOrigin(origin, 40, budgetB),
  ]);
  assert.equal(first, true);
  assert.equal(second, true);
  assert.ok(Date.now() - started >= 30, 'one caller must wait for the shared interval');
  assert.ok(budgetA.spentMs + budgetB.spentMs >= 20, 'the wait is charged to a crawl budget');
});

test('a crawl delay budget stops the next request instead of over-waiting', async () => {
  const origin = `https://budget-${Date.now()}-${Math.random()}.example`;
  const first = await paceRobotsOrigin(origin, 40, { spentMs: 0 });
  assert.equal(first, true);
  const second = await paceRobotsOrigin(origin, 40, { spentMs: 0 }, 10);
  assert.equal(second, false);
});

test('time spent queued behind another crawl counts against the budget', async () => {
  const origin = `https://queue-${Date.now()}-${Math.random()}.example`;
  await paceRobotsOrigin(origin, 1, { spentMs: 0 });
  const holder = paceRobotsOrigin(origin, 80, { spentMs: 0 });
  const started = Date.now();
  const queued = await paceRobotsOrigin(origin, 80, { spentMs: 0 }, 15);
  assert.equal(queued, false);
  assert.ok(Date.now() - started < 70, 'a queued caller must not wait out the origin delay');
  assert.equal(await holder, true);
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
