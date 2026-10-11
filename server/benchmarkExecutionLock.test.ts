import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireBenchmarkExecutionLock,
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
