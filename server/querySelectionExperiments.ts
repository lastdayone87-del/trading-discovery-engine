/**
 * Query-selection experiments (EXPERIMENTAL testability, no promotion).
 * Pure, deterministic, DB-free orchestration over the existing #486 harness:
 * - Thompson Sampling via allocationChallengers.selectThompsonArm (unchanged)
 * - Contextual scoring via allocationChallengers.contextualArmScore (unchanged)
 * - Ordering/window assignment via retrievalExperiment (unchanged)
 * - Eligibility pool reuse via queryPlanner helpers (unchanged)
 * - UCB1 control via queryIntelligence.selectNextQueryForCountry (unchanged)
 *
 * This module adds NO selection algorithm of its own. It assigns an
 * experimental arm deterministically, derives caller-supplied observation
 * inputs from existing query_library counters through documented mappings,
 * and builds a provenance-bound observation envelope for persistence.
 * Without an explicit experiment request every entry point below resolves
 * to CONTROL and callers must not persist any envelope (legacy byte-identical).
 *
 * Frozen rules (do not alter without a separately approved experiment):
 * - Bucket construction: sha256(`${VERSION}:${experimentId}:${opportunityKey}`)
 *   truncated to 8 hex chars mod 10000 (same family as retrieval-experiment-v1).
 * - treatmentBasisPoints=0 (or absent/invalid config) forces CONTROL.
 * - Propensity of the served arm is recorded truthfully; CONTROL propensity
 *   is 10000-treatmentBasisPoints; a treatment arm's propensity is
 *   floor(treatmentBasisPoints / enabledArmCount).
 * - Thompson observation mapping (thompson-observation-map-v1):
 *     successes = quality_channels_found ?? 0
 *     failures  = max(0, (times_executed ?? 0) - successes)
 * - Contextual feature mapping (query-features-v1):
 *     expectedValue = (performance_score ?? 0) / 100
 *     uncertainty   = 1 / ((times_executed ?? 0) + 1)
 *     coverageGap   = total_channels_found > 0
 *       ? max(0, 1 - (unique_channels_found ?? 0) / total_channels_found)
 *       : 1
 *     cost          = 1 (one normalized page-cost unit per candidate)
 * - Arm pool order is eligible queries sorted by query.id ascending, so an
 *   arm index always resolves to the same query for identical inputs.
 */
import { createHash } from 'node:crypto';
import { selectThompsonArm, thompsonSample, contextualArmScore } from './allocationChallengers';
import {
  selectOrderingExperimentArm,
  buildWindowedSearchParams,
  RETRIEVAL_EXPERIMENT_VERSION,
} from './retrievalExperiment';
import {
  queriesOutsideCooldown,
  limitRepeatedPrimaryTerms,
  rotateAwayFromMostRecentIntent,
} from './queryPlanner';
import { selectNextQueryForCountry, restrictPoolToDesignatedRow } from './queryIntelligence';
import { getQueriesByCountry, getAppSetting } from './db';
import type { QueryRecord } from '../src/types';

export const QUERY_SELECTION_EXPERIMENT_VERSION = 'query-selection-experiment-v1';
export const THOMPSON_OBSERVATION_MAP_VERSION = 'thompson-observation-map-v1';
export const QUERY_FEATURES_MAP_VERSION = 'query-features-v1';

export type SelectionExperimentArm = 'CONTROL' | 'THOMPSON' | 'CONTEXTUAL';

export interface ThompsonPriorConfig {
  alpha0?: number;
  beta0?: number;
}

export interface ContextualWeightConfig {
  value?: number;
  exploration?: number;
  cost?: number;
}

export interface SelectionExperimentSelectionConfig {
  experimentId?: string;
  enabledArms?: Array<'THOMPSON' | 'CONTEXTUAL'>;
  treatmentBasisPoints?: number;
  thompsonPrior?: ThompsonPriorConfig;
  contextualWeights?: ContextualWeightConfig;
}

export interface SelectionExperimentOrderingConfig {
  treatmentBasisPoints?: number;
  window?: { publishedAfter?: string; publishedBefore?: string };
  /**
   * Identity for the ordering dimension. An explicit ordering experimentId
   * always wins; only when ordering carries none may it fall back to the
   * selection experimentId. A standalone ordering experiment must supply
   * its own (an untraceable experiment is rejected at validation).
   */
  experimentId?: string;
}

export interface SelectionExperimentTrialConfig {
  proposalId?: string;
  maxQuota?: number;
  pageDepth?: number;
  trialKey?: string;
}

/**
 * Frozen benchmark opportunity scope (benchmark-preregistration-v1).
 * Designates the pre-existing frozen pool snapshot row this attempt belongs
 * to. Carried on the request (pre-selection) so the benchmark opportunity
 * identity never depends on which query selection serves. Optional and
 * inert on its own: it rides with selection/ordering/trial dimensions and
 * changes no assignment math.
 */
export interface SelectionExperimentBenchmarkScope {
  /** Frozen pool snapshot hash (external execution-record identity). */
  snapshotHash?: string;
  /** Frozen pool snapshot row: the pre-existing query_library id. */
  poolRowId?: number;
}

export interface SelectionExperimentRequest {
  selection?: SelectionExperimentSelectionConfig;
  ordering?: SelectionExperimentOrderingConfig;
  trial?: SelectionExperimentTrialConfig;
  benchmark?: SelectionExperimentBenchmarkScope;
}

