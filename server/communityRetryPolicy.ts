import assert from 'node:assert/strict';
import { assessCrawlAdmission, isAuxiliaryForOutcome, acquisitionOwnershipUrl } from './communitySurfacePolicy';

export const COMMUNITY_ACQUISITION_CAPACITY_UNAVAILABLE = 'COMMUNITY_ACQUISITION_CAPACITY_UNAVAILABLE';
/** Generic retry code for real inspection work that must run again without
 * being a capacity deferral. It is deliberately not attempt-free: the prior
 * inspection executed acquisition work (or must validate a stored locator),
 * so each durable attempt consumes budget. */
export const COMMUNITY_ACQUISITION_REQUIRED = 'COMMUNITY_ACQUISITION_REQUIRED';

export const COMMUNITY_RETRY_REASON = {
  NO_SURFACE: 'NO_SURFACE',
  BROWSER_RUNTIME_UNAVAILABLE: 'BROWSER_RUNTIME_UNAVAILABLE',
  COMMUNITY_REQUIRED_ACQUISITION_FAILURE: 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE',
  UPSTREAM_REQUIRED_ACQUISITION_FAILURE: 'UPSTREAM_REQUIRED_ACQUISITION_FAILURE'
} as const;

export type CommunityRetryReason = typeof COMMUNITY_RETRY_REASON[keyof typeof COMMUNITY_RETRY_REASON];
export type CommunityRetryReconciliationStatus = 'NONE' | 'RECONCILIATION_REQUIRED';
export type CommunityRetrySource = 'INSPECTION' | 'RECOVERY' | 'LEGACY';

export interface CommunityRetryObservation {
  required?: boolean;
  surface?: string;
  outcome: string;
  retryable: boolean;
  retryAt?: number;
  failureClass?: string;
  requestedUrl?: string;
  rootUrl?: string;
  relevanceTier?: string;
  telemetry?: {
    pagesInspected?: unknown;
    requestsStarted?: unknown;
    redirectsFollowed?: unknown;
  };
}

export interface CommunityRetryDirective {
  /**
   * Channel-level accounting: an attempt-free directive schedules a durable
   * retry without incrementing the channel's `scan_attempts`. This does NOT
   * decide job-level execution accounting — the retry worker grants
   * attempt-free *execution* (claim increment undone) only when `retryReason`
   * is BROWSER_RUNTIME_UNAVAILABLE, i.e. every retry-owning failure proves no
   * acquisition work started. Genuine failures consume one job attempt each.
   */
  attemptFree: boolean;
  code: string;
  retryAt?: number;
  reason: string;
  retryReason: CommunityRetryReason;
  /** Per-seed rendered click-window progress durably carried into the next
   * retry. Keys are normalized seed URLs; values count controls already
   * examined. Omitted when no rendered window progressed. */
  clickOffsets?: Record<string, number>;
}

export interface CommunityRetryJobMetadata {
  retryLifecycleVersion: 2;
  retryReason: CommunityRetryReason;
  retryCode: string;
  retrySource: CommunityRetrySource;
  retryObservedAt: string;
  reconciliationStatus: CommunityRetryReconciliationStatus;
  reconciliationReason?: string;
  reconciliationObservedAt?: string;
  /** Durable per-seed click-window progress (see CommunityRetryDirective). */
  clickOffsets?: Record<string, number>;
  reconciliationHistory?: Array<{
    status: CommunityRetryReconciliationStatus;
    reason: string;
    observedAt: string;
  }>;
}

