import { randomUUID } from 'node:crypto';
import { closeSync, linkSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Cross-process mutual exclusion for benchmark --execute runs sharing one
 * output directory (see docs/operations-capacity-defaults.md). The contested
 * resource (execution-record.json) is filesystem-local, so the lock is a
 * lock file claimed atomically — no database coupling, and a crashed holder
 * needs no external reaper.
 *
 * Safety properties:
 * - Claim uses link(2): exactly one contender wins, even across processes.
 * - Release verifies the random token first and never throws: cleanup can
 *   never remove another process's lock.
 * - A stale lock is taken over ONLY when its owner pid is confirmed dead
 *   (never merely because it is old). A recycled pid can only cause a
 *   fail-closed refusal, never a stolen live lock.
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
 * Acquire the outDir execution lock exclusively. Throws
 * BENCHMARK_EXECUTION_LOCK_HELD when another live process holds it — before
 * the caller may mutate the record or schedule work. Stale locks (owner pid
 * confirmed dead) are taken over via atomic re-link, so an interrupted
 * IN_PROGRESS run stays resumable and is never permanently blocked.
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
        return {
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
        };
      } catch (linkError) {
        if ((linkError as NodeJS.ErrnoException | null)?.code !== 'EEXIST') throw linkError;
        const current = readLockInfo(lockPath);
        if (current && !pidAlive(current.pid)) {
          // Stale: owner confirmed dead. Unlink, then re-race the atomic
          // link — a co-racing contender that wins is observed as a live
          // owner on the next read, never as a second holder.
          try {
            unlinkSync(lockPath);
          } catch {
            /* lost the race or already gone; re-read below */
          }
          continue;
        }
        throw lockHeldError(current);
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
