/**
 * Phase 0 acquisition failure classification (shadow only).
 *
 * The legacy retry path has one coarse capacity predicate. Phase 0 needs to
 * separate three kinds of failure before any of them can change scheduling:
 *
 *   * capacity waits (quota, key caps, admission/browser-gate deferrals);
 *   * browser runtime failures (binary, dependencies, permissions, launch);
 *   * genuine acquisition failures (provider/network transients and terminals).
 *
 * This module is pure and intentionally has no database or flag dependency.
 * It never decides a retry; callers persist its result as shadow evidence and
 * keep using the existing policy predicate for the actual transition.
 */

import { isCapacityLeaseFailure, isQuotaCapacityFailure } from './acquisitionJobClockPolicy';
import {
  classifyBrowserFailure,
  isBrowserRuntimeFailure,
  type BrowserFailureClass,
} from './browserCapability';

export const ACQUISITION_FAILURE_CLASSES = [
  'CAPACITY',
  'BROWSER_RUNTIME',
  'GENUINE_FAILURE',
] as const;

export type AcquisitionFailureClass = (typeof ACQUISITION_FAILURE_CLASSES)[number];

export type AcquisitionFailureReason =
  | 'QUOTA_ALLOCATION'
  | 'YOUTUBE_KEY_CAP'
  | 'COMMUNITY_CAPACITY_DEFERRAL'
  | 'BROWSER_GATE_SATURATION'
  | 'CAPACITY_ADMISSION_UNAVAILABLE'
  | 'BROWSER_RUNTIME'
  | 'BROWSER_RUNTIME_WORK_STARTED'
  | 'RETRYABLE_INFRASTRUCTURE'
  | 'TERMINAL_OR_UNCLASSIFIED';

/**
 * Whether the failed execution produced affirmative acquisition evidence.
 * UNKNOWN is deliberately conservative: an absent telemetry signal is not
 * proof that no work started, so a browser failure without evidence is kept
 * in the browser-runtime bucket rather than promoted to an attempt-free wait.
 */
export type WorkStartedEvidence = 'UNKNOWN' | 'PROVEN_UNSTARTED' | 'PROVEN_STARTED';

export interface AcquisitionFailureEvidence {
  pagesInspected?: unknown;
  requestsStarted?: unknown;
  redirectsFollowed?: unknown;
}

export interface AcquisitionFailureClassification {
  failureClass: AcquisitionFailureClass;
  reason: AcquisitionFailureReason;
  /**
   * The legacy coarse predicate, recorded for shadow comparison only. A
   * mismatch between this value and `failureClass` is the evidence Phase 0
   * needs before changing policy.
   */
  existingCapacityLease: boolean;
  workStartedEvidence: WorkStartedEvidence;
  evidence: {
    code: string;
    retryable: boolean;
    status?: number;
    quotaSignal: boolean;
    browserFailureClass?: BrowserFailureClass;
  };
}

const BROWSER_RUNTIME_CODES = new Set([
  'BROWSER_RUNTIME_UNAVAILABLE',
  'BROWSER_BINARY_MISSING',
  'BROWSER_LINUX_DEPENDENCY_MISSING',
  'BROWSER_PERMISSION_DENIED',
  'BROWSER_LAUNCH_FAILED',
]);

const RETRYABLE_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'YOUTUBE_PROVIDERS_COOLING_DOWN',
  'YOUTUBE_PROVIDER_POOL_EXHAUSTED',
  'YOUTUBE_RUNTIME_RATE_PRESSURE',
  'YOUTUBE_RECENT_VIDEO_ACQUISITION_FAILED',
  'PROVIDER_COOLDOWN',
  'PROVIDER_CONCURRENCY_CAP_EXCEEDED',
]);

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_CLASSES = new Set(['TIMEOUT', 'CANCELLED', 'RATE_LIMIT', 'TRANSIENT', 'CREDENTIALS_EXHAUSTED']);
const QUOTA_PROVIDER_REASONS = new Set(['quotaexceeded', 'dailylimitexceeded']);

interface FailureFields {
  code: string;
  message: string;
  retryable: boolean;
  status?: number;
  quotaSignal: boolean;
  name: string;
  errorClass: string;
}

