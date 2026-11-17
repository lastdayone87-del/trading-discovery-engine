import { gammaQuantile } from './queryQuality/posterior';

/**
 * Creator-only saturation evidence for a single query.
 *
 * This module deliberately knows nothing about Discord/community discovery.
 * Community enrichment is a downstream outcome and must not influence
 * creator-search dormancy.
 */
export interface QuerySaturationEvidence {
  /** Completed runs old enough for classification to have settled. */
  matureRuns: number;
  /** Distinct results in those mature runs whose classification is still pending. */
  pendingClassifications: number;
  /** Distinct creator results across the mature runs. */
  distinctResults: number;
  /** Persisted, previously unknown, trading-confirmed, country-accepted creators. */
  freshRelevantCreators: number;
  /** Subset of freshRelevantCreators with quality score >= 55. */
  freshQualityCreators: number;
  /** Known creators observed in those mature runs. */
  knownChannels: number;
  /** Provider duplicate results across the mature runs. */
  duplicateResults: number;
  /** Evaluated raw results across the mature runs (distinct + duplicates). */
  evaluatedRawResults: number;
  /** Official YouTube quota units actually consumed by those runs. */
  officialQuotaUnits: number;
  /** Comparable country/global fresh creators per run used as the prior baseline. */
  baselineFreshPerRun: number;
}

export interface QuerySaturationPolicy {
  /** Evidence is insufficient below this many mature runs. */
  minimumMatureRuns: number;
  /** A query is never judged while too much of its cohort is unclassified. */
  maximumPendingShare: number;
  /** Dormancy requires the creator-yield LCB to be below this fraction of baseline. */
  maximumLcbToBaselineRatio: number;
  /** Dormancy requires this known-creator share. */
  minimumKnownCreatorShare: number;
}

/**
 * Calibrated from the mature production cohort:
 * - the fresh-yield inflection begins around 7-10 runs;
 * - known-creator share is already 86.6% in the 7-10 bucket;
 * - pending classifications must never be treated as failures.
 *
 * These are defaults, not immutable product constants: the caller may pass a
 * calibrated policy and the decisions carry the policy used.
 */
export const DEFAULT_QUERY_SATURATION_POLICY: QuerySaturationPolicy = {
  minimumMatureRuns: 7,
  maximumPendingShare: 0.20,
  maximumLcbToBaselineRatio: 0.50,
  minimumKnownCreatorShare: 0.85,
};

export interface QuerySaturationMetrics {
  matureRuns: number;
  pendingShare: number;
  freshPerRun: number;
  freshQualityPerRun: number;
  knownCreatorShare: number;
  duplicateRate: number;
  quotaPerFreshCreator: number | null;
  freshPerRunLcb: number;
  baselineFreshPerRun: number;
}

export type QuerySaturationState = 'ACTIVE' | 'DORMANT' | 'INSUFFICIENT_EVIDENCE';

export interface QuerySaturationDecision {
  state: QuerySaturationState;
  reasons: string[];
  policy: QuerySaturationPolicy;
  metrics: QuerySaturationMetrics;
}

const safe = (value: number): number => Number.isFinite(value) && value > 0 ? value : 0;
const ratio = (numerator: number, denominator: number): number => denominator > 0 ? numerator / denominator : 0;

/**
 * Gamma-Poisson lower confidence bound in creators per run.
 *
 * A weak Gamma prior centered on the comparable baseline prevents a low-volume
 * query from becoming dormant from one or two unlucky runs. With no baseline
 * evidence the prior is neutral (shape 1, rate 1), so the observed data dominates
 * only after real exposure.
 */
function freshPerRunLowerBound(input: QuerySaturationEvidence): number {
  const baseline = Math.max(0, safe(input.baselineFreshPerRun));
  // No baseline means a neutral Gamma(1,1) prior, exactly as documented. A
  // baseline contributes three pseudo-exposure runs centered on its rate.
  const priorExposure = baseline > 0 ? 3 : 0;
  const priorFresh = baseline * priorExposure;
  const shape = 1 + priorFresh + safe(input.freshRelevantCreators);
  const rate = 1 + priorExposure + Math.max(0, input.matureRuns);
  return gammaQuantile(shape, rate, 0.05);
}

