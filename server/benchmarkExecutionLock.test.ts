import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireBenchmarkExecutionLock,
  inspectStaleLock,
  isEnoentError,
  isLockOwnerLive,
  lockFilePathForOutputDir,
  readProcCmdline,
  refuseActiveBenchmarkExecution,
  serializeBenchmarkExecutionLock,
} from './benchmarkExecutionLock';

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'bench-execution-lock-'));
}

test('only one of two concurrent attempts acquires the lock', async () => {
  const outDir = freshDir();
  const results = await Promise.allSettled([
    (async () => acquireBenchmarkExecutionLock(outDir))(),
    (async () => acquireBenchmarkExecutionLock(outDir))(),
  ]);
  const held = results.filter(result => result.status === 'fulfilled');
  const refused = results.filter(result => result.status === 'rejected');
  assert.equal(held.length, 1);
  assert.equal(refused.length, 1);
  assert.match(
    String((refused[0] as PromiseRejectedResult).reason?.message || refused[0]),
    /BENCHMARK_EXECUTION_LOCK_HELD/
  );
});

test('a rejected attempt leaves the record and lock untouched', () => {
  const outDir = freshDir();
  const recordPath = join(outDir, 'execution-record.json');
  const before = '{"status":"PLANNED"}\n';
  writeFileSync(recordPath, before);
  // Foreign live holder: our own pid is guaranteed alive, foreign token.
  const foreign = serializeBenchmarkExecutionLock({
    pid: process.pid,
    token: 'foreign-token',
    startedAt: new Date().toISOString(),
  });
  writeFileSync(lockFilePathForOutputDir(outDir), foreign);
  assert.throws(() => acquireBenchmarkExecutionLock(outDir), /BENCHMARK_EXECUTION_LOCK_HELD/);
  assert.equal(readFileSync(recordPath, 'utf8'), before);
  assert.equal(readFileSync(lockFilePathForOutputDir(outDir), 'utf8'), foreign);
});

test('a second execution proceeds after the first releases', () => {
  const outDir = freshDir();
  const first = acquireBenchmarkExecutionLock(outDir);
  assert.equal(first.release(), true);
  const second = acquireBenchmarkExecutionLock(outDir);
  assert.notEqual(second.token, first.token);
  assert.equal(second.release(), true);
});

test('a stale lock from a dead process is recoverable', () => {
  const outDir = freshDir();
  // No live process can hold this pid: takeover must succeed, never block.
  writeFileSync(
    lockFilePathForOutputDir(outDir),
    serializeBenchmarkExecutionLock({ pid: 999999999, token: 'dead-owner', startedAt: '2026-01-01T00:00:00.000Z' })
  );
  const recovered = acquireBenchmarkExecutionLock(outDir);
  assert.equal(recovered.release(), true);
  // An interrupted IN_PROGRESS record is left for the existing resume logic;
  // the stale lock never blocks it permanently.
  const again = acquireBenchmarkExecutionLock(outDir);
  assert.equal(again.release(), true);
});

test('release never removes another process\u2019s lock', () => {
  const outDir = freshDir();
  const ours = acquireBenchmarkExecutionLock(outDir);
  const foreign = serializeBenchmarkExecutionLock({
    pid: process.pid,
    token: 'foreign-token',
    startedAt: new Date().toISOString(),
  });
  writeFileSync(lockFilePathForOutputDir(outDir), foreign);
  assert.equal(ours.release(), false);
  assert.equal(readFileSync(lockFilePathForOutputDir(outDir), 'utf8'), foreign);
  assert.equal(ours.release(), false);
});

test('release with no lock file is a safe no-op', () => {
  const outDir = freshDir();
  const holder = acquireBenchmarkExecutionLock(outDir);
  assert.equal(holder.release(), true);
  assert.equal(holder.release(), false);
});

