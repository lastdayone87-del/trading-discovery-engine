/**
 * Process-local operations telemetry (Phase 0 observability foundation).
 *
 * Counters only — no persistence, no decision-path influence. Values reset on
 * process restart; a persisted metrics ledger is a later phase. Every counter
 * exists so roadmap phases can measure before/after instead of asserting.
 */

import type { AcquisitionFailureClass } from './acquisitionFailureClassification';
import {
  ACQUISITION_LANES,
  ACQUISITION_OUTCOMES,
  isAcquisitionLane,
  isAcquisitionOutcome,
  type AcquisitionLane,
  type AcquisitionOutcome,
} from './acquisitionLaneKeys';

export type Gate1DispositionKey =
  | 'REJECT_EXCLUDED'
  | 'REJECT_UNSUPPORTED'
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
  /** Phase 0 shadow split; every counted failure is also a disposition. */
  jobFailureClassificationsTotal: Record<AcquisitionFailureClass, number>;
  /** Shadow writes that failed and fell back to the legacy finalize statement. */
  jobFailureClassificationFallbacksTotal: number;
  invalidApiKeyQuarantinesTotal: number;
}

interface CommunityRecoveryCounters {
  /** Recovery cycles that durably enqueued a bounded enrichment recovery job. */
  operationalEnrichmentRecoveryEnqueuedTotal: number;
  /** Cycle event key collisions: an idempotent duplicate, never a second enqueue. */
  operationalEnrichmentRecoveryDuplicateEventsTotal: number;
  /** Channels that exhausted the bounded recovery cycle ceiling. */
  operationalEnrichmentRecoveryExhaustedTotal: number;
  /** Proven RENDERED_FALLBACK_SATURATED capacity deferrals (no work started). */
  communitySaturationDeferralsTotal: number;
}

/**
 * Phase 0 acquisition-lane baseline. Process-local and reset on restart; the
 * durable baseline is `acquisition_lane_events` (flag-gated). Counters never
 * influence acquisition, retry, or capacity decisions.
 */
interface AcquisitionLaneCounters {
  acquisitionLaneEventsTotal: Record<AcquisitionLane, Record<AcquisitionOutcome, number>>;
  acquisitionLanePagesInspectedTotal: Record<AcquisitionLane, number>;
  acquisitionLaneRequestsStartedTotal: Record<AcquisitionLane, number>;
  acquisitionLaneGateWaitMsTotal: Record<AcquisitionLane, number>;
  acquisitionLaneGateWaitMaxMs: Record<AcquisitionLane, number>;
  acquisitionLaneWorkRemainingTotal: Record<AcquisitionLane, number>;
  /** Default-off bulk-enqueue caps; the warning counter is always active. */
  bulkEnqueueGuardBlocksTotal: { transaction: number; hour: number };
  bulkEnqueueWarningsTotal: number;
}

type AllCounters = OperationsCounters & CommunityRecoveryCounters & AcquisitionLaneCounters;

function emptyLaneCounts(): Record<AcquisitionLane, number> {
  return Object.fromEntries(ACQUISITION_LANES.map(lane => [lane, 0])) as Record<AcquisitionLane, number>;
}

function emptyLaneOutcomeCounts(): Record<AcquisitionLane, Record<AcquisitionOutcome, number>> {
  return Object.fromEntries(
    ACQUISITION_LANES.map(lane => [
      lane,
      Object.fromEntries(ACQUISITION_OUTCOMES.map(outcome => [outcome, 0])) as Record<AcquisitionOutcome, number>,
    ]),
  ) as Record<AcquisitionLane, Record<AcquisitionOutcome, number>>;
}

