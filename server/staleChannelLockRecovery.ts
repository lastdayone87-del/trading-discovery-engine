import type { ScanStatus } from '../src/types';

/** A channel lock is only abandoned after a generous grace period. Long
 * inspections are still protected by their live PROCESSING job; this age bound
 * covers legacy/search-worker paths that do not carry a per-channel job id. */
export const STALE_CHANNEL_LOCK_AFTER_MINUTES = 60;

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
  return nowMs - updatedAtMs >= staleAfterMinutes * 60_000;
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