export interface NormalizedTrialRequest {
  proposalId: string;
  maxQuota: number;
  pageDepth: number;
  trialKey?: string;
}

export interface NormalizedSelectionExperiment {
  selection: {
    experimentId: string;
    enabledArms: Array<'THOMPSON' | 'CONTEXTUAL'>;
    treatmentBasisPoints: number;
    thompsonPrior: { alpha0: number; beta0: number };
    contextualWeights: { value: number; exploration: number; cost: number };
  } | null;
  ordering: {
    experimentId: string;
    treatmentBasisPoints: number;
    window: { publishedAfter?: string; publishedBefore?: string } | null;
  } | null;
  trial: NormalizedTrialRequest | null;
  /**
   * Frozen benchmark opportunity scope, when the request designates one.
   * Present only when snapshotHash is non-empty and poolRowId is a positive
   * integer; a present-but-invalid scope normalizes to null (routes then
   * fail closed). Alone it validates nothing: at least one valid dimension
   * (selection/ordering/trial) is still required.
   */
  benchmark: {
    snapshotHash: string;
    poolRowId: number;
  } | null;
}

export type SelectionExperimentEligibilityReason =
  | 'SELECTION_EXPERIMENT_ELIGIBLE'
  | 'SELECTION_EXPERIMENT_NOT_REQUESTED'
  | 'INVALID_EXPERIMENT_ID'
  | 'NO_ARMS_ENABLED'
  | 'UNKNOWN_ARM'
  | 'INVALID_BASIS_POINTS'
  | 'INVALID_PRIOR'
  | 'INVALID_WEIGHTS';

function shaBucket(input: string): number {
  const digest = createHash('sha256').update(input).digest('hex');
  return Number.parseInt(digest.slice(0, 8), 16) % 10000;
}

/**
 * Frozen benchmark identity (benchmark-preregistration-v1 §3A). These
 * constants name the preregistered experiment identities; they change no
 * assignment math and gate only benchmark-scoped derivation paths. All
 * other experiment identities execute the legacy caller-supplied paths
 * byte-identically.
 */
export const BENCHMARK_PREREG_SELECTION_EXPERIMENT_ID = 'benchmark-prereg-v1-selection';
export const BENCHMARK_PREREG_ORDERING_EXPERIMENT_ID = 'benchmark-prereg-v1-ordering';
/** Frozen P2 recency lookback in days (benchmark-preregistration-v1 §3A). */
export const BENCHMARK_PREREG_ORDERING_WINDOW_DAYS = 90;

const BENCHMARK_PREREG_ORDERING_WINDOW_MS = BENCHMARK_PREREG_ORDERING_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * Derives the frozen P2 benchmark window from the opportunity's scheduled_at.
 * Pure: publishedBefore = scheduledAt, publishedAfter = scheduledAt − 90
 * days, both RFC3339. Caller-supplied bounds are never consulted, so a
 * missing or divergent caller window cannot violate the preregistered rule.
 */
export function deriveBenchmarkOrderingWindow(scheduledAt: Date): { publishedAfter: string; publishedBefore: string } {
  const before = new Date(scheduledAt.getTime());
  const after = new Date(scheduledAt.getTime() - BENCHMARK_PREREG_ORDERING_WINDOW_MS);
  return { publishedAfter: after.toISOString(), publishedBefore: before.toISOString() };
}

/**
 * Whether a normalized experiment request exactly matches the frozen
 * benchmark configuration (benchmark-preregistration-v1 §3A). Arm-independent:
 * CONTROL and treatment draws share the same opportunity identity. Any
 * deviation — unrelated identity, different arms/order, different basis,
 * different priors/weights — is not the frozen benchmark, even when a valid
 * pool scope is present. Pure.
 */
export function isFrozenBenchmarkConfiguration(
  experiment: NormalizedSelectionExperiment | null | undefined
): boolean {
  const selection = experiment?.selection ?? null;
  const ordering = experiment?.ordering ?? null;
  const selectionFrozen = !!selection &&
    selection.experimentId === BENCHMARK_PREREG_SELECTION_EXPERIMENT_ID &&
    selection.treatmentBasisPoints === 5000 &&
    selection.enabledArms.length === 2 &&
    selection.enabledArms[0] === 'THOMPSON' &&
    selection.enabledArms[1] === 'CONTEXTUAL' &&
    selection.thompsonPrior.alpha0 === 1 &&
    selection.thompsonPrior.beta0 === 1 &&
    selection.contextualWeights.value === 0.5 &&
    selection.contextualWeights.exploration === 0.35 &&
    selection.contextualWeights.cost === 0.1;
  const orderingFrozen = !!ordering &&
    ordering.experimentId === BENCHMARK_PREREG_ORDERING_EXPERIMENT_ID &&
    ordering.treatmentBasisPoints === 5000;
  // Every present selection/ordering dimension must exactly match; a mixed
  // request (one frozen dimension, one altered dimension) is not the frozen
  // benchmark. At least one frozen dimension must be present.
  return (selectionFrozen || orderingFrozen) &&
    (!selection || selectionFrozen) &&
    (!ordering || orderingFrozen);
}