const ATTEMPT_FREE_CODES = new Set([
  'COMMUNITY_ACQUISITION_CAPACITY_UNAVAILABLE',
  'BROWSER_RUNTIME_UNAVAILABLE',
  'BROWSER_BINARY_MISSING',
  'BROWSER_LINUX_DEPENDENCY_MISSING',
  'BROWSER_PERMISSION_DENIED',
  'BROWSER_LAUNCH_FAILED',
  'YOUTUBE_PROVIDERS_COOLING_DOWN',
  'YOUTUBE_PROVIDER_POOL_EXHAUSTED',
  'YOUTUBE_RUNTIME_RATE_PRESSURE',
  'YOUTUBE_RECENT_VIDEO_ACQUISITION_FAILED',
  'PROVIDER_COOLDOWN',
  'PROVIDER_CONCURRENCY_CAP_EXCEEDED',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

const ATTEMPT_FREE_CLASSES = new Set(['TIMEOUT', 'RATE_LIMIT', 'TRANSIENT', 'CREDENTIALS_EXHAUSTED']);
const BROWSER_RUNTIME_FAILURES = new Set([
  'BROWSER_BINARY_MISSING',
  'BROWSER_LINUX_DEPENDENCY_MISSING',
  'BROWSER_PERMISSION_DENIED',
  'BROWSER_LAUNCH_FAILED',
  'BROWSER_RUNTIME_UNAVAILABLE',
  // Browser-gate saturation rejects the crawl before admission: no acquisition
  // work started. Classified here (not via browser-capability marking, which
  // stays healthy) so saturation defers attempt-free like other capacity.
  'RENDERED_FALLBACK_SATURATED'
]);

export function isBrowserRuntimeFailureClass(value: unknown): boolean {
  return BROWSER_RUNTIME_FAILURES.has(String(value || '').toUpperCase());
}

const UPSTREAM_ACQUISITION_SURFACES = new Set([
  'YOUTUBE_ABOUT',
  'RECENT_VIDEO_DESCRIPTIONS',
]);

/**
 * Surface-aware retry attribution (PR #434 item 7). Browser/runtime crashes
 * are operationally distinct; YouTube About / recent-video-description
 * acquisition failures are upstream YouTube failures; everything else —
 * creator websites, social profiles, channel external links, Discord
 * validation — is a community-owned acquisition failure. The `surface`
 * parameter is optional for backward compatibility: an unknown surface
 * classifies non-browser failures as COMMUNITY (the retryable acquisition
 * surface set is community-owned by default; upstream must be proven by
 * surface, never assumed by default).
 */
export function surfaceAwareRetryReason(surface: unknown, failureClass: unknown): CommunityRetryReason {
  if (isBrowserRuntimeFailureClass(failureClass)) {
    return COMMUNITY_RETRY_REASON.BROWSER_RUNTIME_UNAVAILABLE;
  }
  if (UPSTREAM_ACQUISITION_SURFACES.has(String(surface || ''))) {
    return COMMUNITY_RETRY_REASON.UPSTREAM_REQUIRED_ACQUISITION_FAILURE;
  }
  return COMMUNITY_RETRY_REASON.COMMUNITY_REQUIRED_ACQUISITION_FAILURE;
}

export function retryReasonForFailureClass(failureClass: unknown, surface?: unknown): CommunityRetryReason {
  if (surface === undefined) {
    return isBrowserRuntimeFailureClass(failureClass)
      ? COMMUNITY_RETRY_REASON.BROWSER_RUNTIME_UNAVAILABLE
      : COMMUNITY_RETRY_REASON.COMMUNITY_REQUIRED_ACQUISITION_FAILURE;
  }
  return surfaceAwareRetryReason(surface, failureClass);
}

export function retryReasonFromError(error: any, surface?: unknown): CommunityRetryReason {
  return retryReasonForFailureClass(error?.code ?? error?.errorClass ?? error?.cause?.code ?? error?.cause?.errorClass, surface);
}

export function buildCommunityRetryJobMetadata(args: {
  code: string;
  retryReason: CommunityRetryReason;
  retrySource?: CommunityRetrySource;
  observedAt?: string;
  clickOffsets?: Record<string, number>;
}): CommunityRetryJobMetadata {
  return {
    retryLifecycleVersion: 2,
    retryReason: args.retryReason,
    retryCode: args.code,
    retrySource: args.retrySource || 'INSPECTION',
    retryObservedAt: args.observedAt || new Date().toISOString(),
    reconciliationStatus: 'NONE',
    ...(args.clickOffsets && Object.keys(args.clickOffsets).length ? { clickOffsets: { ...args.clickOffsets } } : {})
  };
}

export function isAttemptFreeCommunityFailure(error: any): boolean {
  if (!error) return false;
  const code = String(error.code ?? error.cause?.code ?? '').toUpperCase();
  const errorClass = String(error.errorClass ?? error.cause?.errorClass ?? '').toUpperCase();
  const status = Number(error.status ?? error.statusCode ?? error.response?.status ?? error.cause?.status);
  return error.retryable === true && (
    ATTEMPT_FREE_CODES.has(code) ||
    ATTEMPT_FREE_CLASSES.has(errorClass) ||
    [408, 425, 429, 500, 502, 503, 504].includes(status)
  );
}

/**
 * Ceiling for provider-requested retry delays. Matches failJob's own backoff
 * ceiling (900s): a single Retry-After header or provider timestamp must
 * never park a retry job beyond the queue's own maximum backoff horizon.
 * Unbounded values previously produced PENDING jobs with far-future run_after
 * that read as permanently stuck at attempts=0.
 */
export const MAX_COMMUNITY_RETRY_DELAY_MS = 900_000;

export function clampRetryAtTimestamp(value: number | undefined, now = Date.now()): number | undefined {
  if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) return undefined;
  if (!Number.isFinite(value)) return now + MAX_COMMUNITY_RETRY_DELAY_MS;
  if (value <= now) return value;
  return Math.min(value, now + MAX_COMMUNITY_RETRY_DELAY_MS);
}

export function retryAtFromUnknown(error: any, now = Date.now()): number | undefined {
  const direct = Number(error?.retryAt ?? error?.cause?.retryAt);
  if (Number.isFinite(direct) && direct > 0) return clampRetryAtTimestamp(direct, now);
  const retryAfterMs = Number(error?.retryAfterMs ?? error?.cause?.retryAfterMs);
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) return clampRetryAtTimestamp(now + retryAfterMs, now);
  return undefined;
}