export function evaluateQuerySaturation(
  input: QuerySaturationEvidence,
  policy: QuerySaturationPolicy = DEFAULT_QUERY_SATURATION_POLICY,
): QuerySaturationDecision {
  // Never expose the module-level default object by reference: callers may
  // carry the policy in diagnostics and mutate it without intending to change
  // every later evaluation.
  const effectivePolicy: QuerySaturationPolicy = { ...policy };
  const matureRuns = Math.max(0, Math.floor(input.matureRuns));
  const assessed = Math.max(0, input.distinctResults);
  const pendingShare = ratio(Math.max(0, input.pendingClassifications), assessed);
  const freshPerRun = ratio(input.freshRelevantCreators, matureRuns);
  const knownCreatorShare = ratio(input.knownChannels, assessed);
  const duplicateRate = ratio(input.duplicateResults, Math.max(input.evaluatedRawResults, input.distinctResults));
  const metrics: QuerySaturationMetrics = {
    matureRuns,
    pendingShare,
    freshPerRun,
    freshQualityPerRun: ratio(input.freshQualityCreators, matureRuns),
    knownCreatorShare,
    duplicateRate,
    quotaPerFreshCreator: input.freshRelevantCreators > 0
      ? ratio(input.officialQuotaUnits, input.freshRelevantCreators)
      : null,
    freshPerRunLcb: freshPerRunLowerBound(input),
    baselineFreshPerRun: Math.max(0, safe(input.baselineFreshPerRun)),
  };

  const reasons: string[] = [];
  if (matureRuns < effectivePolicy.minimumMatureRuns) reasons.push('INSUFFICIENT_MATURE_RUNS');
  if (pendingShare > effectivePolicy.maximumPendingShare) reasons.push('CLASSIFICATION_PENDING_EXCEEDS_POLICY');
  if (reasons.length > 0) {
    return { state: 'INSUFFICIENT_EVIDENCE', reasons, policy: { ...effectivePolicy }, metrics };
  }

  const baseline = metrics.baselineFreshPerRun;
  const lcbThreshold = baseline > 0
    ? baseline * effectivePolicy.maximumLcbToBaselineRatio
    : effectivePolicy.maximumLcbToBaselineRatio;
  // Require both the point estimate and its lower confidence bound to be
  // below the comparable baseline. This prevents a small country or niche from
  // becoming dormant merely because its absolute sample is small: a market
  // producing at its own baseline rate remains active even with fewer runs.
  const lowPointEstimate = baseline > 0
    ? metrics.freshPerRun <= lcbThreshold
    : metrics.freshPerRun <= effectivePolicy.maximumLcbToBaselineRatio;
  const lowFreshLcb = lowPointEstimate && (baseline > 0
    ? metrics.freshPerRunLcb <= lcbThreshold
    : metrics.freshPerRunLcb <= effectivePolicy.maximumLcbToBaselineRatio);
  const highKnownShare = metrics.knownCreatorShare >= effectivePolicy.minimumKnownCreatorShare;
  if (lowFreshLcb) reasons.push('FRESH_CREATOR_YIELD_LCB_BELOW_BASELINE');
  if (highKnownShare) reasons.push('KNOWN_CREATOR_SHARE_HIGH');
  // Duplicate rate is diagnostic and contributes only alongside credible
  // low fresh yield; it never retires a query by itself.
  if (metrics.duplicateRate >= 0.5) reasons.push('DUPLICATE_RATE_HIGH');

  const dormant = lowFreshLcb && highKnownShare;
  return {
    state: dormant ? 'DORMANT' : 'ACTIVE',
    reasons: dormant ? reasons : reasons.filter(reason => reason === 'DUPLICATE_RATE_HIGH'),
    policy: { ...effectivePolicy },
    metrics,
  };
}