/**
 * Stable benchmark opportunity identity for a served query. The identity is
 * the driver-designated frozen pool scope (snapshot hash + pool row id) —
 * fixed BEFORE selection — never the query selection happened to serve.
 * Returns the identity only when ALL of the following hold:
 * - the request exactly matches the frozen benchmark configuration
 *   (isFrozenBenchmarkConfiguration — a valid scope alone never grants it),
 * - a valid pool scope is designated,
 * - the served query IS that designated pool row;
 * otherwise undefined (the envelope field then stays absent). Non-frozen
 * observations are therefore never silently labeled as benchmark
 * observations, and a newly generated query, a fallback winner, or any
 * non-designated row can never acquire a frozen pool opportunity's
 * identity. CONTROL and treatment share the same identity by construction.
 */
export function benchmarkOpportunityIdForScope(
  scope: { snapshotHash: string; poolRowId: number } | null | undefined,
  servedQueryId: number,
  experiment: NormalizedSelectionExperiment | null | undefined
): string | undefined {
  if (!isFrozenBenchmarkConfiguration(experiment)) return undefined;
  if (!scope) return undefined;
  if (servedQueryId !== scope.poolRowId) return undefined;
  return `benchmark-prereg-v1:pool:${scope.snapshotHash}:${scope.poolRowId}`;
}

/**
 * Validates + normalizes an operator-supplied experiment request. Pure and
 * fail-closed: anything invalid yields { selection: null, ordering: null,
 * trial: null } semantics at the call site (routes must 400 instead — see
 * validateSelectionExperimentRequest). No defaults are invented for missing
 * sections: absent means the dimension is not part of the experiment.
 */
export function normalizeSelectionExperimentRequest(input: unknown): NormalizedSelectionExperiment {
  const source = (input && typeof input === 'object' ? input : {}) as SelectionExperimentRequest;
  let selection: NormalizedSelectionExperiment['selection'] = null;
  if (source.selection && typeof source.selection === 'object') {
    const raw = source.selection;
    const experimentId = typeof raw.experimentId === 'string' ? raw.experimentId.trim() : '';
    const enabledArms = Array.isArray(raw.enabledArms)
      ? raw.enabledArms.filter((arm): arm is 'THOMPSON' | 'CONTEXTUAL' => arm === 'THOMPSON' || arm === 'CONTEXTUAL')
      : [];
    const rawArms = Array.isArray(raw.enabledArms) ? raw.enabledArms : [];
    const treatmentBasisPoints = raw.treatmentBasisPoints ?? 0;
    const alpha0 = raw.thompsonPrior?.alpha0 ?? 1;
    const beta0 = raw.thompsonPrior?.beta0 ?? 1;
    const weights = {
      value: raw.contextualWeights?.value ?? 0.5,
      exploration: raw.contextualWeights?.exploration ?? 0.35,
      cost: raw.contextualWeights?.cost ?? 0.1,
    };
    const valid =
      experimentId.length > 0 &&
      rawArms.length > 0 &&
      rawArms.every(arm => arm === 'THOMPSON' || arm === 'CONTEXTUAL') &&
      enabledArms.length === rawArms.length &&
      Number.isInteger(treatmentBasisPoints) && treatmentBasisPoints >= 0 && treatmentBasisPoints <= 10000 &&
      Number.isFinite(alpha0) && alpha0 > 0 && Number.isFinite(beta0) && beta0 > 0 &&
      Number.isFinite(weights.value) && Number.isFinite(weights.exploration) && Number.isFinite(weights.cost);
    if (valid) {
      selection = {
        experimentId,
        enabledArms: [...new Set(enabledArms)],
        treatmentBasisPoints,
        thompsonPrior: { alpha0, beta0 },
        contextualWeights: weights,
      };
    }
  }
  let ordering: NormalizedSelectionExperiment['ordering'] = null;
  if (source.ordering && typeof source.ordering === 'object') {
    const raw = source.ordering;
    const treatmentBasisPoints = raw.treatmentBasisPoints ?? 0;
    const window = raw.window && typeof raw.window === 'object' ? raw.window : null;
    const hasBounds = window !== null &&
      (typeof window.publishedAfter === 'string' || typeof window.publishedBefore === 'string');
    // Identity precedence: an explicit ordering experimentId always wins;
    // only when ordering carries none may it fall back to the selection
    // experimentId. Ordering arm assignment, propensity, window attribution,
    // and persisted metadata therefore all use the resolved ordering identity.
    const rawOrderingId = typeof raw.experimentId === 'string' ? raw.experimentId.trim() : '';
    const experimentId = (rawOrderingId || selection?.experimentId || '').trim();
    const basisValid = Number.isInteger(treatmentBasisPoints) && treatmentBasisPoints >= 0 && treatmentBasisPoints <= 10000;
    let windowValid = true;
    if (hasBounds) {
      // Reuse the existing search-window contract (RFC3339 bounds, ordered
      // range, experiment id required) so malformed windows fail here with
      // 400 instead of surfacing inside experiment execution.
      try {
        buildWindowedSearchParams(
          {},
          {
            ...(typeof window!.publishedAfter === 'string' ? { publishedAfter: window!.publishedAfter } : {}),
            ...(typeof window!.publishedBefore === 'string' ? { publishedBefore: window!.publishedBefore } : {}),
          },
          experimentId
        );
      } catch {
        windowValid = false;
      }
    }
    if (
      basisValid &&
      experimentId.length > 0 &&
      (!hasBounds || windowValid) &&
      (window === null || hasBounds || typeof window === 'object')
    ) {
      ordering = {
        experimentId,
        treatmentBasisPoints,
        window: hasBounds
          ? {
              ...(typeof window!.publishedAfter === 'string' ? { publishedAfter: window!.publishedAfter } : {}),
              ...(typeof window!.publishedBefore === 'string' ? { publishedBefore: window!.publishedBefore } : {}),
            }
          : null,
      };
    }
  }
  let trial: NormalizedSelectionExperiment['trial'] = null;
  if (source.trial && typeof source.trial === 'object') {
    const raw = source.trial;
    const proposalId = typeof raw.proposalId === 'string' ? raw.proposalId.trim() : '';
    const maxQuota = raw.maxQuota ?? 100;
    const pageDepth = raw.pageDepth ?? 1;
    if (
      proposalId.length > 0 &&
      Number.isInteger(maxQuota) && maxQuota >= 1 && maxQuota <= 100 &&
      Number.isInteger(pageDepth) && pageDepth >= 1
    ) {
      trial = {
        proposalId,
        maxQuota,
        pageDepth,
        ...(typeof raw.trialKey === 'string' && raw.trialKey.trim() ? { trialKey: raw.trialKey.trim() } : {}),
      };
    }
  }
  let benchmark: NormalizedSelectionExperiment['benchmark'] = null;
  if (source.benchmark && typeof source.benchmark === 'object') {
    const raw = source.benchmark;
    const snapshotHash = typeof raw.snapshotHash === 'string' ? raw.snapshotHash.trim() : '';
    const poolRowId = raw.poolRowId;
    if (
      snapshotHash.length > 0 && snapshotHash.length <= 128 &&
      Number.isInteger(poolRowId) && (poolRowId as number) > 0
    ) {
      benchmark = { snapshotHash, poolRowId: poolRowId as number };
    }
  }
  return { selection, ordering, trial, benchmark };
}