test('lock file carries owner identity for diagnosis', () => {
  const outDir = freshDir();
  const holder = acquireBenchmarkExecutionLock(outDir);
  const parsed = JSON.parse(readFileSync(lockFilePathForOutputDir(outDir), 'utf8')) as {
    pid: number;
    token: string;
  };
  assert.equal(parsed.pid, process.pid);
  assert.equal(parsed.token, holder.token);
  assert.equal(holder.release(), true);
});

test('runner holds the lock across mutation and scheduling, and releases on every terminal path', () => {
  const script = readFileSync(new URL('../scripts/runBenchmarkPreregV1.ts', import.meta.url), 'utf8');
  // Acquired after read-only preflight, strictly before the IN_PROGRESS
  // mutation: a refused contender has scheduled nothing and mutated nothing.
  assert.match(
    script,
    /acquireBenchmarkExecutionLock\(outDir\)[\s\S]*record\.status = 'IN_PROGRESS'/
  );
  // Released on handled failures (abortIncomplete persists INCOMPLETE first).
  assert.match(
    script,
    /record\.status = 'INCOMPLETE'[\s\S]*releaseActiveBenchmarkExecutionLock\(\)[\s\S]*await db\.end\(\)/
  );
  // Released before both COMPLETE exits (process.exit skips finally blocks,
  // so the release must be explicit at each site).
  assert.match(
    script,
    /isScopeTerminallyAccounted\(statesNow\)[\s\S]*?releaseActiveBenchmarkExecutionLock\(\);[\s\S]*?process\.exit\(0\)/
  );
  assert.match(
    script,
    /isScopeTerminallyAccounted\(finalStates\)[\s\S]*?releaseActiveBenchmarkExecutionLock\(\);[\s\S]*?process\.exit\(0\)/
  );
  // Released on uncaught mid-execution failures (record stays resumable).
  // The catch is async so the advisory plan-client release completes.
  assert.match(
    script,
    /main\(\)\.catch\(async error => \{[\s\S]*await releaseActiveBenchmarkExecutionLock\(\)[\s\S]*process\.exit\(1\)/
  );
});

test('concurrent stale-takeover attempts yield exactly one holder', async () => {
  // The Finding 1 scenario: many recovery contenders race on one dead-owner
  // lock. Contention is real (shared event loop, shared path) while the
  // asserted invariants are deterministic: single winner, consistent file,
  // no litter, losers refused without side effects.
  for (let round = 0; round < 3; round++) {
    const outDir = freshDir();
    writeFileSync(
      lockFilePathForOutputDir(outDir),
      serializeBenchmarkExecutionLock({ pid: 999999999, token: `dead-${round}`, startedAt: '2026-01-01T00:00:00.000Z' })
    );
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => (async () => {
        try {
          return { held: true as const, token: acquireBenchmarkExecutionLock(outDir).token };
        } catch (error) {
          return { held: false as const, message: error instanceof Error ? error.message : String(error) };
        }
      })())
    );
    const winners = outcomes.filter(outcome => outcome.held);
    const refused = outcomes.filter(outcome => !outcome.held);
    assert.equal(winners.length, 1);
    assert.equal(refused.length, 7);
    for (const loser of refused) {
      assert.match(String((loser as { message: string }).message), /BENCHMARK_EXECUTION_LOCK_HELD/);
    }
    const current = JSON.parse(readFileSync(lockFilePathForOutputDir(outDir), 'utf8')) as { token: string };
    assert.equal(current.token, (winners[0] as { token: string }).token);
    const leftovers = readdirSync(outDir).filter(name => name !== 'execution-record.execute.lock');
    assert.deepEqual(leftovers, []);
  }
});

test('recovery contention never deletes a live lock', async () => {
  // A live holder plus racing contenders: every contender refuses and the
  // live lock file stays byte-identical, so no takeover path can remove a
  // lock another process has already acquired. Deterministic outcome.
  for (let round = 0; round < 3; round++) {
    const outDir = freshDir();
    const holder = acquireBenchmarkExecutionLock(outDir);
    const before = readFileSync(lockFilePathForOutputDir(outDir), 'utf8');
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => (async () => {
        try {
          acquireBenchmarkExecutionLock(outDir);
          return 'acquired';
        } catch {
          return 'refused';
        }
      })())
    );
    assert.ok(outcomes.every(outcome => outcome === 'refused'));
    assert.equal(readFileSync(lockFilePathForOutputDir(outDir), 'utf8'), before);
    assert.equal(holder.release(), true);
  }
});