/**
 * Failure classes that are deterministically permanent under the existing
 * acquisition model: refetching the same URL cannot change the outcome, so
 * they must never own community retry work. Narrow by design — transient
 * failures (network failures, timeouts, 429s, 5xx/transient HTTP, browser
 * runtime/capacity classes) are NOT in this set and stay retryable.
 */
const DETERMINISTICALLY_PERMANENT_FAILURE_CLASSES = new Set([
  'UNSUPPORTED_CONTENT_TYPE',
  // Confirmed permanent barriers are terminal: refetching the identical
  // login form / paywall cannot produce community evidence. Rate limits,
  // 403s, 999s, NO_PAGE, transient/network/bot failures stay retryable per
  // bounded policy (uncertain barrier → retryable; conclusive → terminal).
  'LOGIN_WALL',
  'PAYWALL_WALL',
  // Conclusive permanent block established over bounded identical retries
  // (see permanentBlockDetection.ts): terminal, never owns retry.
  'PERMANENT_ACCESS_BLOCK',
]);

/**
 * Static budget-gap partials that may own bounded retry when the
 * partial-static flag enables them. Independent of relevance: relevance
 * never decides retry eligibility for these rows.
 */
export const STATIC_BUDGET_GAP_FAILURE_CLASS = 'STATIC_BUDGET_GAP';

/**
 * Failure classes on FOUND rows that may still own bounded recovery: the
 * run retained invite(s) but left a retryable required gap outstanding
 * (FOUND_REQUIRED_GAP). Ordinary FOUND rows (no failure class) never retry.
 * Callers additionally apply consecutive-tail suppression by seed URL.
 * Exported so scheduler wiring uses the identical set (single source).
 */
export const FOUND_GAP_RETRYABLE_FAILURE_CLASSES = new Set([
  'REQUIRED_UNVISITED_BUDGET_GAP',
  'RENDERED_TIMEOUT',
  // Page-budget exhaustion with eligible requests still queued: the retained
  // invite is kept while the unchecked pages own bounded recovery.
  'RENDERED_BUDGET_EXPIRED',
  'RENDERED_PARTIAL_COVERAGE',
  // Interaction gap: invite(s) retained but an evidence-bearing control
  // (join button/tab/accordion) failed or was skipped, so content was never
  // examined. Unlike ordinary FOUND rows this gap owns bounded recovery.
  'RENDERED_INTERACTION_GAP',
]);

