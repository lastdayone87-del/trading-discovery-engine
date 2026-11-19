/**
 * Retry policy for channels deferred because the precision adjudicator is
 * unavailable. Persistence is owned by the existing ENRICH_CHANNEL lane: a
 * deferred classification enqueues the same enrichment stage with a
 * `runAfter` timestamp and the deferral fields below in the job payload. The
 * queue therefore enforces the backoff without a hot loop, and the job row is
 * the durable record used by operations metrics.
 */
export const ADJUDICATOR_DEFERRAL_REASON = 'PRECISION_ADJUDICATOR_UNAVAILABLE_DEFERRED';

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
  /** Time of the first deferral, used for the true stuck-channel age. */
  firstDeferredAt?: number;
  resolvedAt?: number | null;
}

export interface AdjudicatorDeferralPayload {
  attempts: number;
  firstDeferredAt: number;
  nextRetryAt: number;
}

export function adjudicatorRetryDelayMs(attempts: number): number {
  const index = Math.max(0, Math.min(ADJUDICATOR_RETRY_DELAYS_MS.length - 1, Math.floor(attempts) - 1));
  return ADJUDICATOR_RETRY_DELAYS_MS[index];
}

export function nextAdjudicatorRetryAt(attempts: number, now: number = Date.now()): number {
  return now + adjudicatorRetryDelayMs(attempts);
}

/**
 * Build the next retry state from the previous payload values. The first
 * deferral timestamp is preserved across retries; attempts are capped only
 * for arithmetic safety, not for the backoff index (which is already capped).
 */
export function nextAdjudicatorDeferralPayload(
  previousAttempts: unknown,
  previousFirstDeferredAt: unknown,
  now: number = Date.now(),
): AdjudicatorDeferralPayload {
  const prior = Number(previousAttempts);
  const attempts = Number.isFinite(prior) ? Math.min(10_000, Math.max(0, Math.floor(prior))) + 1 : 1;
  const first = Number(previousFirstDeferredAt);
  const firstDeferredAt = Number.isFinite(first) && first > 0 ? first : now;
  return {
    attempts,
    firstDeferredAt,
    nextRetryAt: nextAdjudicatorRetryAt(attempts, now),
  };
}

export interface AdjudicatorDeferralMetrics {
  total: number;
  due: number;
  resolved: number;
  oldestAgeMs: number;
  maxOverdueMs: number;
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
  let maxOverdueMs = 0;
  let maxAttempts = 0;
  const byReason: Record<string, number> = Object.create(null);
  for (const record of records) {
    const reason = String(record.reason || 'UNKNOWN');
    byReason[reason] = (byReason[reason] || 0) + 1;
    maxAttempts = Math.max(maxAttempts, record.attempts);
    if (record.resolvedAt != null) {
      resolved += 1;
      continue;
    }
    if (record.nextRetryAt <= now) due += 1;
    const firstDeferredAt = Number.isFinite(record.firstDeferredAt)
      ? Number(record.firstDeferredAt)
      : record.nextRetryAt;
    oldestAgeMs = Math.max(oldestAgeMs, Math.max(0, now - firstDeferredAt));
    maxOverdueMs = Math.max(maxOverdueMs, Math.max(0, now - record.nextRetryAt));
  }
  return { total: records.length, due, resolved, oldestAgeMs, maxOverdueMs, maxAttempts, byReason };
}