function readFailureFields(error: unknown): FailureFields {
  const candidate = error && typeof error === 'object'
    ? error as {
      code?: unknown;
      message?: unknown;
      retryable?: unknown;
      status?: unknown;
      statusCode?: unknown;
      response?: { status?: unknown };
      quotaExceeded?: unknown;
      providerReasons?: unknown;
      name?: unknown;
      errorClass?: unknown;
      cause?: {
        code?: unknown;
        message?: unknown;
        retryable?: unknown;
        status?: unknown;
        statusCode?: unknown;
        errorClass?: unknown;
      };
    }
    : undefined;
  const cause = candidate?.cause;
  const code = String(candidate?.code ?? cause?.code ?? '').toUpperCase();
  const message = String(candidate?.message ?? cause?.message ?? error ?? '').toLowerCase();
  const statusValue = Number(
    candidate?.status
    ?? candidate?.statusCode
    ?? candidate?.response?.status
    ?? cause?.status
    ?? cause?.statusCode,
  );
  const providerReasons = Array.isArray(candidate?.providerReasons)
    ? candidate.providerReasons.map(value => String(value).toLowerCase())
    : [];
  return {
    code,
    message,
    retryable: candidate?.retryable === true || cause?.retryable === true,
    status: Number.isFinite(statusValue) ? statusValue : undefined,
    quotaSignal: candidate?.quotaExceeded === true
      || providerReasons.some(reason => QUOTA_PROVIDER_REASONS.has(reason)),
    name: String(candidate?.name ?? ''),
    errorClass: String(candidate?.errorClass ?? cause?.errorClass ?? '').toUpperCase(),
  };
}

function isRetryableFailure(fields: FailureFields): boolean {
  return fields.retryable
    || RETRYABLE_CODES.has(fields.code)
    || (fields.status !== undefined && RETRYABLE_STATUSES.has(fields.status))
    || fields.name === 'TimeoutError'
    || RETRYABLE_CLASSES.has(fields.errorClass);
}

/**
 * Classify the evidence available for one failed execution. Missing or
 * malformed evidence is UNKNOWN; a row only proves no work started when all
 * three execution counters are present and zero.
 */
export function classifyWorkStartedEvidence(
  evidence?: AcquisitionFailureEvidence | null,
): WorkStartedEvidence {
  if (!evidence || typeof evidence !== 'object') return 'UNKNOWN';
  const raw = [evidence.pagesInspected, evidence.requestsStarted, evidence.redirectsFollowed];
  if (raw.some(value => value === undefined || value === null)) return 'UNKNOWN';
  const values = raw.map(value => Number(value));
  if (values.some(value => !Number.isFinite(value) || value < 0)) return 'UNKNOWN';
  return values.some(value => value > 0) ? 'PROVEN_STARTED' : 'PROVEN_UNSTARTED';
}

/**
 * Read execution counters attached to an error or its telemetry envelope.
 * Never throws: a malformed carrier simply yields UNKNOWN.
 */
export function acquisitionEvidenceFromError(error: unknown): AcquisitionFailureEvidence | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = error as {
    acquisitionEvidence?: unknown;
    telemetry?: unknown;
    pagesInspected?: unknown;
    requestsStarted?: unknown;
    redirectsFollowed?: unknown;
  };
  const carrier = value.acquisitionEvidence ?? value.telemetry ?? value;
  if (!carrier || typeof carrier !== 'object') return undefined;
  const counters = carrier as {
    pagesInspected?: unknown;
    requestsStarted?: unknown;
    redirectsFollowed?: unknown;
  };
  if (counters.pagesInspected === undefined
    && counters.requestsStarted === undefined
    && counters.redirectsFollowed === undefined) return undefined;
  return {
    pagesInspected: counters.pagesInspected,
    requestsStarted: counters.requestsStarted,
    redirectsFollowed: counters.redirectsFollowed,
  };
}

