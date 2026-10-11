import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import {
  acquireBenchmarkPlanLock,
  benchmarkPlanLockLabel,
} from './benchmarkPlanLock';

/**
 * Live-database mutual-exclusion tests for the same-plan advisory lock.
 * These run ONLY against an explicitly provided dedicated test database:
 *
 *   BENCHMARK_PLAN_LOCK_TEST_DATABASE_URL=postgresql://... npx tsx --test ...
 *
 * Without that variable every database test below skips. Advisory locks
 * write no tables and need no migrations; isolation is inherent (a fresh
 * service database holds no other sessions), and every test releases or
 * destroys its sessions.
 *
 * The label-derivation test has no database dependency and always runs.
 */

test('plan lock labels are deterministic per snapshot', () => {
  assert.equal(benchmarkPlanLockLabel('abc123'), benchmarkPlanLockLabel('abc123'));
  assert.notEqual(benchmarkPlanLockLabel('abc123'), benchmarkPlanLockLabel('def456'));
  assert.ok(benchmarkPlanLockLabel('abc123').includes('abc123'));
});

const dedicated = process.env.BENCHMARK_PLAN_LOCK_TEST_DATABASE_URL;

test('plan lock database tests require a dedicated database (skipped otherwise)', () => {
  if (!dedicated) {
    console.log(
      'SKIP: set BENCHMARK_PLAN_LOCK_TEST_DATABASE_URL to a dedicated test database to run live plan-lock tests.'
    );
  }
  assert.ok(true);
});

const maybe = dedicated ? test : test.skip;

function testPool(): Pool {
  const pool = new Pool({ connectionString: dedicated as string, ssl: false });
  // pg pools re-emit idle-client errors (e.g. after pg_terminate_backend in
  // the crash test) as uncaughtExceptions unless observed. Swallow them
  // here; every test still asserts its own outcomes explicitly.
  pool.on('error', () => undefined);
  return pool;
}

maybe('second executor is refused while the first holds the plan', async () => {
  const first = testPool();
  const second = testPool();
  try {
    const held = await acquireBenchmarkPlanLock(first, 'snapshot-hash-a');
    await assert.rejects(
      acquireBenchmarkPlanLock(second, 'snapshot-hash-a'),
      /BENCHMARK_PLAN_EXECUTION_HELD/
    );
    await held.release();
    const retaken = await acquireBenchmarkPlanLock(second, 'snapshot-hash-a');
    await retaken.release();
  } finally {
    await first.end().catch(() => undefined);
    await second.end().catch(() => undefined);
  }
});

maybe('different snapshots proceed independently', async () => {
  const first = testPool();
  const second = testPool();
  try {
    const heldA = await acquireBenchmarkPlanLock(first, 'snapshot-hash-a');
    const heldB = await acquireBenchmarkPlanLock(second, 'snapshot-hash-b');
    await heldA.release();
    await heldB.release();
  } finally {
    await first.end().catch(() => undefined);
    await second.end().catch(() => undefined);
  }
});

maybe('a crashed holder releases the plan automatically', async () => {
  // Deterministic crash equivalent: terminate the holder's backend session
  // directly (no timing). The server drops session advisory locks on
  // disconnect, so a fresh pool must acquire immediately after.
  const victim = testPool();
  const killer = testPool();
  try {
    const held = await acquireBenchmarkPlanLock(victim, 'snapshot-hash-crash');
    const holderPid = await victim
      .query(
        `SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND classid = 838042 AND objid = hashtext($1) AND granted`,
        ['benchmark-plan-execution:snapshot-hash-crash']
      )
      .then(res => Number(res.rows[0]?.pid));
    assert.ok(Number.isFinite(holderPid) && holderPid > 0, 'holder backend must be visible in pg_locks');
    await killer.query('SELECT pg_terminate_backend($1)', [holderPid]);
    const retaken = await acquireBenchmarkPlanLock(killer, 'snapshot-hash-crash');
    await retaken.release();
    // The terminated handle releases safely (destroy path, never throws).
    await held.release();
  } finally {
    await victim.end().catch(() => undefined);
    await killer.end().catch(() => undefined);
  }
});
