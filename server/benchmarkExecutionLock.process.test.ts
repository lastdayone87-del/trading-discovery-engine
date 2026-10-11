import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireBenchmarkExecutionLock,
  lockFilePathForOutputDir,
  serializeBenchmarkExecutionLock,
} from './benchmarkExecutionLock';

// Cross-process lock contention: every contender below is a real OS process
// (separate pid and memory), sequenced deterministically over IPC — no
// sleeps, no shared event loop. In-process interleavings are covered by
// benchmarkExecutionLock.test.ts; these prove the same guarantees hold
// across the actual failure domain (separate processes on one host).

const children: ChildProcess[] = [];
after(() => {
  for (const child of children) {
    try {
      child.kill('SIGKILL');
    } catch { /* already gone */ }
  }
});

interface Reply {
  id?: number;
  ready?: boolean;
  ok?: boolean;
  token?: string;
  outcome?: string;
  result?: string;
  released?: boolean;
  error?: string;
  message?: string;
}

class Contender {
  private child: ChildProcess;
  private seq = 0;
  private waiting = new Map<number, (reply: Reply) => void>();
  private ready: Promise<void>;

  private constructor(child: ChildProcess) {
    this.child = child;
    // Single lifetime router: readiness and all call replies flow through
    // it. It must stay registered for the child's life (removing it after
    // readiness would orphan every later reply).
    const onMessage = (raw: unknown) => {
      const msg = raw as Reply;
      if (msg && msg.ready === true && msg.id === undefined) {
        this.markReady();
        return;
      }
      if (msg && typeof msg.id === 'number') {
        const settle = this.waiting.get(msg.id);
        if (settle) {
          this.waiting.delete(msg.id);
          settle(msg);
        }
      }
    };
    child.on('message', onMessage);
    child.on('error', (error) => {
      for (const settle of this.waiting.values()) settle({ ok: false, error: String(error) });
      this.waiting.clear();
      this.markReadyFailed(error);
    });
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('contender failed to start')), 60000);
      this.readySettle = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      };
    });
  }

  private readySettle: { resolve: () => void; reject: (error: unknown) => void } | null = null;

  private markReady(): void {
    this.readySettle?.resolve();
    this.readySettle = null;
  }

  private markReadyFailed(error: unknown): void {
    this.readySettle?.reject(error instanceof Error ? error : new Error(String(error)));
    this.readySettle = null;
  }

  static async spawn(): Promise<Contender> {
    const child = fork(new URL('./benchmarkLockChild.ts', import.meta.url));
    children.push(child);
    const contender = new Contender(child);
    await contender.ready;
    return contender;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  call(message: Record<string, unknown>, timeoutMs = 30000): Promise<Reply> {
    const id = ++this.seq;
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`contender call timed out: ${JSON.stringify(message)}`));
      }, timeoutMs);
      this.waiting.set(id, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      this.child.send?.({ id, ...message });
    });
  }

  async stop(): Promise<void> {
    try {
      this.child.send?.({ cmd: 'exit' });
    } catch { /* already gone */ }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5000);
      this.child.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    try {
      this.child.kill('SIGKILL');
    } catch { /* already gone */ }
  }

  async exitedPid(): Promise<number> {
    const pid = this.child.pid;
    assert.ok(pid);
    await this.stop();
    return pid;
  }
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'bench-execution-lock-proc-'));
}

test('stale takeover race across processes yields one holder', async () => {
  // B (child) inspects a dead lock and pauses holding the intent; A
  // (parent) completes recovery and holds a live lock; B resumes. All
  // sequencing is IPC-driven; pids are real and distinct.
  const outDir = freshDir();
  const lockPath = lockFilePathForOutputDir(outDir);
  const grave = await Contender.spawn();
  const deadPid = await grave.exitedPid();
  writeFileSync(
    lockPath,
    serializeBenchmarkExecutionLock({ pid: deadPid, token: 'stale-owner', startedAt: '2026-01-01T00:00:00.000Z' })
  );
  const contenderB = await Contender.spawn();
  assert.notEqual(contenderB.pid, process.pid);
  const inspected = await contenderB.call({ cmd: 'inspect', lockPath, tag: 'proc-B', key: 'b-intent' });
  assert.equal(inspected.outcome, 'recoverable');
  const holderA = acquireBenchmarkExecutionLock(outDir);
  holderA.assertOwned();
  const liveBytes = readFileSync(lockPath, 'utf8');
  assert.ok(!liveBytes.includes('stale-owner'));
  const committed = await contenderB.call({ cmd: 'commit', key: 'b-intent' });
  assert.equal(committed.ok, true);
  assert.equal(committed.result, 'changed');
  assert.equal(readFileSync(lockPath, 'utf8'), liveBytes);
  holderA.assertOwned();
  assert.equal(holderA.release(), true);
  await contenderB.stop();
});