function freshCounters(): AllCounters {
  return {
    gate1EvaluationsTotal: {
      REJECT_EXCLUDED: 0,
      REJECT_UNSUPPORTED: 0,
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
    jobFailureClassificationsTotal: {
      CAPACITY: 0,
      BROWSER_RUNTIME: 0,
      GENUINE_FAILURE: 0,
    },
    jobFailureClassificationFallbacksTotal: 0,
    invalidApiKeyQuarantinesTotal: 0,
    operationalEnrichmentRecoveryEnqueuedTotal: 0,
    operationalEnrichmentRecoveryDuplicateEventsTotal: 0,
    operationalEnrichmentRecoveryExhaustedTotal: 0,
    communitySaturationDeferralsTotal: 0,
    acquisitionLaneEventsTotal: emptyLaneOutcomeCounts(),
    acquisitionLanePagesInspectedTotal: emptyLaneCounts(),
    acquisitionLaneRequestsStartedTotal: emptyLaneCounts(),
    acquisitionLaneGateWaitMsTotal: emptyLaneCounts(),
    acquisitionLaneGateWaitMaxMs: emptyLaneCounts(),
    acquisitionLaneWorkRemainingTotal: emptyLaneCounts(),
    bulkEnqueueGuardBlocksTotal: { transaction: 0, hour: 0 },
    bulkEnqueueWarningsTotal: 0,
  };
}

const counters = freshCounters();

function normalizeGate1(value: unknown): Gate1DispositionKey {
  return value === 'REJECT_EXCLUDED' ||
    value === 'REJECT_UNSUPPORTED' ||
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

function normalizeAcquisitionFailureClass(value: unknown): AcquisitionFailureClass | null {
  return value === 'CAPACITY' || value === 'BROWSER_RUNTIME' || value === 'GENUINE_FAILURE'
    ? value
    : null;
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

export function bumpJobFailureClassification(classification: unknown): void {
  const key = normalizeAcquisitionFailureClass(classification);
  if (key) counters.jobFailureClassificationsTotal[key] += 1;
}

export function bumpJobFailureClassificationFallback(): void {
  counters.jobFailureClassificationFallbacksTotal += 1;
}

export function bumpInvalidApiKeyQuarantine(): void {
  counters.invalidApiKeyQuarantinesTotal += 1;
}

export function bumpOperationalEnrichmentRecoveryEnqueued(): void {
  counters.operationalEnrichmentRecoveryEnqueuedTotal += 1;
}

export function bumpOperationalEnrichmentRecoveryDuplicateEvent(): void {
  counters.operationalEnrichmentRecoveryDuplicateEventsTotal += 1;
}

export function bumpOperationalEnrichmentRecoveryExhausted(): void {
  counters.operationalEnrichmentRecoveryExhaustedTotal += 1;
}

export function bumpCommunitySaturationDeferral(): void {
  counters.communitySaturationDeferralsTotal += 1;
}

function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Count one classified inspection/slice. Called for every inspection even when
 * the durable lane-event flag is off, so a deploy can compare in-process
 * counters with the persisted baseline. Unknown lane/outcome values are
 * dropped rather than coerced into a bucket.
 */
export function bumpAcquisitionLaneEvent(
  lane: unknown,
  outcome: unknown,
  input: { pagesInspected?: unknown; requestsStarted?: unknown; gateWaitMs?: unknown; workRemaining?: unknown } = {},
): void {
  if (!isAcquisitionLane(lane) || !isAcquisitionOutcome(outcome)) return;
  counters.acquisitionLaneEventsTotal[lane][outcome] += 1;
  counters.acquisitionLanePagesInspectedTotal[lane] += nonNegative(input.pagesInspected);
  counters.acquisitionLaneRequestsStartedTotal[lane] += nonNegative(input.requestsStarted);
  const gateWaitMs = nonNegative(input.gateWaitMs);
  if (gateWaitMs > 0) {
    counters.acquisitionLaneGateWaitMsTotal[lane] += gateWaitMs;
    counters.acquisitionLaneGateWaitMaxMs[lane] = Math.max(counters.acquisitionLaneGateWaitMaxMs[lane], gateWaitMs);
  }
  counters.acquisitionLaneWorkRemainingTotal[lane] += nonNegative(input.workRemaining);
}

export type BulkEnqueueGuardBlockKind = 'transaction' | 'hour';

export function bumpBulkEnqueueGuardBlock(kind: BulkEnqueueGuardBlockKind): void {
  counters.bulkEnqueueGuardBlocksTotal[kind] += 1;
}

export function bumpBulkEnqueueWarning(): void {
  counters.bulkEnqueueWarningsTotal += 1;
}

/**
 * Bounded idempotency guards for the disposition and classification counters.
 * failJob performs its writes outside a transaction: if a secondary bookkeeping
 * write fails after the job row committed, a worker retry re-runs the same
 * transition and must not count it twice.
 *
 * The guards are separate per kind so classification traffic can never evict a
 * disposition key (or vice versa) and cause a repeated failure to double-count.
 */
const countedDispositions = new Map<string, number>();
const countedClassifications = new Map<string, number>();
const MAX_COUNTED_EXECUTIONS_PER_KIND = 5000;

function markExecutionCounted(guard: Map<string, number>, key: string): boolean {
  if (guard.has(key)) return false;
  if (guard.size >= MAX_COUNTED_EXECUTIONS_PER_KIND) {
    const oldest = guard.keys().next();
    if (!oldest.done) guard.delete(oldest.value);
  }
  guard.set(key, Date.now());
  return true;
}

export function markJobDispositionCounted(executionKey: unknown, disposition: unknown): boolean {
  return markExecutionCounted(countedDispositions, `${String(executionKey)}:${normalizeJobFailure(disposition)}`);
}

/** Count a persisted classification at most once per execution. */
export function markJobFailureClassificationCounted(executionKey: unknown): boolean {
  return markExecutionCounted(countedClassifications, String(executionKey));
}

export function jobDispositionExecutionKey(
  attemptRowId: unknown,
  jobId: unknown,
  attempts: unknown,
): string {
  if (attemptRowId !== null && attemptRowId !== undefined && String(attemptRowId) !== '') {
    return `attempt-row:${String(attemptRowId)}`;
  }
  return `job:${String(jobId)}:attempt:${String(attempts)}`;
}

export function operationsTelemetrySnapshot(): AllCounters {
  return {
    gate1EvaluationsTotal: { ...counters.gate1EvaluationsTotal },
    repeatFailureSkipsTotal: counters.repeatFailureSkipsTotal,
    repeatFailureHistoryOutagesTotal: counters.repeatFailureHistoryOutagesTotal,
    jobFailureDispositionsTotal: { ...counters.jobFailureDispositionsTotal },
    jobFailureClassificationsTotal: { ...counters.jobFailureClassificationsTotal },
    jobFailureClassificationFallbacksTotal: counters.jobFailureClassificationFallbacksTotal,
    invalidApiKeyQuarantinesTotal: counters.invalidApiKeyQuarantinesTotal,
    operationalEnrichmentRecoveryEnqueuedTotal: counters.operationalEnrichmentRecoveryEnqueuedTotal,
    operationalEnrichmentRecoveryDuplicateEventsTotal: counters.operationalEnrichmentRecoveryDuplicateEventsTotal,
    operationalEnrichmentRecoveryExhaustedTotal: counters.operationalEnrichmentRecoveryExhaustedTotal,
    communitySaturationDeferralsTotal: counters.communitySaturationDeferralsTotal,
    acquisitionLaneEventsTotal: Object.fromEntries(
      ACQUISITION_LANES.map(lane => [lane, { ...counters.acquisitionLaneEventsTotal[lane] }]),
    ) as Record<AcquisitionLane, Record<AcquisitionOutcome, number>>,
    acquisitionLanePagesInspectedTotal: { ...counters.acquisitionLanePagesInspectedTotal },
    acquisitionLaneRequestsStartedTotal: { ...counters.acquisitionLaneRequestsStartedTotal },
    acquisitionLaneGateWaitMsTotal: { ...counters.acquisitionLaneGateWaitMsTotal },
    acquisitionLaneGateWaitMaxMs: { ...counters.acquisitionLaneGateWaitMaxMs },
    acquisitionLaneWorkRemainingTotal: { ...counters.acquisitionLaneWorkRemainingTotal },
    bulkEnqueueGuardBlocksTotal: { ...counters.bulkEnqueueGuardBlocksTotal },
    bulkEnqueueWarningsTotal: counters.bulkEnqueueWarningsTotal,
  };
}

/** Test-only reset; never called from serving paths. */
export function resetOperationsTelemetry(): void {
  const fresh = freshCounters();
  counters.gate1EvaluationsTotal = fresh.gate1EvaluationsTotal;
  counters.repeatFailureSkipsTotal = fresh.repeatFailureSkipsTotal;
  counters.repeatFailureHistoryOutagesTotal = fresh.repeatFailureHistoryOutagesTotal;
  counters.jobFailureDispositionsTotal = fresh.jobFailureDispositionsTotal;
  counters.jobFailureClassificationsTotal = fresh.jobFailureClassificationsTotal;
  counters.jobFailureClassificationFallbacksTotal = fresh.jobFailureClassificationFallbacksTotal;
  counters.invalidApiKeyQuarantinesTotal = fresh.invalidApiKeyQuarantinesTotal;
  counters.operationalEnrichmentRecoveryEnqueuedTotal = fresh.operationalEnrichmentRecoveryEnqueuedTotal;
  counters.operationalEnrichmentRecoveryDuplicateEventsTotal = fresh.operationalEnrichmentRecoveryDuplicateEventsTotal;
  counters.operationalEnrichmentRecoveryExhaustedTotal = fresh.operationalEnrichmentRecoveryExhaustedTotal;
  counters.communitySaturationDeferralsTotal = fresh.communitySaturationDeferralsTotal;
  counters.acquisitionLaneEventsTotal = fresh.acquisitionLaneEventsTotal;
  counters.acquisitionLanePagesInspectedTotal = fresh.acquisitionLanePagesInspectedTotal;
  counters.acquisitionLaneRequestsStartedTotal = fresh.acquisitionLaneRequestsStartedTotal;
  counters.acquisitionLaneGateWaitMsTotal = fresh.acquisitionLaneGateWaitMsTotal;
  counters.acquisitionLaneGateWaitMaxMs = fresh.acquisitionLaneGateWaitMaxMs;
  counters.acquisitionLaneWorkRemainingTotal = fresh.acquisitionLaneWorkRemainingTotal;
  counters.bulkEnqueueGuardBlocksTotal = fresh.bulkEnqueueGuardBlocksTotal;
  counters.bulkEnqueueWarningsTotal = fresh.bulkEnqueueWarningsTotal;
  // Dedupe state is test-observable too: a reset must start from a clean slate
  // or a later test can be silently suppressed by an earlier execution key.
  countedDispositions.clear();
  countedClassifications.clear();
}