function classification(
  failureClass: AcquisitionFailureClass,
  reason: AcquisitionFailureReason,
  fields: FailureFields,
  existingCapacityLease: boolean,
  workStartedEvidence: WorkStartedEvidence,
  browserFailureClass?: BrowserFailureClass,
): AcquisitionFailureClassification {
  return {
    failureClass,
    reason,
    existingCapacityLease,
    workStartedEvidence,
    evidence: {
      code: fields.code,
      retryable: fields.retryable,
      ...(fields.status !== undefined ? { status: fields.status } : {}),
      quotaSignal: fields.quotaSignal,
      ...(browserFailureClass ? { browserFailureClass } : {}),
    },
  };
}

/**
 * Classify one failure without changing its scheduling. Explicit capacity
 * evidence wins first; browser runtime is split from capacity so a browser
 * crash after real work is visible as a genuine failure. Everything else is a
 * genuine failure, with the conventional retryability recorded as a reason.
 */
export function classifyAcquisitionFailure(
  error: unknown,
  evidence?: AcquisitionFailureEvidence | null,
): AcquisitionFailureClassification {
  const fields = readFailureFields(error);
  const existingCapacityLease = isCapacityLeaseFailure(error);
  const workStarted = classifyWorkStartedEvidence(evidence);

  // Provider allocation exhaustion is capacity regardless of which code shape
  // carried it. The persisted YOUTUBE_QUOTA_EXCEEDED marker is included so a
  // wrapped provider quota error cannot read as a genuine acquisition failure.
  if (isQuotaCapacityFailure(error)
    || fields.quotaSignal
    || fields.code === 'YOUTUBE_QUOTA_EXCEEDED'
    || fields.message.startsWith('youtube_quota_exceeded:')) {
    const reason: AcquisitionFailureReason = fields.code.startsWith('YOUTUBE_KEY_CAP')
      ? 'YOUTUBE_KEY_CAP'
      : 'QUOTA_ALLOCATION';
    return classification('CAPACITY', reason, fields, existingCapacityLease, workStarted);
  }

  // The queue constructs this prefix only after proving no acquisition work
  // started, so it is authoritative even when the message also names a
  // browser failure class.
  if (fields.message.includes('community acquisition deferred:')) {
    const saturation = fields.message.includes('rendered_fallback_saturated')
      || fields.code === 'RENDERED_FALLBACK_SATURATED';
    return classification(
      'CAPACITY',
      saturation ? 'BROWSER_GATE_SATURATION' : 'COMMUNITY_CAPACITY_DEFERRAL',
      fields,
      existingCapacityLease,
      workStarted,
    );
  }

  if (fields.code === 'RENDERED_FALLBACK_SATURATED') {
    return classification('CAPACITY', 'BROWSER_GATE_SATURATION', fields, existingCapacityLease, workStarted);
  }

  if (fields.code === 'COMMUNITY_ACQUISITION_CAPACITY_UNAVAILABLE') {
    return classification('CAPACITY', 'CAPACITY_ADMISSION_UNAVAILABLE', fields, existingCapacityLease, workStarted);
  }

  if (isBrowserRuntimeFailure(error) || BROWSER_RUNTIME_CODES.has(fields.code)) {
    const browserFailureClass = classifyBrowserFailure(error);
    if (workStarted === 'PROVEN_STARTED') {
      // A browser crash after pages/requests/redirects is executed work and
      // must not become an attempt-free capacity wait.
      return classification(
        'GENUINE_FAILURE',
        'BROWSER_RUNTIME_WORK_STARTED',
        fields,
        existingCapacityLease,
        workStarted,
        browserFailureClass,
      );
    }
    return classification(
      'BROWSER_RUNTIME',
      'BROWSER_RUNTIME',
      fields,
      existingCapacityLease,
      workStarted,
      browserFailureClass,
    );
  }

  // Defensive fallback: if the legacy predicate knows a capacity shape that
  // the explicit branches above do not, keep it in the capacity bucket so the
  // shadow cannot silently disagree with current behavior by accident.
  if (existingCapacityLease) {
    return classification('CAPACITY', 'CAPACITY_ADMISSION_UNAVAILABLE', fields, existingCapacityLease, workStarted);
  }

  return classification(
    'GENUINE_FAILURE',
    isRetryableFailure(fields) ? 'RETRYABLE_INFRASTRUCTURE' : 'TERMINAL_OR_UNCLASSIFIED',
    fields,
    existingCapacityLease,
    workStarted,
  );
}
