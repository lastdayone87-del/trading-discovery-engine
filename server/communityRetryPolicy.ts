import assert from 'node:assert/strict';

export const COMMUNITY_ACQUISITION_CAPACITY_UNAVAILABLE = 'COMMUNITY_ACQUISITION_CAPACITY_UNAVAILABLE';

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
}

export interface CommunityRetryDirective {
  attemptFree: boolean;
  code: string;
  retryAt?: number;
  reason: string;
  retryReason: CommunityRetryReason;
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
  'BROWSER_RUNTIME_UNAVAILABLE'
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
}): CommunityRetryJobMetadata {
  return {
    retryLifecycleVersion: 2,
    retryReason: args.retryReason,
    retryCode: args.code,
    retrySource: args.retrySource || 'INSPECTION',
    retryObservedAt: args.observedAt || new Date().toISOString(),
    reconciliationStatus: 'NONE'
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

export function retryAtFromUnknown(error: any, now = Date.now()): number | undefined {
  const direct = Number(error?.retryAt ?? error?.cause?.retryAt);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const retryAfterMs = Number(error?.retryAfterMs ?? error?.cause?.retryAfterMs);
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) return now + retryAfterMs;
  return undefined;
}

export function isCommunityRetryableObservation(item: CommunityRetryObservation): boolean {
  return item.required !== false &&
    item.outcome === 'ACQUISITION_FAILED' &&
    item.retryable &&
    item.surface !== 'YOUTUBE_ABOUT' &&
    item.surface !== 'RECENT_VIDEO_DESCRIPTIONS';
}

export function communityAcquisitionRetryDirective(
  observations: CommunityRetryObservation[],
): CommunityRetryDirective | undefined {
  const requiredFailures = observations.filter(isCommunityRetryableObservation);
  if (!requiredFailures.length) return undefined;
  const retryTimes = requiredFailures.map(item => Number(item.retryAt)).filter(value => Number.isFinite(value) && value > 0);
  const browserRuntimeUnavailable = requiredFailures.some(item => isBrowserRuntimeFailureClass(item.failureClass));
  return {
    attemptFree: true,
    code: browserRuntimeUnavailable ? 'BROWSER_RUNTIME_UNAVAILABLE' : COMMUNITY_ACQUISITION_CAPACITY_UNAVAILABLE,
    retryAt: retryTimes.length ? Math.min(...retryTimes) : undefined,
    reason: requiredFailures.map(item => item.failureClass || 'TRANSIENT_ACQUISITION_FAILURE').join(', '),
    retryReason: browserRuntimeUnavailable
      ? COMMUNITY_RETRY_REASON.BROWSER_RUNTIME_UNAVAILABLE
      : COMMUNITY_RETRY_REASON.COMMUNITY_REQUIRED_ACQUISITION_FAILURE
  };
}

export function attemptFreeDiscordValidation(outcome: string, retryable: boolean): boolean {
  return retryable && outcome !== 'INVALID_OBSERVED';
}

assert.equal(COMMUNITY_RETRY_REASON.NO_SURFACE, 'NO_SURFACE');
