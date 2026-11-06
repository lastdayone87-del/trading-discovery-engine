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
        quotaExceeded?: unknown;
        providerReasons?: unknown;
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
  // A wrapper may keep the provider quota metadata only on `cause`, so read
  // both levels; otherwise a wrapped quota exhaustion is misread as genuine.
  const providerReasons = [
    ...(Array.isArray(candidate?.providerReasons) ? candidate.providerReasons : []),
    ...(Array.isArray(cause?.providerReasons) ? cause.providerReasons : []),
  ].map(value => String(value).toLowerCase());
  return {
    code,
    message,
    retryable: candidate?.retryable === true || cause?.retryable === true,
    status: Number.isFinite(statusValue) ? statusValue : undefined,
    quotaSignal: candidate?.quotaExceeded === true
      || cause?.quotaExceeded === true
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

const WORK_EVIDENCE_COUNTERS = ['pagesInspected', 'requestsStarted', 'redirectsFollowed'] as const;

function isCounter(value: unknown): value is number {
  // Only real non-negative numbers count. Number('') / Number(false) / Number([])
  // all coerce to 0 and would otherwise manufacture PROVEN_UNSTARTED from a
  // malformed carrier.
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Classify the evidence available for one failed execution.
 *
 * A single present, valid positive counter proves work started even when the
 * other counters are missing (a browser crash after inspecting one page is
 * executable work, not an attempt-free wait). Proving that no work started is
 * stricter: all three counters must be present, numeric, and zero. Anything
 * else is UNKNOWN — absence of a signal is never proof of absence.
 */
export function classifyWorkStartedEvidence(
  evidence?: AcquisitionFailureEvidence | null,
): WorkStartedEvidence {
  if (!evidence || typeof evidence !== 'object') return 'UNKNOWN';
  const raw = WORK_EVIDENCE_COUNTERS.map(key => evidence[key]);
  if (raw.some(value => isCounter(value) && value > 0)) return 'PROVEN_STARTED';
  if (!raw.every(isCounter)) return 'UNKNOWN';
  return 'PROVEN_UNSTARTED';
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

/** The evidence-bearing shape shared by acquisition observations. */
export interface AcquisitionEvidenceObservation {
  /**
   * Borrowed cache-hit observations replay telemetry from an earlier crawl;
   * their counters describe that crawl, not this attempt, so they must not
   * contribute to the current execution evidence.
   */
  siteCacheHit?: unknown;
  telemetry?: {
    pagesInspected?: unknown;
    requestsStarted?: unknown;
    redirectsFollowed?: unknown;
  } | null;
}

/**
 * Aggregate execution counters across one inspection's observations.
 *
 * The community retry worker replaces its inspection observation with a new,
 * unannotated error, so the counters must be lifted from the observation rows
 * before failJob classifies it. Cache-hit observations are skipped because
 * their telemetry belongs to an earlier execution. A counter is reported only
 * when every remaining observation carried a valid value (so a zero total
 * cannot hide an unknown row); a positive value from any observation is always
 * retained because it proves work started on its own.
 */
export function acquisitionEvidenceFromObservations(
  observations: readonly AcquisitionEvidenceObservation[] | null | undefined,
): AcquisitionFailureEvidence | undefined {
  if (!Array.isArray(observations) || observations.length === 0) return undefined;
  const totals: Record<(typeof WORK_EVIDENCE_COUNTERS)[number], number> = {
    pagesInspected: 0,
    requestsStarted: 0,
    redirectsFollowed: 0,
  };
  const complete: Record<(typeof WORK_EVIDENCE_COUNTERS)[number], boolean> = {
    pagesInspected: true,
    requestsStarted: true,
    redirectsFollowed: true,
  };
  let included = 0;
  for (const observation of observations) {
    if (observation?.siteCacheHit === true) continue;
    included += 1;
    const telemetry = observation?.telemetry;
    for (const key of WORK_EVIDENCE_COUNTERS) {
      const value = telemetry && typeof telemetry === 'object' ? telemetry[key] : undefined;
      if (!isCounter(value)) {
        complete[key] = false;
        continue;
      }
      totals[key] += value;
    }
  }
  const evidence: AcquisitionFailureEvidence = {};
  for (const key of WORK_EVIDENCE_COUNTERS) {
    if (complete[key] || totals[key] > 0) evidence[key] = totals[key];
  }
  // Only cache-hit observations were available: nothing here describes this
  // execution, so report UNKNOWN rather than a synthetic zero-work attempt.
  if (included === 0) return undefined;
  return Object.keys(evidence).length > 0 ? evidence : undefined;
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