/**
 * Route-level validator: returns the normalized experiment when the request
 * carries at least one valid dimension, otherwise throws INVALID_* so routes
 * fail closed with 400. A dimension that is present but invalid is rejected
 * explicitly (never silently dropped); an absent experiment (undefined/null)
 * returns null (no experiment requested — legacy path, not an error).
 */
export function validateSelectionExperimentRequest(input: unknown): NormalizedSelectionExperiment | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_EXPERIMENT_REQUEST');
  const source = input as SelectionExperimentRequest;
  const normalized = normalizeSelectionExperimentRequest(input);
  if (source.selection !== undefined && normalized.selection === null) throw new Error('INVALID_SELECTION_EXPERIMENT');
  if (source.ordering !== undefined && normalized.ordering === null) throw new Error('INVALID_ORDERING_EXPERIMENT');
  if (source.trial !== undefined && normalized.trial === null) throw new Error('INVALID_TRIAL_REQUEST');
  if (source.benchmark !== undefined && normalized.benchmark === null) throw new Error('INVALID_BENCHMARK_SCOPE');
  if (!normalized.selection && !normalized.ordering && !normalized.trial) {
    throw new Error('INVALID_EXPERIMENT_REQUEST');
  }
  return normalized;
}

export interface SelectionExperimentEvaluation {
  eligible: boolean;
  reason: SelectionExperimentEligibilityReason;
}

export function evaluateSelectionExperimentEligibility(
  selection: NormalizedSelectionExperiment['selection']
): SelectionExperimentEvaluation {
  if (!selection) return { eligible: false, reason: 'SELECTION_EXPERIMENT_NOT_REQUESTED' };
  if (!selection.experimentId) return { eligible: false, reason: 'INVALID_EXPERIMENT_ID' };
  if (!selection.enabledArms.length) return { eligible: false, reason: 'NO_ARMS_ENABLED' };
  return { eligible: true, reason: 'SELECTION_EXPERIMENT_ELIGIBLE' };
}

export interface SelectionExperimentAssignment {
  arm: SelectionExperimentArm;
  propensityBasisPoints: number;
  treatmentBasisPoints: number;
  bucket: number;
  armPickBucket: number | null;
  policyVersion: string;
}

/**
 * Deterministic arm assignment. treatmentBasisPoints=0 forces CONTROL.
 * Replay-safe: identical (experimentId, opportunityKey, config) inputs always
 * yield the identical arm; no Math.random anywhere on this path.
 */
export function assignSelectionExperimentArm(args: {
  experimentId: string;
  enabledArms: Array<'THOMPSON' | 'CONTEXTUAL'>;
  treatmentBasisPoints: number;
  opportunityKey: string;
}): SelectionExperimentAssignment {
  const { experimentId, enabledArms, treatmentBasisPoints, opportunityKey } = args;
  if (!opportunityKey.trim()) throw new Error('OPPORTUNITY_KEY_REQUIRED');
  const bucket = shaBucket(`${QUERY_SELECTION_EXPERIMENT_VERSION}:${experimentId}:${opportunityKey}`);
  if (treatmentBasisPoints === 0 || enabledArms.length === 0) {
    return { arm: 'CONTROL', propensityBasisPoints: 10000, treatmentBasisPoints, bucket, armPickBucket: null, policyVersion: QUERY_SELECTION_EXPERIMENT_VERSION };
  }
  if (bucket >= treatmentBasisPoints) {
    return { arm: 'CONTROL', propensityBasisPoints: 10000 - treatmentBasisPoints, treatmentBasisPoints, bucket, armPickBucket: null, policyVersion: QUERY_SELECTION_EXPERIMENT_VERSION };
  }
  const armPickBucket = shaBucket(`${QUERY_SELECTION_EXPERIMENT_VERSION}:${experimentId}:${opportunityKey}:arm`);
  const arm = enabledArms[armPickBucket % enabledArms.length];
  return {
    arm,
    propensityBasisPoints: Math.floor(treatmentBasisPoints / enabledArms.length),
    treatmentBasisPoints,
    bucket,
    armPickBucket,
    policyVersion: QUERY_SELECTION_EXPERIMENT_VERSION,
  };
}

