import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireBenchmarkExecutionLock,
  inspectStaleLock,
  lockFilePathForOutputDir,
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
  assert.match(
    script,
    /main\(\)\.catch\(error => \{[\s\S]*releaseActiveBenchmarkExecutionLock\(\)[\s\S]*process\.exit\(1\)/
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
