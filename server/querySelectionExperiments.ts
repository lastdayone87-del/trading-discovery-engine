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
import { selectNextQueryForCountry } from './queryIntelligence';
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
}

export interface SelectionExperimentTrialConfig {
  proposalId?: string;
  maxQuota?: number;
  pageDepth?: number;
  trialKey?: string;
}

export interface SelectionExperimentRequest {
  selection?: SelectionExperimentSelectionConfig;
  ordering?: SelectionExperimentOrderingConfig;
  trial?: SelectionExperimentTrialConfig;
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
    treatmentBasisPoints: number;
    window: { publishedAfter?: string; publishedBefore?: string } | null;
  } | null;
  trial: NormalizedTrialRequest | null;
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
    if (
      Number.isInteger(treatmentBasisPoints) && treatmentBasisPoints >= 0 && treatmentBasisPoints <= 10000 &&
      (window === null || typeof window.publishedAfter === 'string' || typeof window.publishedBefore === 'string')
    ) {
      ordering = {
        treatmentBasisPoints,
        window: window ? { ...(typeof window.publishedAfter === 'string' ? { publishedAfter: window.publishedAfter } : {}), ...(typeof window.publishedBefore === 'string' ? { publishedBefore: window.publishedBefore } : {}) } : null,
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
  return { selection, ordering, trial };
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
    // The existing implementation performs the selection verbatim; scores
    // are recomputed below with identical inputs purely for the persisted
    // observation envelope (deterministic, same values).
    const best = selectThompsonArm(arms, opportunityKey);
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
}): SelectionExperimentObservation {
  return {
    experimentId: args.experimentId,
    experimentVersion: QUERY_SELECTION_EXPERIMENT_VERSION,
    requestedArm: args.assignment.arm,
    servedArm: args.servedArm,
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

function reservableFilter(query: QueryRecord, now: Date): boolean {
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
}> {
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
  const noEnvelope = async (): Promise<{
    queryRecord: QueryRecord;
    selectionStrategy: string;
    reason: string;
    experiment: null;
  }> => {
    const base = await selectNextQueryForCountry(country, { scopePromotionBasis: options.scopePromotionBasis });
    if (!base) throw new Error('QUERY_INTELLIGENCE_NO_ELIGIBLE_QUERY');
    return { queryRecord: base.queryRecord, selectionStrategy: base.selectionStrategy, reason: base.reason, experiment: null };
  };
  if (!selection || !eligibility.eligible) {
    return noEnvelope();
  }
  const assignment = assignSelectionExperimentArm({
    experimentId: selection.experimentId,
    enabledArms: selection.enabledArms,
    treatmentBasisPoints: selection.treatmentBasisPoints,
    opportunityKey: options.opportunityKey,
  });
  const ordering = experiment?.ordering
    ? (() => {
        const evaluated = selectOrderingExperimentArm(options.opportunityKey, experiment.ordering!.treatmentBasisPoints);
        const windowed = buildWindowedSearchParams({}, experiment.ordering!.window, selection.experimentId);
        return {
          arm: evaluated.arm,
          propensityBasisPoints: evaluated.propensityBasisPoints,
          policyVersion: evaluated.policyVersion,
          windowApplied: windowed.windowApplied,
          window: windowed.windowApplied
            ? {
                ...(typeof experiment.ordering!.window?.publishedAfter === 'string' ? { publishedAfter: experiment.ordering!.window!.publishedAfter } : {}),
                ...(typeof experiment.ordering!.window?.publishedBefore === 'string' ? { publishedBefore: experiment.ordering!.window!.publishedBefore } : {}),
              }
            : null,
          experimentId: windowed.experimentId,
        };
      })()
    : undefined;
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
    const base = await selectNextQueryForCountry(country, { scopePromotionBasis: options.scopePromotionBasis });
    if (!base) throw new Error('QUERY_INTELLIGENCE_NO_ELIGIBLE_QUERY');
    return {
      queryRecord: base.queryRecord,
      selectionStrategy: base.selectionStrategy,
      reason: base.reason,
      experiment: buildSelectionExperimentObservation({
        ...envelopeBase,
        reason: 'Control arm: UCB1 selection unchanged.',
        poolQueryIds: [],
        winner: null,
        servedArm: 'CONTROL',
      }),
    };
  }
  // Treatment: same eligibility pipeline as control (cooldown/diversity/intent),
  // deterministic pool order (id ascending) so arm indexes are replay-stable.
  const queries = (await getQueriesByCountry(country)).filter(query => reservableFilter(query, now));
  let eligible = limitRepeatedPrimaryTerms(queriesOutsideCooldown(queries, now, cooldownMinutes), queries, now, cooldownMinutes, maxPrimaryUses);
  eligible = rotateAwayFromMostRecentIntent(eligible, queries);
  eligible = [...eligible].sort((a, b) => a.id - b.id);
  if (!eligible.length) {
    const base = await selectNextQueryForCountry(country, { scopePromotionBasis: options.scopePromotionBasis });
    if (!base) throw new Error('QUERY_INTELLIGENCE_NO_ELIGIBLE_QUERY');
    return {
      queryRecord: base.queryRecord,
      selectionStrategy: base.selectionStrategy,
      reason: base.reason,
      experiment: buildSelectionExperimentObservation({
        ...envelopeBase,
        reason: 'Requested treatment arm but the eligible pool was empty; served UCB1 fallback.',
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
      poolQueryIds: eligible.map(query => query.id),
      winner,
      servedArm: assignment.arm,
    }),
  };
}