export interface OrderingDimensionEvaluation {
  arm: 'CONTROL' | 'TREATMENT';
  propensityBasisPoints: number;
  policyVersion: string;
  windowApplied: boolean;
  window: { publishedAfter?: string; publishedBefore?: string } | null;
  experimentId: string | null;
}

/**
 * Evaluates the P2 ordering dimension independently of selection. Pure.
 * CONTROL never carries a treatment window: the window is applied if and
 * only if the deterministic assignment selected TREATMENT, so persisted
 * propensity/arm state always matches actual execution. Window bounds were
 * already validated at the route boundary; a defensive re-check here keeps
 * direct programmatic callers fail-closed too.
 */
export function evaluateOrderingDimension(args: {
  treatmentBasisPoints: number;
  window: { publishedAfter?: string; publishedBefore?: string } | null;
  experimentId: string;
  opportunityKey: string;
  /**
   * Opportunity scheduled_at for frozen-benchmark window derivation. Only
   * consulted on the frozen benchmark ordering path; all other identities
   * ignore it entirely.
   */
  scheduledAt?: Date;
}): OrderingDimensionEvaluation {
  const evaluated = selectOrderingExperimentArm(args.opportunityKey, args.treatmentBasisPoints);
  if (evaluated.arm === 'CONTROL') {
    return {
      arm: 'CONTROL',
      propensityBasisPoints: evaluated.propensityBasisPoints,
      policyVersion: evaluated.policyVersion,
      windowApplied: false,
      window: null,
      experimentId: null,
    };
  }
  if (args.experimentId === BENCHMARK_PREREG_ORDERING_EXPERIMENT_ID) {
    // Frozen benchmark path (benchmark-preregistration-v1 §3A/§6): a
    // TREATMENT assignment always carries the scheduled_at-derived 90-day
    // window. Caller-supplied bounds (present, absent, or divergent) never
    // reach the envelope, closing the unwindowed-treatment hole. There is
    // intentionally no application-clock fallback: a frozen TREATMENT
    // without a valid scheduledAt fails closed, because only the stored
    // PostgreSQL scheduled_at is authoritative for the executed window
    // (see resolveFrozenBenchmarkScheduleOrdering at schedule time).
    if (!(args.scheduledAt instanceof Date) || Number.isNaN(args.scheduledAt.getTime())) {
      throw new Error('BENCHMARK_ORDERING_SCHEDULED_AT_REQUIRED');
    }
    return {
      arm: 'TREATMENT',
      propensityBasisPoints: evaluated.propensityBasisPoints,
      policyVersion: evaluated.policyVersion,
      windowApplied: true,
      window: deriveBenchmarkOrderingWindow(args.scheduledAt),
      experimentId: args.experimentId,
    };
  }
  let windowApplied = false;
  let window: { publishedAfter?: string; publishedBefore?: string } | null = null;
  let windowExperimentId: string | null = null;
  if (args.window) {
    const applied = buildWindowedSearchParams({}, args.window, args.experimentId);
    windowApplied = applied.windowApplied;
    if (windowApplied) {
      window = {
        ...(typeof applied.params.publishedAfter === 'string' ? { publishedAfter: applied.params.publishedAfter } : {}),
        ...(typeof applied.params.publishedBefore === 'string' ? { publishedBefore: applied.params.publishedBefore } : {}),
      };
      windowExperimentId = applied.experimentId;
    }
  }
  return {
    arm: 'TREATMENT',
    propensityBasisPoints: evaluated.propensityBasisPoints,
    policyVersion: evaluated.policyVersion,
    windowApplied,
    window,
    experimentId: windowExperimentId,
  };
}

/**
 * Resolves the schedule-authoritative frozen ordering from the run's STORED
 * scheduled_at. The stored timestamp comes from INSERT ... RETURNING
 * scheduled_at (PostgreSQL now()) — never an application clock. Returns a
 * new ordering carrying the derived 90-day window when the envelope is a
 * frozen benchmark TREATMENT; otherwise returns the input reference
 * unchanged (reference equality signals "nothing to persist"). Pure.
 */
export function resolveFrozenBenchmarkScheduleOrdering(
  ordering: SelectionExperimentObservation['ordering'],
  storedScheduledAt: Date
): SelectionExperimentObservation['ordering'] {
  if (!ordering || ordering.arm !== 'TREATMENT' || ordering.experimentId !== BENCHMARK_PREREG_ORDERING_EXPERIMENT_ID) {
    return ordering;
  }
  return {
    ...ordering,
    windowApplied: true,
    window: deriveBenchmarkOrderingWindow(storedScheduledAt),
    experimentId: BENCHMARK_PREREG_ORDERING_EXPERIMENT_ID,
  };
}

/**
 * Resolves the job-payload search window from a persisted ordering envelope.
 * Returns undefined unless the envelope records a TREATMENT arm with an
 * applied, bounded window — CONTROL observations therefore never produce a
 * treatment window even if unrelated window fields exist on the run.
 * Pure; used at schedule time so execution only ever sees valid windows.
 */
