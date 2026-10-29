import type { QueryQualityVector } from './types';

export const QUERY_QUALITY_VECTOR_VERSION = 'query-quality-vector-v1';

export interface RunAccountingInput {
  rawResults?: number;
  distinctResults?: number;
  duplicateResults?: number;
  knownChannels?: number;
  newChannels?: number;
  /** Result-level globally new confirmed creators (sighting-level truth). */
  newConfirmedCreators?: number;
  /** Result-level globally new confirmed creators with quality score >= 55. */
  newQualityCreators?: number;
  countryRejected?: number;
  tradingConfirmed?: number;
  qualityChannels?: number;
  quotaUsed?: number;
  providerDegraded?: boolean;
  failed?: boolean;
  targetMarketConfirmed?: number;
  languageMatchedConfirmed?: number;
  semanticOverlapResults?: number;
  invalidQuery?: boolean;
}

const safe = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const ratio = (numerator: number, denominator: number): number => denominator > 0 ? numerator / denominator : 0;

/**
 * Build the per-run quality scorecard. `newConfirmedCreators` is deliberately
 * a result-level count supplied by sighting-level truth; page-local sums and
 * cumulative `query_library.unique_channels_found` are never reward sources.
 */
export function buildQueryQualityVector(input: RunAccountingInput): QueryQualityVector {
  const rawResults = safe(input.rawResults);
  const distinctResults = safe(input.distinctResults);
  const newChannels = safe(input.newChannels);
  const newConfirmedCreators = safe(input.newConfirmedCreators);
  const newQualityCreators = safe(input.newQualityCreators);
  const quotaUsed = safe(input.quotaUsed);
  const quotaUnits = quotaUsed / 100;
  const duplicateResults = safe(input.duplicateResults);
  const countryRejected = safe(input.countryRejected);
  return {
    version: QUERY_QUALITY_VECTOR_VERSION,
    rawResults,
    distinctResults,
    newChannels,
    newConfirmedCreators,
    newQualityCreators,
    quotaUsed,
    quotaUnits,
    confirmedNewCreatorsPer100Quota: quotaUnits > 0 ? newConfirmedCreators / quotaUnits : 0,
    qualityNewCreatorsPer100Quota: quotaUnits > 0 ? newQualityCreators / quotaUnits : 0,
    duplicateRatio: ratio(duplicateResults, rawResults || distinctResults + duplicateResults),
    semanticOverlapRatio: ratio(safe(input.semanticOverlapResults), distinctResults),
    invalidQueryRate: input.invalidQuery ? 1 : 0,
    zeroResultRate: rawResults === 0 ? 1 : 0,
    // An explicit zero is a measurement, not a missing value. Only an absent
    // input falls back to the conservative aggregate proxy.
    targetMarketPrecision: ratio(
      input.targetMarketConfirmed === undefined
        ? Math.max(0, distinctResults - countryRejected)
        : safe(input.targetMarketConfirmed),
      distinctResults,
    ),
    languageMatchRate: ratio(
      input.languageMatchedConfirmed === undefined ? newConfirmedCreators : safe(input.languageMatchedConfirmed),
      newConfirmedCreators || distinctResults,
    ),
    providerDegraded: input.providerDegraded === true,
    failedRun: input.failed === true,
  };
}

/** Primary reward; provider failure and zero-quota runs are ineligible. */
export function rewardRate(vector: QueryQualityVector): { eligible: boolean; rate: number; reasonCodes: string[] } {
  if (vector.failedRun) return { eligible: false, rate: 0, reasonCodes: ['FAILED_RUN_EXCLUDED'] };
  if (vector.providerDegraded) return { eligible: false, rate: 0, reasonCodes: ['PROVIDER_FAILURE_EXCLUDED'] };
  if (vector.quotaUsed <= 0) return { eligible: false, rate: 0, reasonCodes: ['ZERO_QUOTA_EXCLUDED'] };
  return { eligible: true, rate: vector.confirmedNewCreatorsPer100Quota, reasonCodes: [] };
}

/** Promotion/contamination guard: zero-confirm can never be PROVEN. */
export function canPromoteToProven(input: {
  completedRuns: number;
  minRuns: number;
  lcb: number;
  threshold: number;
  newConfirmedCreators: number;
  duplicateRatio: number;
  invalidQueryRate: number;
}): { eligible: boolean; reasonCodes: string[] } {
  const reasons: string[] = [];
  if (input.completedRuns < input.minRuns) reasons.push('INSUFFICIENT_COMPLETED_RUNS');
  if (input.newConfirmedCreators <= 0) reasons.push('ZERO_CONFIRM_CANNOT_PROVE');
  if (input.lcb < input.threshold) reasons.push('LCB_BELOW_PROMOTION_THRESHOLD');
  if (input.duplicateRatio >= 0.8) reasons.push('DUPLICATE_SATURATED');
  if (input.invalidQueryRate > 0) reasons.push('INVALID_QUERY_INELIGIBLE');
  return { eligible: reasons.length === 0, reasonCodes: reasons };
}

/** Recalibrated contamination guard: UNCERTAIN is not contamination. */
export function isContaminatedRun(input: { invalidQuery?: boolean; providerDegraded?: boolean; wrongCountry?: boolean; duplicateRatio?: number; nonTrading?: number; evaluated?: number; uncertain?: number }): boolean {
  if (input.invalidQuery) return true;
  if (input.providerDegraded) return false;
  if (input.wrongCountry) return true;
  if ((input.duplicateRatio || 0) >= 0.9) return true;
  const evaluated = safe(input.evaluated);
  const nonTrading = safe(input.nonTrading);
  // UNCERTAIN/NEEDS_REVIEW are not evidence of a bad query; only a strong
  // explicit non-trading share can contaminate the query's own reward.
  return evaluated > 0 && nonTrading / evaluated >= 0.9;
}

/** Attribution path: term sense -> relation -> family -> surface. */
export function buildAttribution(input: {
  termSense: string;
  relation: string;
  compositionFamily: string;
  surface: string;
  country: string;
  market: string;
  language: string;
  vector: QueryQualityVector;
}): Record<string, unknown> {
  return {
    version: QUERY_QUALITY_VECTOR_VERSION,
    termSense: input.termSense,
    relation: input.relation,
    compositionFamily: input.compositionFamily,
    surface: input.surface,
    country: input.country,
    market: input.market,
    language: input.language,
    ...input.vector,
  };
}
