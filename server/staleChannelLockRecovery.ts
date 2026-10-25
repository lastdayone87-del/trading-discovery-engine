import type { ScanStatus } from '../src/types';

/** A channel lock is only abandoned after a generous grace period. Long
 * inspections are still protected by their live PROCESSING job; this age bound
 * covers legacy/search-worker paths that do not carry a per-channel job id. */
export const STALE_CHANNEL_LOCK_AFTER_MINUTES = 60;

/** Maintenance ticks run on a shared interval. A shared process-local cooldown
 * keeps the sweep off the hot path while still recovering abandoned locks
 * promptly relative to the 60-minute grace period. */
export const STALE_CHANNEL_LOCK_RECOVERY_INTERVAL_MS = 30_000;

/** Cap a single sweep so a backlog cannot monopolize a worker tick; the next
 * sweep continues where this one stopped. */
export const STALE_CHANNEL_LOCK_RECOVERY_BATCH_SIZE = 25;

function toEpochMs(value: Date | string | number | null | undefined): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/** Pure eligibility decision matching the recovery SQL. A LOCKED row is
 * recoverable only when it is past the grace period and no live PROCESSING job
 * owns the same channel id. */
export function shouldRecoverStaleChannelLock(input: {
  scanStatus: string | null | undefined;
  updatedAt: Date | string | number | null | undefined;
  hasLiveProcessingJob: boolean;
  nowMs?: number;
  staleAfterMinutes?: number;
}): boolean {
  if (input.scanStatus !== 'LOCKED') return false;
  if (input.hasLiveProcessingJob) return false;
  const updatedAtMs = toEpochMs(input.updatedAt);
  if (updatedAtMs === null) return false;
  const staleAfterMinutes = Number.isFinite(input.staleAfterMinutes)
    ? Math.max(0, Number(input.staleAfterMinutes))
    : STALE_CHANNEL_LOCK_AFTER_MINUTES;
  const nowMs = Number.isFinite(input.nowMs) ? Number(input.nowMs) : Date.now();
  // Strictly older than the grace period, matching the recovery SQL condition
  // `updated_at < now() - interval`. A lock exactly at the boundary is not yet
  // recoverable.
  return nowMs - updatedAtMs > staleAfterMinutes * 60_000;
}

/** Process-local cadence gate for the runtime recovery sweep. The first tick
 * always runs; later ticks wait for the cooldown so idle worker pools do not
 * repeat the same unbounded scan every second. */
export function shouldRunStaleChannelLockRecovery(input: {
  nowMs?: number;
  lastRunMs?: number | null;
  intervalMs?: number;
} = {}): boolean {
  const intervalMs = Number.isFinite(input.intervalMs)
    ? Math.max(0, Number(input.intervalMs))
    : STALE_CHANNEL_LOCK_RECOVERY_INTERVAL_MS;
  const nowMs = Number.isFinite(input.nowMs) ? Number(input.nowMs) : Date.now();
  const lastRunMs = input.lastRunMs;
  if (!Number.isFinite(lastRunMs)) return true;
  return nowMs - Number(lastRunMs) >= intervalMs;
}

/** Mirrors the CASE projection shared by migration 090, migration 153, and the
 * runtime recovery query. Recovered rows must preserve explicit review and
 * enrichment-pending states rather than collapsing everything to PENDING. */
export function projectRecoveredStaleChannelLockStatus(input: {
  tradingStatus: string | null | undefined;
  hasPendingEnrichment: boolean;
}): ScanStatus {
  if (input.tradingStatus === 'NEEDS_REVIEW') return 'NEEDS_REVIEW';
  if (input.tradingStatus === 'UNCERTAIN' && input.hasPendingEnrichment) return 'ENRICHMENT_PENDING';
  return 'PENDING';
}