export function resolveScheduledSearchWindow(
  ordering: SelectionExperimentObservation['ordering']
): { publishedAfter?: string; publishedBefore?: string; experimentId: string } | undefined {
  if (!ordering || ordering.arm !== 'TREATMENT' || !ordering.windowApplied || !ordering.window || !ordering.experimentId) {
    return undefined;
  }
  return { ...ordering.window, experimentId: ordering.experimentId };
}

/** Thompson observation mapping (thompson-observation-map-v1) from existing counters. */
export function buildThompsonObservationArms(pool: QueryRecord[]): Array<{ successes: number; failures: number }> {
  return pool.map(query => {
    const successes = Math.max(0, Math.floor(query.quality_channels_found ?? 0));
    const failures = Math.max(0, Math.floor(query.times_executed ?? 0) - successes);
    return { successes, failures };
  });
}

/** Contextual feature mapping (query-features-v1) from existing counters. */
export function buildContextualFeatureArms(pool: QueryRecord[]): Array<{
  expectedValue: number;
  uncertainty: number;
  coverageGap: number;
  cost: number;
}> {
  return pool.map(query => {
    const total = Math.max(0, query.total_channels_found ?? 0);
    const unique = Math.max(0, query.unique_channels_found ?? 0);
    return {
      expectedValue: (query.performance_score ?? 0) / 100,
      uncertainty: 1 / ((query.times_executed ?? 0) + 1),
      coverageGap: total > 0 ? Math.max(0, 1 - unique / total) : 1,
      cost: 1,
    };
  });
}

export interface PoolWinner {
  index: number;
  queryId: number;
  thompsonScores?: number[];
  contextualScores?: number[];
}

/**
 * Selects the winning pool index for a treatment arm using the existing
 * implementations only. Pool order MUST be eligible queries sorted by id
 * ascending (call sites guarantee this); the index resolves deterministically.
 */
export function selectPoolWinner(args: {
  pool: QueryRecord[];
  arm: 'THOMPSON' | 'CONTEXTUAL';
  opportunityKey: string;
  thompsonPrior: { alpha0: number; beta0: number };
  contextualWeights: { value: number; exploration: number; cost: number };
}): PoolWinner {
  const { pool, arm, opportunityKey } = args;
  if (!pool.length) throw new Error('NO_ARMS');
  if (arm === 'THOMPSON') {
    const arms = buildThompsonObservationArms(pool);
    // The existing implementation performs the selection verbatim with the
    // experiment's configured prior; scores are recomputed below with the
    // identical prior purely for the persisted observation envelope
    // (deterministic, same values). A configurable prior is therefore never
    // silently ignored: selection, scores, and provenance always agree.
    const best = selectThompsonArm(arms, opportunityKey, args.thompsonPrior);
    const scores = arms.map((counts, index) =>
      thompsonSample(counts.successes, counts.failures, `${opportunityKey}:${index}`, args.thompsonPrior.alpha0, args.thompsonPrior.beta0)
    );
    return { index: best, queryId: pool[best].id, thompsonScores: scores };
  }
  const features = buildContextualFeatureArms(pool);
  const scores = features.map(entry => contextualArmScore(entry, args.contextualWeights));
  let best = 0;
  scores.forEach((score, index) => {
    if (score > scores[best]) best = index;
  });
  return { index: best, queryId: pool[best].id, contextualScores: scores };
}

export interface SelectionExperimentObservation {
  experimentId: string;
  experimentVersion: string;
  /** Arm assigned by deterministic randomization. */
  requestedArm: SelectionExperimentArm;
  /** Arm whose selection actually produced the query (differs on fallback). */
  servedArm: SelectionExperimentArm;
  /**
   * Stable benchmark opportunity identity
   * (`benchmark-prereg-v1:pool:<snapshotHash>:<poolRowId>`). Present only
   * when the request designated a frozen pool scope AND the served query is
   * that designated row; retries share it while each attempt keeps its own
   * assignment draw under determinism.*. Absent otherwise, so
   * non-benchmark envelopes are byte-identical.
   */
  benchmarkOpportunityId?: string;
  propensityBasisPoints: number;
  allocationProbability: number;
  treatmentBasisPoints: number;
  eligibility: SelectionExperimentEligibilityReason;
  reason: string;
  determinism: {
    opportunityKey: string;
    bucket: number;
    armPickBucket: number | null;
    poolQueryIds: number[];
    poolSize: number;
  };
  selection: {
    winnerQueryId: number | null;
    winnerIndex: number | null;
    thompsonPrior: { alpha0: number; beta0: number };
    thompsonObservationMap: string;
    contextualWeights: { value: number; exploration: number; cost: number };
    contextualFeatureMap: string;
  };
  ordering?: {
    arm: 'CONTROL' | 'TREATMENT';
    propensityBasisPoints: number;
    policyVersion: string;
    windowApplied: boolean;
    window: { publishedAfter?: string; publishedBefore?: string } | null;
    experimentId: string | null;
  };
  provenance: {
    producer: 'query-selection-experiment';
    policyVersion: string;
    allocationChallengerVersion: string;
    retrievalExperimentVersion: string;
  };
}

/**
 * Builds the persisted observation envelope. Pure; JSON-safe.
 */
