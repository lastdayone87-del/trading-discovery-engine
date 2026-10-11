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
 * - Stale takeover is phased: inspectStaleLock() pins the exact instance
 *   (hard-link inode identity plus owner token) and proves a dead owner;
 *   commit() re-verifies path identity, token, and dead owner immediately
 *   before removing the shared name, and refuses on any change — so a
 *   contender paused across another process's recovery can never unlink the
 *   replacement live lock. Takeover never triggers merely because a lock is
 *   old. A recycled pid can only cause a fail-closed refusal, never a
 *   stolen live lock.
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
 * Phased stale-lock takeover. Inspection and removal are separate steps so
 * the dangerous interleaving — inspect a dead lock, pause, then unlink a
 * replacement live lock — is structurally impossible to complete silently:
 * commit() re-verifies path identity, owner token, and dead owner against
 * the inspected instance, and refuses on any change.
 */
export interface PendingStaleRecovery {
  readonly lockPath: string;
  readonly quarantinePath: string;
  /**
   * Complete the takeover. Returns 'removed' when the shared name held the
   * inspected dead instance and was removed (caller proceeds to claim), or
   * 'changed' when the path vanished or now holds something else (caller
   * re-evaluates; never removes). Throws BENCHMARK_EXECUTION_LOCK_HELD if
   * the owner is live again (pid recycled): fail closed, path untouched.
   */
  commit(): 'removed' | 'changed';
  /** Abandon the intent: drop our quarantine link, touch nothing else. Never throws. */
  abandon(): void;
}

export type StaleLockInspection =
  | { outcome: 'recoverable'; recovery: PendingStaleRecovery }
  | { outcome: 'live'; info: BenchmarkExecutionLockInfo }
  | { outcome: 'unreadable' }
  | { outcome: 'recheck' };

/**
 * Inspect the lock on the shared path for a possible stale takeover.
 * 'recoverable' hands back a takeover intent that MUST be committed (or
 * abandoned) by the caller; every other outcome leaves the shared path
 * untouched. Quarantine tags must be unique per call (the production caller
 * mixes in a random token); reusing a tag only ever fails safe to 'recheck'.
 */
export function inspectStaleLock(lockPath: string, quarantineTag: string): StaleLockInspection {
  let pathStat;
  try {
    pathStat = statSync(lockPath);
  } catch {
    return { outcome: 'recheck' }; // Vanished; caller retries the claim.
  }
  const current = readLockInfo(lockPath);
  if (!current) return { outcome: 'unreadable' }; // Fail closed; never remove.
  const quarantinePath = `${lockPath}.quar-${process.pid}-${quarantineTag}`;
  try {
    linkSync(lockPath, quarantinePath);
  } catch {
    return { outcome: 'recheck' }; // Vanished (or tag reused); caller retries.
  }
  const dropQuarantine = () => {
    try {
      unlinkSync(quarantinePath);
    } catch { /* best effort */ }
  };
  const quarantineStat = statSync(quarantinePath);
  const isolated = readLockInfo(quarantinePath);
  if (
    quarantineStat.ino !== pathStat.ino ||
    quarantineStat.dev !== pathStat.dev ||
    !isolated ||
    isolated.token !== current.token ||
    isolated.pid !== current.pid
  ) {
    dropQuarantine();
    return { outcome: 'recheck' }; // Replaced mid-inspection; re-evaluate fresh.
  }
  if (pidAlive(current.pid)) {
    dropQuarantine();
    return { outcome: 'live', info: current }; // Live owner; shared path untouched.
  }
  const inspected = { ino: pathStat.ino as number, dev: pathStat.dev as number, token: current.token, pid: current.pid };
  return {
    outcome: 'recoverable',
    recovery: {
      lockPath,
      quarantinePath,
      commit(): 'removed' | 'changed' {
        try {
          // Re-verify at commit time: the path must still hold the exact
          // inspected instance and its owner must still be dead. A pid that
          // came alive again (recycled) fails closed here, path untouched.
          const restat = statSync(lockPath);
          const latest = readLockInfo(lockPath);
          if (
            restat.ino !== inspected.ino ||
            restat.dev !== inspected.dev ||
            !latest ||
            latest.token !== inspected.token ||
            latest.pid !== inspected.pid
          ) {
            return 'changed';
          }
          if (pidAlive(latest.pid)) throw lockHeldError(latest);
          try {
            unlinkSync(lockPath);
          } catch {
            return 'changed'; // A racer removed it first; re-evaluate.
          }
          return 'removed';
        } finally {
          dropQuarantine();
        }
      },
      abandon(): void {
        dropQuarantine();
      },
    },
  };
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
        const inspection = inspectStaleLock(lockPath, `${token.slice(0, 8)}-${attempt}`);
        if (inspection.outcome === 'live') throw lockHeldError(inspection.info);
        if (inspection.outcome === 'unreadable') throw lockHeldError(null);
        if (inspection.outcome === 'recoverable') {
          // commit() re-verifies before removing; 'changed' (or a recycled
          // pid refusal, which throws) sends us back to a fresh evaluation.
          // Either way the loop's next link attempt is the atomic decider.
          inspection.recovery.commit();
        }
        // 'recheck' (or post-commit): retry the atomic claim.
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
