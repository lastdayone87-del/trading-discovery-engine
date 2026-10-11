import { randomUUID } from 'node:crypto';
import { closeSync, linkSync, openSync, readFileSync, statSync, unlinkSync, writeSync, type Stats } from 'node:fs';
import { basename, join } from 'node:path';

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
  /**
   * Basename of the owner's main script, recorded at claim time. Absent on
   * lock files written before this field existed (pid-only verdict then).
   */
  argv?: string;
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

/**
 * Only ENOENT means "changed underneath us" (vanished path → retry the
 * atomic claim). Every other filesystem error is a real failure and must
 * propagate, never masquerade as contention or staleness.
 */
export function isEnoentError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

const FS_RETRY_ATTEMPTS = 10;

/**
 * Run one filesystem operation, retrying transient EPERM only. Rationale:
 * filesystems under parallel hard-link churn sporadically fail racing
 * link/stat/unlink calls with EPERM for an operation that did not happen
 * (verified with a logic-free raw-syscall stress: no application code
 * involved). Retrying is safe — every call site below either recreates the
 * same precondition or re-evaluates afterwards — while anything else,
 * including persistent EPERM, propagates unchanged (never converted into a
 * contention or staleness verdict).
 */
function attemptFs<T>(operation: () => T, attempts = FS_RETRY_ATTEMPTS): T {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return operation();
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'EPERM') throw error;
      lastError = error;
    }
  }
  throw lastError;
}

/** Reads /proc/<pid>/cmdline; null when unavailable (non-Linux, unreadable). Never throws. */
export function readProcCmdline(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8');
  } catch {
    return null;
  }
}

export type ProcCmdlineReader = (pid: number) => string | null;

/**
 * Owner liveness beyond pid reuse: a live pid counts as the lock owner only
 * when its command line still runs the recorded script. A recycled pid now
 * running something else is stale (recoverable); an unreadable command line
 * or a pre-marker lock file keeps the conservative pid-only verdict
 * (fail-closed toward refusal). The reader is injectable for deterministic
 * tests; production uses /proc.
 */