export function isCommunityRetryableObservation(item: CommunityRetryObservation): boolean {
  // Both failed and partially-inspected required community observations own
  // retries: partial coverage is recoverable/inconclusive, never a terminal
  // negative. YouTube About / recent-video-description surfaces stay upstream.
  // R6 retry boundary (narrow): candidates rejected by the crawl admission
  // gate (malformed, asset/resource) and deterministically permanent failure
  // classes never enter the retry loop — including backlog observations that
  // predate the gate. A missing requestedUrl cannot be judged and stays
  // eligible, preserving existing behavior for older callers; an explicitly
  // stored empty string is invalid input and can never own retry work.
  const requestedUrl = (item as { requestedUrl?: unknown }).requestedUrl;
  if (requestedUrl === '') return false;
  if (typeof requestedUrl === 'string' && requestedUrl) {
    try {
      if (!assessCrawlAdmission(requestedUrl).eligible) return false;
    } catch {
      return false;
    }
  }
  if (DETERMINISTICALLY_PERMANENT_FAILURE_CLASSES.has(String(item.failureClass || '').toUpperCase())) {
    return false;
  }
  // Clearly-unrelated (BLOCK) and low-value demoted (DEMOTE) tiers never
  // own retry. Independent: when the classifier is disabled, errored, or
  // missing, no observation carries either tier, so existing PR #504 behavior
  // is byte-identical. This check never makes an otherwise ineligible
  // observation eligible. Demoted static gaps stay non-owning: their bounded
  // static evidence is retained, but low-value incompleteness must not spend
  // worker retries unless existing acquisition semantics (FOUND gaps,
  // rendered required failures) genuinely require it through other rows.
  const relevanceTier = (item as { relevanceTier?: unknown }).relevanceTier;
  if (relevanceTier === 'BLOCK' || relevanceTier === 'DEMOTE') return false;
  // Auxiliary/demoted URLs (affiliate, broker, transactional, no-community
  // commerce) never own channel-level retry: their evidence is retained on
  // success and their telemetry stays in the ledger, but a failure there
  // cannot independently determine the Discord outcome or retry. Classified
  // by the shared ownership URL (requested resource, root fallback) so retry
  // ownership can never disagree with final outcome ownership.
  const ownershipUrl = acquisitionOwnershipUrl(item as { rootUrl?: unknown; requestedUrl?: unknown });
  if (ownershipUrl) {
    try {
      if (isAuxiliaryForOutcome(ownershipUrl)) return false;
    } catch {
      return false;
    }
  }
  // FOUND with an outstanding retryable required gap keeps bounded recovery
  // (multi-invite recall): the invite stays retained while the gap re-runs.
  // Ordinary FOUND rows carry no failure class and never retry.
  if (item.outcome === 'FOUND') {
    return item.required !== false &&
      item.retryable === true &&
      FOUND_GAP_RETRYABLE_FAILURE_CLASSES.has(String(item.failureClass || ''));
  }
  // Safe partial-static gaps own bounded retry even though static seeds run
  // with required=false: the ceiling truncated real coverage (queue/depth/
  // explore/response caps or truncated response), so absence is unproven.
  // Independent of relevance; existing budgets/bounds still apply, and retry
  // re-runs static first with browser escalation only per existing policy.
  if (
    item.outcome === 'PARTIALLY_INSPECTED' &&
    String(item.failureClass || '') === STATIC_BUDGET_GAP_FAILURE_CLASS &&
    item.retryable === true &&
    item.surface !== 'YOUTUBE_ABOUT' &&
    item.surface !== 'RECENT_VIDEO_DESCRIPTIONS'
  ) {
    return true;
  }
  return item.required !== false &&
    (item.outcome === 'ACQUISITION_FAILED' || item.outcome === 'PARTIALLY_INSPECTED') &&
    item.retryable &&
    item.surface !== 'YOUTUBE_ABOUT' &&
    item.surface !== 'RECENT_VIDEO_DESCRIPTIONS';
}

/**
 * Normalized ledger key for consecutive-timeout suppression matching.
 * Mirrors `normalizeSkipUrl` (trim + https fallback) so inspector seeds and
 * ledger rows meet on one key without importing the DB-backed skip module.
 */
export function timeoutSuppressionKey(rawUrl: unknown): string {
  const url = String(rawUrl || '').trim();
  if (!url) return '';
  return url.startsWith('http://') || url.startsWith('https://') ? url : `https://${url}`;
}

/**
 * Shared validation-lifecycle boundary: whether required community
 * acquisition observations own a retry (RETRY_PENDING path). All callers must
 * use this predicate instead of duplicating outcome checks, so FAILED and
 * retryable PARTIALLY_INSPECTED stay consistent across directive building and
 * validation-state projection. `timeoutSuppressedKeys` carries normalized
 * URLs whose consecutive rendered-timeout tail is exhausted (computed by the
 * inspector from loaded failure history); those observations keep their
 * outcome/status accounting and only lose retry ownership.
 */
