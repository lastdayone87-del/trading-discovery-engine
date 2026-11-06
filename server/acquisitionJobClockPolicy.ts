/**
 * Phase 0 job-clock policy.
 *
 * Capacity/runtime waits are not genuine acquisition failures. They must not
 * consume the retryable-failure age budget, and renewing them must never write
 * the queue clocks or the failure-budget anchor. This module stays pure so the
 * clock semantics can be tested without a database or worker runtime.
 */

export const ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV = 'ACQUISITION_JOB_CLOCK_V2_ENABLED';

/** Capacity/runtime waits renew on the same five-hour horizon as before. */
export const CAPACITY_LEASE_DURATION_MS = 5 * 60 * 60_000;

/**
 * Failures that mean "the work could not be admitted or the acquisition
 * runtime was unavailable", not "the acquisition work ran and failed".
 * Provider/network transients remain genuine failures and keep the existing
 * six-hour failure-age ceiling.
 */
const ALWAYS_CAPACITY_CODES = new Set([
  'YOUTUBE_KEY_CAP_EXCEEDED',
  'YOUTUBE_KEY_CAP_UNAVAILABLE',
  'QUOTA_ALLOCATION_EXHAUSTED',
]);

const RETRYABLE_CAPACITY_CODES = new Set([
  'COMMUNITY_ACQUISITION_CAPACITY_UNAVAILABLE',
  'RENDERED_FALLBACK_SATURATED',
  'BROWSER_RUNTIME_UNAVAILABLE',
  'BROWSER_BINARY_MISSING',
  'BROWSER_LINUX_DEPENDENCY_MISSING',
  'BROWSER_PERMISSION_DENIED',
  'BROWSER_LAUNCH_FAILED',
]);

const ENRICHMENT_CAPACITY_MESSAGE_FRAGMENT = 'enrichment youtube quota allocation is exhausted';
const COMMUNITY_DEFERRAL_MESSAGE_PREFIX = 'community acquisition deferred:';

/**
 * Default-off rollout switch. The old behavior stays in place until an
 * operator explicitly enables the clock semantics for a canary.
 */
export function acquisitionJobClockV2Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env[ACQUISITION_JOB_CLOCK_V2_ENABLED_ENV] || '').trim().toLowerCase() === 'true';
}

export function isCapacityLeaseFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    code?: unknown;
    message?: unknown;
    retryable?: unknown;
    cause?: { code?: unknown; message?: unknown; retryable?: unknown };
  };
  const code = String(candidate.code ?? candidate.cause?.code ?? '').toUpperCase();
  if (ALWAYS_CAPACITY_CODES.has(code)) return true;
  const message = String(candidate.message ?? candidate.cause?.message ?? '').toLowerCase();
  // The queue only constructs this deferral after proving no acquisition work
  // started, so the prefix is authoritative even before the code check.
  if (message.includes(COMMUNITY_DEFERRAL_MESSAGE_PREFIX)) return true;
  if (message.includes(ENRICHMENT_CAPACITY_MESSAGE_FRAGMENT)) return true;
  // A raw browser failure is capacity only when the producer marked it
  // retryable/attempt-free. A post-inspection browser crash consumes budget.
  const retryable = candidate.retryable === true || candidate.cause?.retryable === true;
  return retryable && RETRYABLE_CAPACITY_CODES.has(code);
}

/**
 * Genuine failures retain their first-failure anchor. Capacity/runtime waits
 * deliberately do not receive one, so a later lease renewal cannot reset a
 * real failure's age and the wait itself cannot age into a false terminal.
 */
export function shouldChargeFailureBudget(error: unknown): boolean {
  return !isCapacityLeaseFailure(error);
}

/** Queue FIFO age switches only when the rollout switch is enabled. */
export function claimQueueAgeOrderColumn(env: NodeJS.ProcessEnv = process.env): 'first_enqueued_at' | 'created_at' {
  return acquisitionJobClockV2Enabled(env) ? 'first_enqueued_at' : 'created_at';
}

export function claimOrderByClause(env: NodeJS.ProcessEnv = process.env): string {
  return `priority DESC,${claimQueueAgeOrderColumn(env)} ASC`;
}

