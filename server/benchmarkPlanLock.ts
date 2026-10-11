import type { Pool, PoolClient } from 'pg';

/**
 * Same-plan execution serialization across output directories (and hosts):
 * two runners executing copies of one benchmark snapshot must not schedule
 * the same opportunities concurrently. Unlike the outDir file lock (which
 * protects one directory's record files on one host), copies share only the
 * database ledger — so coordination lives in the database itself, the one
 * substrate every copy of a plan necessarily shares. Copies against
 * different databases are independent universes and need no coordination.
 *
 * Mechanism: a session-scoped PostgreSQL advisory lock keyed by snapshot
 * hash, held on a dedicated client for the whole run. The server arbitrates
 * acquisition atomically (pg_try_advisory_lock never blocks); a crashed
 * holder's TCP death releases the lock automatically, so there is no stale
 * state, no pid tracking, and no unlink race by construction. The two-lock
 * namespace (fixed class id + key hash) is disjoint from the migration lock
 * (single int key) and provider-budget locks (xact-scoped string keys).
 */

const BENCHMARK_PLAN_LOCK_CLASS = 838042;

export function benchmarkPlanLockLabel(snapshotHash: string): string {
  return `benchmark-plan-execution:${snapshotHash}`;
}

export interface BenchmarkPlanLock {
  /** Release the advisory lock and return the client to the pool. Never throws. */
  release(): Promise<void>;
}

/**
 * Acquire the plan lock for snapshotHash, failing closed when another
 * executor holds it. The dedicated client stays checked out until release():
 * advisory locks are session-scoped, so returning the client early (or
 * sharing the pool) would silently drop or leak the hold.
 */
export async function acquireBenchmarkPlanLock(db: Pool, snapshotHash: string): Promise<BenchmarkPlanLock> {
  const label = benchmarkPlanLockLabel(snapshotHash);
  const client: PoolClient = await db.connect();
  let held = false;
  try {
    const res = await client.query('SELECT pg_try_advisory_lock($1, hashtext($2)) AS held', [
      BENCHMARK_PLAN_LOCK_CLASS,
      label,
    ]);
    held = res.rows[0]?.held === true;
  } catch (error) {
    client.release();
    throw error;
  }
  if (!held) {
    client.release();
    throw new Error(
      `BENCHMARK_PLAN_EXECUTION_HELD: another executor is running this plan (snapshotHash=${snapshotHash}); ` +
        `refusing to schedule concurrently. Re-run after it finishes.`
    );
  }
  let released = false;
  return {
    async release(): Promise<void> {
      if (released) return;
      released = true;
      try {
        await client.query('SELECT pg_advisory_unlock($1, hashtext($2))', [BENCHMARK_PLAN_LOCK_CLASS, label]);
        client.release();
      } catch (error) {
        // A session that may still hold the lock must not stay usable: ask
        // the server to terminate this backend (deterministic unlock even if
        // this process lives on), then return the client. An already-dead
        // session makes the terminate a no-op. Never throws, so exit paths
        // cannot be masked by cleanup failures. (The repo-local pg typing
        // exposes release() only; process exit in all current uses closes
        // the TCP session regardless, which also drops the lock.)
        try {
          await client.query('SELECT pg_terminate_backend(pg_backend_pid())');
        } catch { /* already dead is fine */ }
        try {
          client.release();
        } catch { /* best effort */ }
        console.warn('[BenchmarkPlanLock] Unlock failed; backend terminated instead:', error instanceof Error ? error.message : String(error));
      }
    },
  };
}