test('barrier race across processes elects exactly one holder', async () => {
  // Five contenders race one atomic claim; the assertions (exactly one
  // winner, every loser refused, file matches the winner) are deterministic
  // regardless of interleaving. One environmental caveat, documented not
  // hidden: this host's filesystem (f2fs bind mount under parallel
  // hard-link churn) sporadically returns EPERM from racing stat/unlink
  // calls — verified with a logic-free raw-syscall stress (10-28 EPERM per
  // 1200 ops, zero application code involved). A round that hits EPERM is
  // discarded and retried (bounded); assertion failures never retry, so a
  // genuine protocol violation still fails loudly.
  let winners: Reply[] = [];
  let refused: Reply[] = [];
  let elected = '';
  for (let round = 0; round < 3; round++) {
    const outDir = freshDir();
    const contenders = await Promise.all(
      Array.from({ length: 5 }, () => Contender.spawn())
    );
    const pids = new Set(contenders.map(contender => contender.pid));
    assert.equal(pids.size, 5);
    try {
      const results = await Promise.all(
        contenders.map(contender => contender.call({ cmd: 'acquire', outDir }))
      );
      winners = results.filter(result => result.ok === true);
      refused = results.filter(result => result.ok !== true);
      assert.equal(winners.length, 1);
      assert.equal(refused.length, 4);
      for (const loser of refused) {
        assert.match(String(loser.error || ''), /BENCHMARK_EXECUTION_LOCK_HELD/);
      }
      const current = JSON.parse(readFileSync(lockFilePathForOutputDir(outDir), 'utf8')) as { token: string };
      assert.equal(current.token, winners[0].token);
      elected = outDir;
      for (const contender of contenders) {
        await contender.stop();
      }
      break;
    } catch (error) {
      for (const contender of contenders) {
        await contender.stop();
      }
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('EPERM') || round === 2) throw error;
    }
  }
  assert.ok(elected, 'a clean barrier round must complete within the retry budget');
});

test('live holder blocks contender processes; release unblocks them', async () => {
  const outDir = freshDir();
  const holder = acquireBenchmarkExecutionLock(outDir);
  const contender = await Contender.spawn();
  const refused = await contender.call({ cmd: 'acquire', outDir });
  assert.equal(refused.ok, false);
  assert.match(String(refused.error || ''), /BENCHMARK_EXECUTION_LOCK_HELD/);
  assert.equal(holder.release(), true);
  const second = await contender.call({ cmd: 'acquire', outDir, key: 'second' });
  assert.equal(second.ok, true);
  const released = await contender.call({ cmd: 'release', key: 'second' });
  assert.equal(released.released, true);
  await contender.stop();
});

test('stale lock with a genuinely dead child pid is recoverable across processes', async () => {
  const outDir = freshDir();
  const lockPath = lockFilePathForOutputDir(outDir);
  const grave = await Contender.spawn();
  const deadPid = await grave.exitedPid();
  writeFileSync(
    lockPath,
    serializeBenchmarkExecutionLock({ pid: deadPid, token: 'stale-owner', startedAt: '2026-01-01T00:00:00.000Z' })
  );
  const contender = await Contender.spawn();
  const acquired = await contender.call({ cmd: 'acquire', outDir, key: 'stale-takeover' });
  assert.equal(acquired.ok, true);
  const current = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: number };
  assert.equal(current.pid, contender.pid);
  const owned = await contender.call({ cmd: 'assertOwned', key: 'stale-takeover' });
  assert.equal(owned.ok, true);
  await contender.stop();
});