export function buildSelectionExperimentObservation(args: {
  experimentId: string;
  assignment: SelectionExperimentAssignment;
  eligibility: SelectionExperimentEligibilityReason;
  reason: string;
  opportunityKey: string;
  poolQueryIds: number[];
  winner: PoolWinner | null;
  thompsonPrior: { alpha0: number; beta0: number };
  contextualWeights: { value: number; exploration: number; cost: number };
  servedArm: SelectionExperimentArm;
  ordering?: SelectionExperimentObservation['ordering'];
  benchmarkOpportunityId?: string;
}): SelectionExperimentObservation {
  return {
    experimentId: args.experimentId,
    experimentVersion: QUERY_SELECTION_EXPERIMENT_VERSION,
    requestedArm: args.assignment.arm,
    servedArm: args.servedArm,
    ...(args.benchmarkOpportunityId ? { benchmarkOpportunityId: args.benchmarkOpportunityId } : {}),
    propensityBasisPoints: args.assignment.propensityBasisPoints,
    allocationProbability: args.assignment.propensityBasisPoints / 10000,
    treatmentBasisPoints: args.assignment.treatmentBasisPoints,
    eligibility: args.eligibility,
    reason: args.reason,
    determinism: {
      opportunityKey: args.opportunityKey,
      bucket: args.assignment.bucket,
      armPickBucket: args.assignment.armPickBucket,
      poolQueryIds: args.poolQueryIds,
      poolSize: args.poolQueryIds.length,
    },
    selection: {
      winnerQueryId: args.winner?.queryId ?? null,
      winnerIndex: args.winner?.index ?? null,
      thompsonPrior: args.thompsonPrior,
      thompsonObservationMap: THOMPSON_OBSERVATION_MAP_VERSION,
      contextualWeights: args.contextualWeights,
      contextualFeatureMap: QUERY_FEATURES_MAP_VERSION,
    },
    ...(args.ordering ? { ordering: args.ordering } : {}),
    provenance: {
      producer: 'query-selection-experiment',
      policyVersion: QUERY_SELECTION_EXPERIMENT_VERSION,
      allocationChallengerVersion: 'allocation-challenger-v1',
      retrievalExperimentVersion: RETRIEVAL_EXPERIMENT_VERSION,
    },
  };
}

/**
 * Resolves the persisted selection arm for a query_runs.metadata value.
 * FRONTIER_CANARY is an allocation dimension, not a selection arm, and is
 * intentionally not conflated here — callers combine both dimensions.
 */
export function resolvePersistedSelectionArm(metadata: unknown): SelectionExperimentArm {
  const arm = (metadata as { selectionExperiment?: { servedArm?: unknown } } | null)?.selectionExperiment?.servedArm;
  return arm === 'THOMPSON' || arm === 'CONTEXTUAL' ? arm : 'CONTROL';
}

export function reservableFilter(query: QueryRecord, now: Date): boolean {
  const reservedUntil = (query as QueryRecord & { reserved_until?: string | null }).reserved_until;
  const nextEligibleAt = (query as QueryRecord & { next_eligible_at?: string | null }).next_eligible_at;
  return (
    query.collection !== 'REJECTED' &&
    (!reservedUntil || new Date(reservedUntil) <= now) &&
    (!nextEligibleAt || new Date(nextEligibleAt) <= now)
  );
}

/**
 * Experimental selection entry point. CONTROL (or any ineligible/absent
 * experiment) delegates to selectNextQueryForCountry UNCHANGED and attaches
 * an envelope only when an experiment was actually requested. Treatment arms
 * reuse the planner eligibility pipeline (same cooldown/diversity/intent
 * rules as control) over a deterministically ordered pool.
 */