/**
 * Capacity waits renew only these bookkeeping fields. Deliberately absent:
 * `created_at`, `run_after`, `attempts`, and `first_transient_failure_at`.
 * A renewal therefore cannot re-age the queue or reset a genuine failure.
 */
export function capacityLeaseRefreshSetSql(durationParameter: string): string {
  return `capacity_lease_started_at=COALESCE(capacity_lease_started_at,now()),`
    + `capacity_lease_expires_at=now()+(${durationParameter}||' milliseconds')::interval,`
    + `capacity_lease_renewed_at=CASE WHEN capacity_lease_started_at IS NULL THEN NULL ELSE now() END,`
    + `capacity_lease_renewals=capacity_lease_renewals+CASE WHEN capacity_lease_started_at IS NULL THEN 0 ELSE 1 END,`
    + `updated_at=now()`;
}

/**
 * Reopen clock bookkeeping appended to enqueueJob's upsert. Flag-off returns
 * the empty string so the deployed SQL remains byte-for-byte the legacy path.
 */
export function reopenClockUpdateSql(enabled: boolean): string {
  if (!enabled) return '';
  const reopened = `jobs.status IN ('COMPLETED','FAILED')`;
  return `,last_enqueued_at=CASE WHEN ${reopened} THEN now() ELSE jobs.last_enqueued_at END`
    + `,reopen_generation=CASE WHEN ${reopened} THEN jobs.reopen_generation+1 ELSE jobs.reopen_generation END`
    + `,last_reopened_at=CASE WHEN ${reopened} THEN now() ELSE jobs.last_reopened_at END`;
}

/**
 * Retry schedule for a capacity/runtime wait that did not run acquisition
 * work. Mirrors the legacy deferred schedule but never depends on the
 * genuine-failure anchor.
 *
 * Provider hints are bounded: ordinary capacity waits cap at the queue's
 * fifteen-minute backoff ceiling, while quota-allocation/key-cap waits may
 * honor the next Pacific reset (at most 24 hours). Non-finite or past hints
 * fall back to exponential backoff so they can never throw while persisting
 * run_after or park work indefinitely.
 */
export const MAX_CAPACITY_LEASE_RETRY_DELAY_MS = 15 * 60_000;
export const MAX_QUOTA_WAIT_DELAY_MS = 24 * 60 * 60_000;

export function isQuotaCapacityFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; message?: unknown; cause?: { code?: unknown; message?: unknown } };
  const code = String(candidate.code ?? candidate.cause?.code ?? '').toUpperCase();
  if (code === 'QUOTA_ALLOCATION_EXHAUSTED'
    || code === 'YOUTUBE_KEY_CAP_EXCEEDED'
    || code === 'YOUTUBE_KEY_CAP_UNAVAILABLE') return true;
  const message = String(candidate.message ?? candidate.cause?.message ?? '').toLowerCase();
  return message.includes(ENRICHMENT_CAPACITY_MESSAGE_FRAGMENT);
}

export function normalizeCapacityLeaseRunAfter(
  error: unknown,
  candidate: number | undefined,
  attempts: number,
  now = Date.now(),
): number {
  const fallback = now + Math.min(15 * 60_000, 30_000 * Math.pow(2, Math.max(0, attempts - 1)));
  if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate <= now) return fallback;
  const maxDelay = isQuotaCapacityFailure(error) ? MAX_QUOTA_WAIT_DELAY_MS : MAX_CAPACITY_LEASE_RETRY_DELAY_MS;
  return Math.min(candidate, now + maxDelay);
}

export function capacityLeaseRunAfter(error: unknown, attempts: number, now = Date.now()): number {
  const candidate = error as { retryAt?: unknown; retryAfterMs?: unknown } | null | undefined;
  const retryAt = Number(candidate?.retryAt);
  const retryAfterMs = Number(candidate?.retryAfterMs);
  const hint = Number.isFinite(retryAt) && retryAt > now
    ? retryAt
    : Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? now + retryAfterMs
      : undefined;
  return normalizeCapacityLeaseRunAfter(error, hint, attempts, now);
}
