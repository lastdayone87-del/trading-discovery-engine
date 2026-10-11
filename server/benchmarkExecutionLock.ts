import { randomUUID } from 'node:crypto';
import { closeSync, linkSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Cross-process mutual exclusion for benchmark --execute runs sharing one
 * output directory (see docs/operations-capacity-defaults.md). The contested
 * resource (execution-record.json) is filesystem-local, so the lock is a
 * lock file claimed atomically — no database coupling, and a crashed holder
 * needs no external reaper.
 *
 * Safety properties:
 * - Claim uses link(2): exactly one contender wins a fresh claim, even
 *   across processes.
 * - Release verifies the random token first and never throws: cleanup can
 *   never remove another process's lock.
 * - A stale lock is taken over ONLY when its owner pid is confirmed dead
 *   (never merely because it is old), and the shared name is removed ONLY
 *   after proving it still refers to the exact inspected instance (hard-link
 *   inode identity plus owner token, verified synchronously). A recycled pid
 *   can only cause a fail-closed refusal, never a stolen live lock.
 * - Holders re-verify ownership (assertOwned) before every critical mutation
 *   or schedule: even if a residual takeover race ever leaves two processes
 *   believing they hold the lock, only the process whose claim is current
 *   proceeds — the other aborts before touching shared state.
 */
export interface BenchmarkExecutionLockInfo {
  pid: number;
  token: string;
  startedAt: string;
}

export interface BenchmarkExecutionLock {
  readonly lockPath: string;
  readonly token: string;
  /** Release only if the file still holds our token. Never throws. */
  release(): boolean;
  /**
   * Fail closed unless the file still holds our token. Call before every
   * critical mutation or schedule: a holder that lost the lock (stolen via a
   * residual takeover race) aborts here instead of corrupting shared state.
   */
  assertOwned(): void;
}

export function lockFilePathForOutputDir(outDir: string): string {
  return join(outDir, 'execution-record.execute.lock');
}

export function serializeBenchmarkExecutionLock(info: BenchmarkExecutionLockInfo): string {
  return `${JSON.stringify(info)}\n`;
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    // ESRCH: no such process. EINVAL: pid out of range (cannot be alive).
    if (code === 'ESRCH' || code === 'EINVAL') return false;
    // EPERM (different user) and anything unexpected: assume alive so a live
    // lock is never broken. Fail-closed direction.
    return true;
  }
}

function readLockInfo(lockPath: string): BenchmarkExecutionLockInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<BenchmarkExecutionLockInfo>;
    if (typeof parsed.pid !== 'number' || typeof parsed.token !== 'string') return null;
    return { pid: parsed.pid, token: parsed.token, startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '' };
  } catch {
    return null;
  }
}

function lockHeldError(info: BenchmarkExecutionLockInfo | null): Error {
  const owner = info ? `pid=${info.pid}${info.startedAt ? ` startedAt=${info.startedAt}` : ''}` : 'unreadable';
  return new Error(
    `BENCHMARK_EXECUTION_LOCK_HELD: another --execute run holds this output directory (${owner}); ` +
      `refusing to schedule or mutate the record. Re-run after it finishes, or, if its process is dead, the next attempt recovers automatically.`
  );
}

/**
 * Attempt a safe takeover of the lock currently on the shared path. The
 * shared name is removed ONLY after proving — within one synchronous block —
 * that it still refers to the exact dead-owned instance inspected: the path
 * is pinned with an extra hard link and the inode identity plus owner token
 * are re-verified. Any replacement between inspection and removal shows up
 * as an inode/token mismatch and is re-evaluated, never removed. Throws
 * BENCHMARK_EXECUTION_LOCK_HELD for live (or unreadable) owners, leaving the
 * shared path untouched. Returns when the caller should retry its claim
 * (stale instance removed, or the path vanished/changed under inspection).
 */
function recoverStaleLockIfDead(lockPath: string, quarantineTag: string): void {
  let pathStat;
  try {
    pathStat = statSync(lockPath);
  } catch {
    return; // Vanished; caller retries the claim.
  }
  const current = readLockInfo(lockPath);
  if (!current) throw lockHeldError(null); // Unreadable: fail closed, never remove.
  const quarantinePath = `${lockPath}.quar-${process.pid}-${quarantineTag}`;
  try {
    linkSync(lockPath, quarantinePath);
  } catch {
    return; // Vanished; caller retries the claim.
  }
  try {
    const quarantineStat = statSync(quarantinePath);
    const isolated = readLockInfo(quarantinePath);
    if (
      quarantineStat.ino !== pathStat.ino ||
      quarantineStat.dev !== pathStat.dev ||
      !isolated ||
      isolated.token !== current.token ||
      isolated.pid !== current.pid
    ) {
      return; // Replaced mid-flight; re-evaluate the new instance fresh.
    }
    if (pidAlive(current.pid)) throw lockHeldError(current); // Live owner; shared path untouched.
    // Dead owner of the verified instance. Only this process knows the
    // quarantine name, so removing the shared name cannot take another
    // process's lock: any concurrent claimant must link after this removal
    // and wins the next atomic race outright.
    try {
      unlinkSync(lockPath);
    } catch {
      // A racer removed it first; caller re-evaluates whatever is there now.
    }
  } finally {
    try {
      unlinkSync(quarantinePath);
    } catch { /* best effort */ }
  }
}

/**
 * Acquire the outDir execution lock exclusively. Throws
 * BENCHMARK_EXECUTION_LOCK_HELD when another live process holds it — before
 * the caller may mutate the record or schedule work. Stale locks (owner pid
 * confirmed dead) are taken over via inode-verified removal plus atomic
 * re-link, so an interrupted IN_PROGRESS run stays resumable and is never
 * permanently blocked.
 */
export function acquireBenchmarkExecutionLock(outDir: string): BenchmarkExecutionLock {
  const lockPath = lockFilePathForOutputDir(outDir);
  const token = randomUUID();
  const startedAt = new Date().toISOString();
  const tmpPath = `${lockPath}.tmp-${process.pid}-${token.slice(0, 8)}`;
  const fd = openSync(tmpPath, 'wx');
  try {
    writeSync(fd, serializeBenchmarkExecutionLock({ pid: process.pid, token, startedAt }));
  } finally {
    try {
      closeSync(fd);
    } catch { /* best effort */ }
  }
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        linkSync(tmpPath, lockPath);
        const held: BenchmarkExecutionLock = {
          lockPath,
          token,
          release(): boolean {
            try {
              const current = readLockInfo(lockPath);
              if (!current || current.token !== token) return false;
              unlinkSync(lockPath);
              return true;
            } catch {
              return false;
            }
          },
          assertOwned(): void {
            const current = readLockInfo(lockPath);
            if (!current || current.token !== token) {
              throw new Error(
                `BENCHMARK_EXECUTION_LOCK_LOST: this process no longer holds the execution lock for ${lockPath}; ` +
                  `refusing to mutate the record or schedule work. Another execution may have taken over — it owns the run now.`
              );
            }
          },
        };
        return held;
      } catch (linkError) {
        if ((linkError as NodeJS.ErrnoException | null)?.code !== 'EEXIST') throw linkError;
        recoverStaleLockIfDead(lockPath, `${token.slice(0, 8)}-${attempt}`);
      }
    }
    throw lockHeldError(readLockInfo(lockPath));
  } finally {
    // The claim tmp is uniquely ours; remove it on every path (the live lock,
    // once linked, lives at lockPath).
    try {
      unlinkSync(tmpPath);
    } catch { /* best effort */ }
  }
}