export function hasRetryableCommunityAcquisitionFailure(
  observations: CommunityRetryObservation[],
  timeoutSuppressedKeys?: Set<string> | string[] | null,
): boolean {
  const suppressed = timeoutSuppressedKeys instanceof Set
    ? timeoutSuppressedKeys
    : new Set(timeoutSuppressedKeys || []);
  return observations.some(
    item =>
      // Eligible static budget gaps own retry despite required=false (see
      // isCommunityRetryableObservation's STATIC_BUDGET_GAP exception);
      // DEMOTE/BLOCK tiers stay excluded via the predicate itself.
      (item.required || String((item as { failureClass?: unknown }).failureClass || '') === STATIC_BUDGET_GAP_FAILURE_CLASS) &&
      isCommunityRetryableObservation(item) &&
      !suppressed.has(timeoutSuppressionKey((item as { requestedUrl?: unknown }).requestedUrl)),
  );
}

export function communityAcquisitionRetryDirective(
  observations: CommunityRetryObservation[],
  timeoutSuppressedKeys?: Set<string> | string[] | null,
): CommunityRetryDirective | undefined {
  const suppressed = timeoutSuppressedKeys instanceof Set
    ? timeoutSuppressedKeys
    : new Set(timeoutSuppressedKeys || []);
  const requiredFailures = observations.filter(
    item =>
      isCommunityRetryableObservation(item) &&
      !suppressed.has(timeoutSuppressionKey((item as { requestedUrl?: unknown }).requestedUrl)),
  );
  if (!requiredFailures.length) return undefined;
  const retryTimes = requiredFailures.map(item => Number(item.retryAt)).filter(value => Number.isFinite(value) && value > 0);
  // Attempt-free capacity classification must be unanimous over proven
  // no-start observations, never existential over bare error classes: a
  // browser-runtime failure AFTER pages were processed is executed work and
  // must consume a bounded attempt. failureClass alone cannot prove no work
  // started, so each retry-owning observation must ALSO carry zero acquisition
  // evidence (same pages/requests/redirects boundary as collapse accounting;
  // telemetry-less rows count as evidenced and consume, since absence of a
  // signal is not a signal of absence).
  const browserRuntimeUnavailable = requiredFailures.every(isProvenUnstartedCapacityObservation);
  return {
    attemptFree: true,
    code: browserRuntimeUnavailable ? 'BROWSER_RUNTIME_UNAVAILABLE' : COMMUNITY_ACQUISITION_CAPACITY_UNAVAILABLE,
    retryAt: retryTimes.length ? clampRetryAtTimestamp(Math.min(...retryTimes)) : undefined,
    reason: requiredFailures.map(item => item.failureClass || 'TRANSIENT_ACQUISITION_FAILURE').join(', '),
    retryReason: browserRuntimeUnavailable
      ? COMMUNITY_RETRY_REASON.BROWSER_RUNTIME_UNAVAILABLE
      : COMMUNITY_RETRY_REASON.COMMUNITY_REQUIRED_ACQUISITION_FAILURE
  };
}

/**
 * Capacity-only predicate: a browser-runtime/capacity failure class PLUS
 * affirmative zero-evidence telemetry (no pages inspected, no requests
 * started, no redirects followed). Either condition alone is insufficient —
 * the class without evidence could be a post-work crash, and zero evidence
 * without the class is a genuine failure — so both are required.
 */
export function isProvenUnstartedCapacityObservation(item: CommunityRetryObservation): boolean {
  if (!isBrowserRuntimeFailureClass(item.failureClass)) return false;
  const telemetry = item.telemetry;
  if (!telemetry) return false;
  return (Number(telemetry.pagesInspected) || 0) === 0
    && (Number(telemetry.requestsStarted) || 0) === 0
    && (Number(telemetry.redirectsFollowed) || 0) === 0;
}

export function attemptFreeDiscordValidation(outcome: string, retryable: boolean): boolean {
  return retryable && outcome !== 'INVALID_OBSERVED';
}

assert.equal(COMMUNITY_RETRY_REASON.NO_SURFACE, 'NO_SURFACE');