test('ownership gate aborts a holder that lost the lock', () => {
  const outDir = freshDir();
  const holder = acquireBenchmarkExecutionLock(outDir);
  holder.assertOwned();
  // Another execution takes over after our pid is (falsely for this test)
  // gone: overwrite with a foreign live claim, as a residual takeover race
  // could. The gate must fail closed instead of letting us mutate.
  writeFileSync(
    lockFilePathForOutputDir(outDir),
    serializeBenchmarkExecutionLock({ pid: process.pid, token: 'foreign-live', startedAt: new Date().toISOString() })
  );
  assert.throws(() => holder.assertOwned(), /BENCHMARK_EXECUTION_LOCK_LOST/);
  // And deleting the file reads as lost too, never as owned.
  writeFileSync(lockFilePathForOutputDir(outDir), 'not-json{');
  assert.throws(() => holder.assertOwned(), /BENCHMARK_EXECUTION_LOCK_LOST/);
});

test('runner gates every mutation and schedule on live ownership', () => {
  const script = readFileSync(new URL('../scripts/runBenchmarkPreregV1.ts', import.meta.url), 'utf8');
  assert.match(
    script,
    /const saveRecord = \(\) => \{[\s\S]*?executionLock\.assertOwned\(\);[\s\S]*?writeFileSync\(recordPath/
  );
  assert.match(
    script,
    /executionLock\.assertOwned\(\);[\s\S]*?report = await runAutonomousDiscoveryCycle\(row\.country/
  );
});

test('paused recovery cannot remove a live lock acquired after inspection', () => {
  // The exact reported interleaving, forced deterministically (no timing):
  // 1. A and B both face the same dead-owner lock.
  // 2. B inspects it and pauses holding a takeover intent.
  // 3. A completes recovery and acquires a new live lock.
  // 4. B resumes and attempts recovery.
  // 5. B must neither delete nor replace A's live lock, A stays sole owner,
  //    and B cannot proceed to benchmark work.
  const outDir = freshDir();
  const lockPath = lockFilePathForOutputDir(outDir);
  writeFileSync(
    lockPath,
    serializeBenchmarkExecutionLock({ pid: 999999999, token: 'stale-owner', startedAt: '2026-01-01T00:00:00.000Z' })
  );
  const bInspection = inspectStaleLock(lockPath, 'test-B-paused');
  if (bInspection.outcome !== 'recoverable') assert.fail('B should hold a takeover intent on a dead lock');
  const a = acquireBenchmarkExecutionLock(outDir);
  a.assertOwned();
  const liveBytes = readFileSync(lockPath, 'utf8');
  assert.equal(bInspection.recovery.commit(), 'changed');
  assert.equal(readFileSync(lockPath, 'utf8'), liveBytes);
  // B cannot proceed: a fresh claim sees A's live lock and refuses, with no
  // mutation or scheduling on B's side.
  assert.throws(() => acquireBenchmarkExecutionLock(outDir), /BENCHMARK_EXECUTION_LOCK_HELD/);
  assert.equal(readFileSync(lockPath, 'utf8'), liveBytes);
  // A remains the sole owner to the end.
  a.assertOwned();
  assert.equal(a.release(), true);
  // And the output directory is reusable afterward.
  const next = acquireBenchmarkExecutionLock(outDir);
  assert.equal(next.release(), true);
});

test('abandoned recovery touches nothing', () => {
  const outDir = freshDir();
  const lockPath = lockFilePathForOutputDir(outDir);
  const staleBytes = serializeBenchmarkExecutionLock({ pid: 999999999, token: 'stale-owner', startedAt: '2026-01-01T00:00:00.000Z' });
  writeFileSync(lockPath, staleBytes);
  const inspection = inspectStaleLock(lockPath, 'test-abandon');
  if (inspection.outcome !== 'recoverable') assert.fail('expected a takeover intent');
  inspection.recovery.abandon();
  assert.equal(readFileSync(lockPath, 'utf8'), staleBytes);
  const leftovers = readdirSync(outDir).filter(name => name !== 'execution-record.execute.lock');
  assert.deepEqual(leftovers, []);
  const holder = acquireBenchmarkExecutionLock(outDir);
  assert.equal(holder.release(), true);
});

test('inspection classifies live, unreadable, and absent locks', () => {
  const outDir = freshDir();
  const lockPath = lockFilePathForOutputDir(outDir);
  assert.equal(inspectStaleLock(lockPath, 'test-absent').outcome, 'recheck');
  writeFileSync(lockPath, 'not-json{');
  assert.equal(inspectStaleLock(lockPath, 'test-corrupt').outcome, 'unreadable');
  writeFileSync(
    lockPath,
    serializeBenchmarkExecutionLock({ pid: process.pid, token: 'live-owner', startedAt: new Date().toISOString() })
  );
  const live = inspectStaleLock(lockPath, 'test-live');
  if (live.outcome !== 'live') assert.fail('expected a live verdict');
  assert.equal(live.info.token, 'live-owner');
});

test('committed takeover removes only the inspected instance', () => {
  const outDir = freshDir();
  const lockPath = lockFilePathForOutputDir(outDir);
  writeFileSync(
    lockPath,
    serializeBenchmarkExecutionLock({ pid: 999999999, token: 'stale-owner', startedAt: '2026-01-01T00:00:00.000Z' })
  );
  const inspection = inspectStaleLock(lockPath, 'test-commit');
  if (inspection.outcome !== 'recoverable') assert.fail('expected a takeover intent');
  assert.equal(inspection.recovery.commit(), 'removed');
  assert.equal(existsSync(lockPath), false);
  const holder = acquireBenchmarkExecutionLock(outDir);
  assert.equal(holder.release(), true);
  const leftovers = readdirSync(outDir).filter(name => name !== 'execution-record.execute.lock');
  assert.deepEqual(leftovers, []);
});

test('commit on a concurrently removed lock returns changed, not ENOENT', () => {
  // Forced sequence, no timing: B inspects a stale lock and pauses; another
  // contender removes the shared lock before B's re-stat. commit() must
  // return 'changed' (rejoining the retry/claim flow), never leak the raw
  // ENOENT, and leave no quarantine artifact behind.
  const outDir = freshDir();
  const lockPath = lockFilePathForOutputDir(outDir);
  writeFileSync(
    lockPath,
    serializeBenchmarkExecutionLock({ pid: 999999999, token: 'stale-owner', startedAt: '2026-01-01T00:00:00.000Z' })
  );
  const inspection = inspectStaleLock(lockPath, 'test-removed');
  if (inspection.outcome !== 'recoverable') assert.fail('expected a takeover intent');
  unlinkSync(lockPath);
  assert.equal(inspection.recovery.commit(), 'changed');
  assert.equal(existsSync(lockPath), false);
  const leftovers = readdirSync(outDir).filter(name => !name.startsWith('execution-record.execute.lock'));
  assert.deepEqual(leftovers, []);
  // The acquisition path handles the changed state by claiming fresh.
  const holder = acquireBenchmarkExecutionLock(outDir);
  holder.assertOwned();
  assert.equal(holder.release(), true);
});

test('commit rethrows non-ENOENT filesystem errors', () => {
  // Deterministic ENOTDIR (works even as root, unlike permission bits):
  // the parent directory is replaced by a file after inspection.
  const outDir = freshDir();
  const lockPath = lockFilePathForOutputDir(outDir);
  writeFileSync(
    lockPath,
    serializeBenchmarkExecutionLock({ pid: 999999999, token: 'stale-owner', startedAt: '2026-01-01T00:00:00.000Z' })
  );
  const inspection = inspectStaleLock(lockPath, 'test-enotdir');
  if (inspection.outcome !== 'recoverable') assert.fail('expected a takeover intent');
  const moved = `${outDir}.moved`;
  renameSync(outDir, moved);
  writeFileSync(outDir, 'not-a-directory');
  try {
    assert.throws(() => inspection.recovery.commit(), (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, 'ENOTDIR');
      return true;
    });
  } finally {
    unlinkSync(outDir);
    renameSync(moved, outDir);
  }
  // The original stale lock is untouched and still recoverable afterwards.
  assert.equal(readFileSync(lockPath, 'utf8'), serializeBenchmarkExecutionLock({ pid: 999999999, token: 'stale-owner', startedAt: '2026-01-01T00:00:00.000Z' }));
  const holder = acquireBenchmarkExecutionLock(outDir);
  assert.equal(holder.release(), true);
});

test('only ENOENT counts as a vanished path', () => {
  assert.equal(isEnoentError(Object.assign(new Error('gone'), { code: 'ENOENT' })), true);
  for (const code of ['EACCES', 'EPERM', 'EIO', 'ENOTDIR', 'EEXIST', undefined]) {
    assert.equal(isEnoentError(Object.assign(new Error('x'), { code })), false);
  }
  assert.equal(isEnoentError(new Error('plain')), false);
  assert.equal(isEnoentError(null), false);
});

test('owner liveness combines pid checks with command identity', () => {
  const calls: number[] = [];
  const reader = (pid: number) => {
    calls.push(pid);
    return 'node scripts/runBenchmarkPreregV1.ts --execute';
  };
  // Dead pid short-circuits before any command read.
  assert.equal(isLockOwnerLive({ pid: 999999999, token: 't', startedAt: '', argv: 'runBenchmarkPreregV1.ts' }, reader), false);
  assert.deepEqual(calls, []);
  // Live pid running the recorded script: live.
  assert.equal(isLockOwnerLive({ pid: process.pid, token: 't', startedAt: '', argv: 'runBenchmarkPreregV1.ts' }, reader), true);
  // Live pid recycled into an unrelated command: stale (recoverable).
  assert.equal(
    isLockOwnerLive({ pid: process.pid, token: 't', startedAt: '', argv: 'runBenchmarkPreregV1.ts' }, () => 'postgres: checkpointer'),
    false
  );
  // Unreadable command line (non-Linux) and pre-marker lock files keep the
  // conservative pid-only verdict: fail closed toward refusal.
  assert.equal(isLockOwnerLive({ pid: process.pid, token: 't', startedAt: '', argv: 'runBenchmarkPreregV1.ts' }, () => null), true);
  assert.equal(isLockOwnerLive({ pid: process.pid, token: 't', startedAt: '' }, () => 'anything'), true);
  // A throwing reader degrades to pid-only rather than crashing evaluation.
  assert.equal(
    isLockOwnerLive({ pid: process.pid, token: 't', startedAt: '', argv: 'runBenchmarkPreregV1.ts' }, () => { throw new Error('boom'); }),
    true
  );
});

test('acquired locks record the owner command for reuse checks', () => {
  const outDir = freshDir();
  const holder = acquireBenchmarkExecutionLock(outDir);
  const parsed = JSON.parse(readFileSync(lockFilePathForOutputDir(outDir), 'utf8')) as { argv?: string };
  assert.ok(parsed.argv && parsed.argv.length > 0);
  assert.equal(holder.release(), true);
});

test('planning is refused only for a proven-live executor', () => {
  const outDir = freshDir();
  refuseActiveBenchmarkExecution(outDir);
  writeFileSync(lockFilePathForOutputDir(outDir), 'not-json{');
  refuseActiveBenchmarkExecution(outDir);
  writeFileSync(
    lockFilePathForOutputDir(outDir),
    serializeBenchmarkExecutionLock({ pid: 999999999, token: 'stale', startedAt: '2026-01-01T00:00:00.000Z' })
  );
  refuseActiveBenchmarkExecution(outDir);
  const holder = acquireBenchmarkExecutionLock(outDir);
  assert.throws(() => refuseActiveBenchmarkExecution(outDir), /BENCHMARK_PLAN_BLOCKED_ACTIVE_EXECUTION/);
  assert.equal(holder.release(), true);
  refuseActiveBenchmarkExecution(outDir);
});

test('runner checks for active execution before planning and gates the first mutation', () => {
  const script = readFileSync(new URL('../scripts/runBenchmarkPreregV1.ts', import.meta.url), 'utf8');
  assert.match(
    script,
    /BENCHMARK_PREREG_RECORD_EXISTS[\s\S]*?refuseActiveBenchmarkExecution\(outDir\)[\s\S]*?query_library/
  );
  assert.match(
    script,
    /assertBenchmarkExecutionArtifactsEligible\(record, snapshot, spec\.specVersion\)[\s\S]*?executionLock\.assertOwned\(\);[\s\S]*?record\.status = 'IN_PROGRESS'/
  );
});

test('runner holds the advisory plan lock across the run and releases both locks on every terminal path', () => {
  const script = readFileSync(new URL('../scripts/runBenchmarkPreregV1.ts', import.meta.url), 'utf8');
  // The plan lock lives in the database every copy shares (not tmpdir):
  // same snapshot hash, any directory, any host on that database.
  assert.match(
    script,
    /activeBenchmarkPlanLock = await acquireBenchmarkPlanLock\(db, snapshot\.snapshotHash\)/
  );
  const releaseBody = script.slice(
    script.indexOf('async function releaseActiveBenchmarkExecutionLock'),
    script.indexOf('async function main')
  );
  assert.match(releaseBody, /activeBenchmarkExecutionLock\?\.release\(\)/);
  assert.match(releaseBody, /await activeBenchmarkPlanLock\?\.release\(\)/);
});

test('release never deletes a replacement lock', () => {
  const outDir = freshDir();
  const lockPath = lockFilePathForOutputDir(outDir);
  const holder = acquireBenchmarkExecutionLock(outDir);
  // Same-inode content swap (truncate-in-place keeps the inode): the
  // re-verification before removal must refuse instead of deleting.
  const swapped = serializeBenchmarkExecutionLock({ pid: process.pid, token: 'foreign-live', startedAt: new Date().toISOString() });
  writeFileSync(lockPath, swapped);
  assert.equal(holder.release(), false);
  assert.equal(readFileSync(lockPath, 'utf8'), swapped);
  // New-inode replacement (delete + rewrite) is likewise preserved.
  unlinkSync(lockPath);
  const replaced = serializeBenchmarkExecutionLock({ pid: process.pid, token: 'foreign-live-2', startedAt: new Date().toISOString() });
  writeFileSync(lockPath, replaced);
  assert.equal(holder.release(), false);
  assert.equal(readFileSync(lockPath, 'utf8'), replaced);
});

test('commit and inspect agree on command-identity verdicts', () => {
  // A live pid running a foreign command reads as stale at inspect time;
  // commit must reach the same verdict through the same check (not pid-only)
  // and remove only that verified instance. Skipped where /proc is
  // unavailable (the pid-only fallback then governs by design).
  if (readProcCmdline(process.pid) === null) {
    console.log('SKIP: /proc unavailable; command-identity coherence needs Linux procfs');
    return;
  }
  const outDir = freshDir();
  const lockPath = lockFilePathForOutputDir(outDir);
  writeFileSync(
    lockPath,
    serializeBenchmarkExecutionLock({ pid: process.pid, token: 'foreign-cmd', startedAt: new Date().toISOString(), argv: 'something-else-entirely' })
  );
  const inspection = inspectStaleLock(lockPath, 'coherence');
  if (inspection.outcome !== 'recoverable') assert.fail('foreign command on a live pid must read as stale');
  assert.equal(inspection.recovery.commit(), 'removed');
  assert.equal(existsSync(lockPath), false);
});