export function isLockOwnerLive(
  info: BenchmarkExecutionLockInfo,
  readCmdline: ProcCmdlineReader = readProcCmdline
): boolean {
  if (!pidAlive(info.pid)) return false;
  const marker = info.argv ?? '';
  if (!marker) return true;
  let cmdline: string | null;
  try {
    cmdline = readCmdline(info.pid);
  } catch {
    return true;
  }
  if (cmdline === null) return true;
  return cmdline.includes(marker);
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
    const parsed = JSON.parse(attemptFs(() => readFileSync(lockPath, 'utf8'))) as Partial<BenchmarkExecutionLockInfo>;
    if (typeof parsed.pid !== 'number' || typeof parsed.token !== 'string') return null;
    return {
      pid: parsed.pid,
      token: parsed.token,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
      argv: typeof parsed.argv === 'string' && parsed.argv ? parsed.argv : undefined,
    };
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
  let pathStat: Stats;
  try {
    pathStat = attemptFs(() => statSync(lockPath));
  } catch (error) {
    // Vanished: caller retries the claim. Anything else (permission, I/O)
    // is a real failure and propagates instead of masquerading as contention.
    if (!isEnoentError(error)) throw error;
    return { outcome: 'recheck' };
  }
  const current = readLockInfo(lockPath);
  if (!current) return { outcome: 'unreadable' }; // Fail closed; never remove.
  const quarantinePath = `${lockPath}.quar-${process.pid}-${quarantineTag}`;
  try {
    attemptFs(() => linkSync(lockPath, quarantinePath));
  } catch (error) {
    // Vanished, or our tag collided with our own leftover: retry. Anything
    // else propagates.
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== 'ENOENT' && code !== 'EEXIST') throw error;
    return { outcome: 'recheck' };
  }
  const dropQuarantine = () => {
    try {
      attemptFs(() => unlinkSync(quarantinePath));
    } catch { /* best effort */ }
  };
  const quarantineStat = attemptFs(() => statSync(quarantinePath));
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
  if (isLockOwnerLive(current)) {
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
        // Re-verification helper: the path still holds the exact inspected
        // instance (inode identity plus owner token/pid). ENOENT (vanished)
        // reads as absent; anything else unexpected propagates.
        const verifyCurrentInstance = (): BenchmarkExecutionLockInfo | null => {
          let restat: Stats;
          try {
            restat = attemptFs(() => statSync(lockPath));
          } catch (error) {
            if (!isEnoentError(error)) throw error;
            return null;
          }
          const instance = readLockInfo(lockPath);
          if (
            restat.ino !== inspected.ino ||
            restat.dev !== inspected.dev ||
            !instance ||
            instance.token !== inspected.token ||
            instance.pid !== inspected.pid
          ) {
            return null;
          }
          return instance;
        };
        try {
          // Re-verify at commit time: the path must still hold the exact
          // inspected instance and its owner must still be dead. A pid that
          // came alive again (recycled) fails closed here, path untouched.
          // A vanished path (a concurrent contender removed it first) is
          // 'changed', not an error: the caller retries its atomic claim
          // against whatever is there now, so removal races converge on a
          // single holder instead of aborting. Only ENOENT takes this path;
          // permission, I/O, and unexpected failures propagate.
          const latest = verifyCurrentInstance();
          if (!latest) return 'changed';
          if (isLockOwnerLive(latest)) throw lockHeldError(latest);
          // Final re-verification immediately before removal. Verification
          // and removal are separate syscalls, so a replacement landing
          // exactly between them cannot be ruled out in theory — but any
          // replacement that landed before this point (every pause an OS
          // scheduler or test can deterministically construct) refuses
          // here instead of deleting.
          if (!verifyCurrentInstance()) return 'changed';
          try {
            attemptFs(() => unlinkSync(lockPath));
          } catch (error) {
            // Only a vanished path means a racer removed it first
            // (re-evaluate whatever is there now). Permission or I/O
            // failures propagate instead of masquerading as contention.
            if (!isEnoentError(error)) throw error;
            return 'changed';
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
 * Acquire a lock file exclusively. Throws BENCHMARK_EXECUTION_LOCK_HELD when
 * another live process holds it. Stale locks (owner confirmed dead, never
 * merely old) are taken over via inode-verified removal plus atomic re-link,
 * so an interrupted run stays resumable and is never permanently blocked.
 */
export function acquireBenchmarkExecutionLock(
  lockDir: string,
  lockFileName = 'execution-record.execute.lock'
): BenchmarkExecutionLock {
  const lockPath = join(lockDir, lockFileName);
  const token = randomUUID();
  const startedAt = new Date().toISOString();
  const argv = basename(process.argv[1] ?? '');
  const tmpPath = `${lockPath}.tmp-${process.pid}-${token.slice(0, 8)}`;
  const fd = attemptFs(() => openSync(tmpPath, 'wx'));
  try {
    attemptFs(() => writeSync(fd, serializeBenchmarkExecutionLock({ pid: process.pid, token, startedAt, argv })));
  } finally {
    try {
      closeSync(fd);
    } catch { /* best effort */ }
  }
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        attemptFs(() => linkSync(tmpPath, lockPath));
        const held: BenchmarkExecutionLock = {
          lockPath,
          token,
          release(): boolean {
            // Re-verify immediately before removal: a replacement lock that
            // landed after the first read must not be deleted (same TOCTOU
            // class as stale recovery). Any failure — including a change
            // under us — reports unreleased rather than throwing, so cleanup
            // stays safe to call on every exit path.
            try {
              const current = readLockInfo(lockPath);
              if (!current || current.token !== token) return false;
              const confirm = readLockInfo(lockPath);
              if (!confirm || confirm.token !== token) return false;
              attemptFs(() => unlinkSync(lockPath));
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
      attemptFs(() => unlinkSync(tmpPath));
    } catch { /* best effort */ }
  }
}

/**
 * Planning guard: refuse to (re)write plan artifacts while a live execution
 * holds the outDir lock. Absent locks pass; stale or unreadable locks pass
 * (execution-time guards still gate, and a corrupt lock must not strand
 * planning — only a proven-live holder blocks). Used by --plan (including
 * --force); --execute has its own claim path.
 */
export function refuseActiveBenchmarkExecution(lockDir: string): void {
  // readLockInfo never throws (unreadable locks read as null): only a
  // proven-live holder blocks planning. Stale, absent, and unreadable locks
  // all pass here; execution-time guards still gate independently.
  const current = readLockInfo(lockFilePathForOutputDir(lockDir));
  if (current && isLockOwnerLive(current)) {
    throw new Error(
      `BENCHMARK_PLAN_BLOCKED_ACTIVE_EXECUTION: an --execute run holds ${lockFilePathForOutputDir(lockDir)} ` +
        `(pid=${current.pid}); refusing to replace plan artifacts an executor is using. ` +
        `Re-run --plan after it finishes.`
    );
  }
}
