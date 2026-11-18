/**
 * Retry policy for channels deferred because the precision adjudicator is
 * unavailable. Persistence/queueing is owned by the existing ENRICHMENT lane;
 * this module is the single source of truth for backoff and operational
 * metrics so a deferred channel cannot be retried in a hot loop or confirmed
 * while unverified.
 */
export const ADJUDICATOR_RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000,
] as const;

export interface AdjudicatorDeferralRecord {
  channelId: string;
  attempts: number;
  reason: string;
  nextRetryAt: number;
  resolvedAt?: number | null;
}

export function adjudicatorRetryDelayMs(attempts: number): number {
  const index = Math.max(0, Math.min(ADJUDICATOR_RETRY_DELAYS_MS.length - 1, Math.floor(attempts) - 1));
  return ADJUDICATOR_RETRY_DELAYS_MS[index];
}

export function nextAdjudicatorRetryAt(attempts: number, now: number = Date.now()): number {
  return now + adjudicatorRetryDelayMs(attempts);
}

export interface AdjudicatorDeferralMetrics {
  total: number;
  due: number;
  resolved: number;
  oldestAgeMs: number;
  maxAttempts: number;
  byReason: Record<string, number>;
}

export function summarizeAdjudicatorDeferrals(
  records: AdjudicatorDeferralRecord[],
  now: number = Date.now(),
): AdjudicatorDeferralMetrics {
  let due = 0;
  let resolved = 0;
  let oldestAgeMs = 0;
  let maxAttempts = 0;
  const byReason: Record<string, number> = {};
  for (const record of records) {
    byReason[record.reason] = (byReason[record.reason] || 0) + 1;
    maxAttempts = Math.max(maxAttempts, record.attempts);
    if (record.resolvedAt) {
      resolved += 1;
      continue;
    }
    if (record.nextRetryAt <= now) due += 1;
    oldestAgeMs = Math.max(oldestAgeMs, Math.max(0, now - record.nextRetryAt));
  }
  return { total: records.length, due, resolved, oldestAgeMs, maxAttempts, byReason };
}
