/**
 * Process-local operations telemetry (Phase 0 observability foundation).
 *
 * Counters only — no persistence, no decision-path influence. Values reset on
 * process restart; a persisted metrics ledger is a later phase. Every counter
 * exists so roadmap phases can measure before/after instead of asserting.
 */

export type Gate1DispositionKey =
  | 'REJECT_EXCLUDED'
  | 'ALLOW_NORMAL'
  | 'CONTINUE_CRAWLING'
  | 'NEEDS_REVIEW'
  | 'UNKNOWN';

export type JobFailureDispositionKey =
  | 'FAILED'
  | 'RETRYING'
  | 'RETRYING_WITHOUT_ATTEMPT'
  | 'UNKNOWN';

interface OperationsCounters {
  gate1EvaluationsTotal: Record<Gate1DispositionKey, number>;
  repeatFailureSkipsTotal: number;
  repeatFailureHistoryOutagesTotal: number;
  jobFailureDispositionsTotal: Record<JobFailureDispositionKey, number>;
  invalidApiKeyQuarantinesTotal: number;
}

function freshCounters(): OperationsCounters {
  return {
    gate1EvaluationsTotal: {
      REJECT_EXCLUDED: 0,
      ALLOW_NORMAL: 0,
      CONTINUE_CRAWLING: 0,
      NEEDS_REVIEW: 0,
      UNKNOWN: 0,
    },
    repeatFailureSkipsTotal: 0,
    repeatFailureHistoryOutagesTotal: 0,
    jobFailureDispositionsTotal: {
      FAILED: 0,
      RETRYING: 0,
      RETRYING_WITHOUT_ATTEMPT: 0,
      UNKNOWN: 0,
    },
    invalidApiKeyQuarantinesTotal: 0,
  };
}

const counters = freshCounters();

function normalizeGate1(value: unknown): Gate1DispositionKey {
  return value === 'REJECT_EXCLUDED' ||
    value === 'ALLOW_NORMAL' ||
    value === 'CONTINUE_CRAWLING' ||
    value === 'NEEDS_REVIEW'
    ? value
    : 'UNKNOWN';
}

function normalizeJobFailure(value: unknown): JobFailureDispositionKey {
  return value === 'FAILED' || value === 'RETRYING' || value === 'RETRYING_WITHOUT_ATTEMPT'
    ? value
    : 'UNKNOWN';
}

export function bumpGate1Evaluation(disposition: unknown): void {
  counters.gate1EvaluationsTotal[normalizeGate1(disposition)] += 1;
}

export function bumpRepeatFailureSkip(skippedUrls = 1): void {
  if (Number.isFinite(skippedUrls) && skippedUrls > 0) {
    counters.repeatFailureSkipsTotal += Math.floor(skippedUrls);
  }
}

export function bumpRepeatFailureHistoryOutage(): void {
  counters.repeatFailureHistoryOutagesTotal += 1;
}

export function bumpJobFailureDisposition(disposition: unknown): void {
  counters.jobFailureDispositionsTotal[normalizeJobFailure(disposition)] += 1;
}

export function bumpInvalidApiKeyQuarantine(): void {
  counters.invalidApiKeyQuarantinesTotal += 1;
}

export function operationsTelemetrySnapshot(): OperationsCounters {
  return {
    gate1EvaluationsTotal: { ...counters.gate1EvaluationsTotal },
    repeatFailureSkipsTotal: counters.repeatFailureSkipsTotal,
    repeatFailureHistoryOutagesTotal: counters.repeatFailureHistoryOutagesTotal,
    jobFailureDispositionsTotal: { ...counters.jobFailureDispositionsTotal },
    invalidApiKeyQuarantinesTotal: counters.invalidApiKeyQuarantinesTotal,
  };
}

/** Test-only reset; never called from serving paths. */
export function resetOperationsTelemetry(): void {
  const fresh = freshCounters();
  counters.gate1EvaluationsTotal = fresh.gate1EvaluationsTotal;
  counters.repeatFailureSkipsTotal = fresh.repeatFailureSkipsTotal;
  counters.repeatFailureHistoryOutagesTotal = fresh.repeatFailureHistoryOutagesTotal;
  counters.jobFailureDispositionsTotal = fresh.jobFailureDispositionsTotal;
  counters.invalidApiKeyQuarantinesTotal = fresh.invalidApiKeyQuarantinesTotal;
}