export async function selectExperimentalQueryForCountry(
  country: string,
  experiment: NormalizedSelectionExperiment | null | undefined,
  options: {
    opportunityKey: string;
    scopePromotionBasis?: 'PERSISTENT_SCOPE_SELECTION' | 'DIRECT_TARGET';
  }
): Promise<{
  queryRecord: QueryRecord;
  selectionStrategy: string;
  reason: string;
  experiment: SelectionExperimentObservation | null;
} | null> {
  const now = new Date();
  const cooldownMinutes = Math.max(
    1,
    Number(await getAppSetting('query_intelligence_query_cooldown_minutes', process.env.QUERY_INTELLIGENCE_COOLDOWN_MINUTES || '360')) || 360
  );
  const maxPrimaryUses = Math.max(
    1,
    Number(await getAppSetting('query_intelligence_primary_term_max_uses', process.env.QUERY_INTELLIGENCE_PRIMARY_TERM_MAX_USES || '2')) || 2
  );
  const selection = experiment?.selection ?? null;
  const eligibility = evaluateSelectionExperimentEligibility(selection);
  // Benchmark-designated restriction: when the request designates a frozen
  // pool row, every selection pool below narrows to that row, so a benchmark
  // attempt serves ONLY the designated row or nothing. Absent otherwise.
  const designatedRowIds = experiment?.benchmark ? [experiment.benchmark.poolRowId] : undefined;
  // Ordering is an independent dimension: it is evaluated even when no
  // selection experiment was requested, so ordering-only experiments reach
  // the retrieval treatment without requiring Thompson/Contextual.
  // Ordering identity precedence: an explicit ordering experimentId always
  // wins; only when ordering carries none may it fall back to the selection
  // experimentId (normalized ordering always carries one by validation).
  const orderingExperimentId = experiment?.ordering?.experimentId ?? selection?.experimentId ?? '';
  const ordering = experiment?.ordering
    ? evaluateOrderingDimension({
        treatmentBasisPoints: experiment.ordering.treatmentBasisPoints,
        window: experiment.ordering.window,
        experimentId: orderingExperimentId,
        opportunityKey: options.opportunityKey,
        scheduledAt: now,
      })
    : undefined;
  const delegateLegacy = async () => {
    const base = await selectNextQueryForCountry(country, { scopePromotionBasis: options.scopePromotionBasis, restrictToQueryIds: designatedRowIds });
    // Null preserves the producer's existing skip/continue contract: no
    // eligible query yields no candidate — never a cycle-failing exception
    // merely because the experimental wrapper is active.
    if (!base) return null;
    return { queryRecord: base.queryRecord, selectionStrategy: base.selectionStrategy, reason: base.reason };
  };
  if (!selection || !eligibility.eligible) {
    const base = await delegateLegacy();
    if (!base) return null;
    if (!ordering) return { ...base, experiment: null };
    const controlAssignment = assignSelectionExperimentArm({
      experimentId: orderingExperimentId,
      enabledArms: [],
      treatmentBasisPoints: 0,
      opportunityKey: options.opportunityKey,
    });
    return {
      ...base,
      experiment: buildSelectionExperimentObservation({
        experimentId: orderingExperimentId,
        assignment: controlAssignment,
        eligibility: 'SELECTION_EXPERIMENT_NOT_REQUESTED',
        reason: 'No selection experiment requested: UCB1 selection unchanged; ordering dimension evaluated independently.',
        opportunityKey: options.opportunityKey,
        thompsonPrior: { alpha0: 1, beta0: 1 },
        contextualWeights: { value: 0.5, exploration: 0.35, cost: 0.1 },
        poolQueryIds: [],
        winner: null,
        servedArm: 'CONTROL',
        ordering,
        benchmarkOpportunityId: benchmarkOpportunityIdForScope(experiment?.benchmark ?? null, base.queryRecord.id, experiment),
      }),
    };
  }
  const assignment = assignSelectionExperimentArm({
    experimentId: selection.experimentId,
    enabledArms: selection.enabledArms,
    treatmentBasisPoints: selection.treatmentBasisPoints,
    opportunityKey: options.opportunityKey,
  });
  const envelopeBase = {
    experimentId: selection.experimentId,
    assignment,
    eligibility: eligibility.reason,
    opportunityKey: options.opportunityKey,
    thompsonPrior: selection.thompsonPrior,
    contextualWeights: selection.contextualWeights,
    ...(ordering ? { ordering } : {}),
  };
  if (assignment.arm === 'CONTROL') {
    const base = await delegateLegacy();
    if (!base) return null;
    return {
      queryRecord: base.queryRecord,
      selectionStrategy: base.selectionStrategy,
      reason: base.reason,
      experiment: buildSelectionExperimentObservation({
        ...envelopeBase,
        reason: 'Control arm: UCB1 selection unchanged.',
        benchmarkOpportunityId: benchmarkOpportunityIdForScope(experiment?.benchmark ?? null, base.queryRecord.id, experiment),
        poolQueryIds: [],
        winner: null,
        servedArm: 'CONTROL',
      }),
    };
  }
  // Treatment: same eligibility pipeline as control (cooldown/diversity/intent),
  // deterministic pool order (id ascending) so arm indexes are replay-stable.
  // A benchmark-designated request narrows the pool to the designated row.
  const fetchedQueries = (await getQueriesByCountry(country)).filter(query => reservableFilter(query, now));
  const queries = restrictPoolToDesignatedRow(fetchedQueries, designatedRowIds);
  let eligible = limitRepeatedPrimaryTerms(queriesOutsideCooldown(queries, now, cooldownMinutes), queries, now, cooldownMinutes, maxPrimaryUses);
  eligible = rotateAwayFromMostRecentIntent(eligible, queries);
  eligible = [...eligible].sort((a, b) => a.id - b.id);
  if (!eligible.length) {
    const base = await delegateLegacy();
    if (!base) return null;
    return {
      queryRecord: base.queryRecord,
      selectionStrategy: base.selectionStrategy,
      reason: base.reason,
      experiment: buildSelectionExperimentObservation({
        ...envelopeBase,
        reason: 'Requested treatment arm but the eligible pool was empty; served UCB1 fallback.',
        benchmarkOpportunityId: benchmarkOpportunityIdForScope(experiment?.benchmark ?? null, base.queryRecord.id, experiment),
        poolQueryIds: [],
        winner: null,
        servedArm: 'CONTROL',
      }),
    };
  }
  const winner = selectPoolWinner({
    pool: eligible,
    arm: assignment.arm,
    opportunityKey: options.opportunityKey,
    thompsonPrior: selection.thompsonPrior,
    contextualWeights: selection.contextualWeights,
  });
  const selected = eligible[winner.index];
  return {
    queryRecord: selected,
    selectionStrategy: assignment.arm,
    reason: `${assignment.arm} experimental selection over ${eligible.length} eligible queries (pool hash order by id).`,
    experiment: buildSelectionExperimentObservation({
      ...envelopeBase,
      reason: `${assignment.arm} winner query #${selected.id} at pool index ${winner.index}.`,
      benchmarkOpportunityId: benchmarkOpportunityIdForScope(experiment?.benchmark ?? null, selected.id, experiment),
      poolQueryIds: eligible.map(query => query.id),
      winner,
      servedArm: assignment.arm,
    }),
  };
}
