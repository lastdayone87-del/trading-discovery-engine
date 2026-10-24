import type { QueryCollection } from '../src/types';

export type FunnelOutcome = 'COUNTRY_REJECTED' | 'NON_TRADING' | 'UNCERTAIN' | 'NEEDS_REVIEW' | 'TRADING_CONFIRMED';

/** Authoritative production threshold for a trading-confirmed creator to count as quality. */
export const QUALITY_CREATOR_SCORE_THRESHOLD = 55;

export function isQualityCreator(funnelOutcome: string, qualityScore: number): boolean {
  return funnelOutcome === 'TRADING_CONFIRMED' && qualityScore >= QUALITY_CREATOR_SCORE_THRESHOLD;
}

export interface QueryObservation {
  channelId: string;
  wasKnown: boolean;
  persisted: boolean;
  funnelOutcome: FunnelOutcome;
  qualityScore: number;
  hasCommunity: boolean;
  /**
   * Catalog scope validity for yield weighting. Absent on legacy observations
   * (treated as scope-neutral, never penalized).
   */
  scopeEligibility?: 'IN_SCOPE' | 'OUT_OF_SCOPE' | 'UNRESOLVED';
}

export interface QueryFunnelMetrics {
  rawResults: number;
  /**
   * Provider results that were deliberately not evaluated (for example a
   * sticky-PROBE channel deferred by its disabled allocation). They stay in
   * rawResults for reporting but are excluded from duplicate accounting.
   */
  deferredResults?: number;
  /** rawResults minus deferredResults; zero is safe for legacy rows. */
  evaluatedRawResults?: number;
  distinctResults: number;
  duplicateResults: number;
  knownChannels: number;
  newChannels: number;
  /**
   * Persisted new channels that are not OUT_OF_SCOPE. Optional for backward
   * compatibility: absent means unknown scope (treated as all in-scope,
   * identical to legacy yield). Terminology yield is weighted by this when
   * present so queries surfacing out-of-scope cohorts earn no learning
   * credit for them.
   */
  inScopeNewChannels?: number;
  countryRejected: number;
  nonTrading: number;
  uncertain: number;
  needsReview: number;
  tradingConfirmed: number;
  qualityChannels: number;
  communitiesDiscovered: number;
  averageQualityScore: number;
  noveltyRatio: number;
  countryPrecision: number;
  tradingPrecision: number;
  performanceScore: number;
}

const ratio = (numerator: number, denominator: number): number => denominator > 0 ? numerator / denominator : 0;

export function calculateQueryFunnel(
  rawResults: number,
  observations: QueryObservation[],
  deferredResults: number = 0,
): QueryFunnelMetrics {
  // A deferred provider result was never evaluated, so counting it as a
  // duplicate (or as a country miss) makes a normal page look low-yield and
  // can stop pagination before later eligible results. Keep rawResults intact
  // for reporting and subtract only the deferred share from duplicate math.
  const deferred = Math.max(0, Math.min(rawResults, Math.floor(deferredResults)));
  const evaluatedRawResults = rawResults - deferred;
  const distinct = new Map<string, QueryObservation>();
  for (const observation of observations) if (!distinct.has(observation.channelId)) distinct.set(observation.channelId, observation);
  const values = [...distinct.values()];
  const count = (outcome: FunnelOutcome) => values.filter(value => value.funnelOutcome === outcome).length;
  const countryRejected = count('COUNTRY_REJECTED');
  const nonTrading = count('NON_TRADING');
  const uncertain = count('UNCERTAIN');
  const needsReview = count('NEEDS_REVIEW');
  const tradingConfirmed = count('TRADING_CONFIRMED');
  const evaluated = nonTrading + uncertain + needsReview + tradingConfirmed;
  const persisted = values.filter(value => value.persisted);
  const fresh = values.filter(value => value.persisted && !value.wasKnown);
  const scoped = values.filter(value => value.scopeEligibility !== undefined);
  // Neutral default: with no scope signal anywhere, every fresh channel counts
  // as in-scope (identical to legacy yield). Once scope is observed, IN_SCOPE
  // and legacy-missing observations earn credit, while explicitly observed
  // OUT_OF_SCOPE and UNRESOLVED do not: missing scope stays scope-neutral
  // (backward compatible), but observed non-eligibility must never train
  // retrieval. This matches aggregatePageMetrics, where legacy pages
  // contribute their full fresh count and only scoped pages are filtered.
  const inScopeFresh = scoped.length === 0
    ? fresh
    : fresh.filter(value => value.scopeEligibility === undefined || value.scopeEligibility === 'IN_SCOPE');
  const qualityChannels = values.filter(value => isQualityCreator(value.funnelOutcome, value.qualityScore)).length;
  const communitiesDiscovered = values.filter(value => value.funnelOutcome === 'TRADING_CONFIRMED' && value.hasCommunity).length;
  const averageQualityScore = persisted.length
    ? Math.round(persisted.reduce((sum, value) => sum + value.qualityScore, 0) / persisted.length)
    : 0;
  const noveltyRatio = ratio(values.filter(value => value.persisted && !value.wasKnown).length, values.length);
  const countryPrecision = ratio(values.length - countryRejected, values.length);
  const tradingPrecision = ratio(tradingConfirmed, evaluated);
  const qualityYield = ratio(qualityChannels, evaluated);
  const communityYield = ratio(communitiesDiscovered, evaluated);
  const performanceScore = Math.round(100 * (
    0.30 * tradingPrecision +
    0.25 * noveltyRatio +
    0.20 * qualityYield +
    0.15 * countryPrecision +
    0.10 * communityYield
  ));

  return {
    rawResults,
    deferredResults: deferred,
    evaluatedRawResults,
    distinctResults: values.length,
    duplicateResults: Math.max(0, evaluatedRawResults - values.length),
    knownChannels: values.filter(value => value.wasKnown).length,
    newChannels: values.filter(value => value.persisted && !value.wasKnown).length,
    inScopeNewChannels: inScopeFresh.length,
    countryRejected,
    nonTrading,
    uncertain,
    needsReview,
    tradingConfirmed,
    qualityChannels,
    communitiesDiscovered,
    averageQualityScore,
    noveltyRatio,
    countryPrecision,
    tradingPrecision,
    performanceScore
  };
}

/**
 * Manual-search continuation inputs with deferred (not evaluated) channels
 * removed from the novelty/precision denominator. Manual pages are
 * operator-driven and do not use calculateQueryFunnel, but they share the
 * same failure mode: a deferred channel must not look like a country miss or
 * a duplicate. The raw provider IDs stay available for the stored page audit.
 */
export function manualSearchContinuationMetrics(input: {
  rawIds: string[];
  uniqueIds: string[];
  deferredIds: string[];
  previousIds: string[];
  countryAccepted: number;
  confirmedCount: number;
  communityCount: number;
}): {
  evaluatedUniqueIds: string[];
  novelIds: string[];
  deferredOnly: boolean;
  distinctCreators: number;
  noveltyRatio: number;
  duplicateRatio: number;
  countryPrecision: number;
  communityDiversity: number;
} {
  const deferred = new Set(input.deferredIds);
  const previous = new Set(input.previousIds);
  const evaluatedUniqueIds = input.uniqueIds.filter(id => !deferred.has(id));
  const deferredRawCount = input.rawIds.filter(id => deferred.has(id)).length;
  const evaluatedRawCount = Math.max(0, input.rawIds.length - deferredRawCount);
  const novelIds = evaluatedUniqueIds.filter(id => !previous.has(id));
  return {
    evaluatedUniqueIds,
    novelIds,
    deferredOnly: evaluatedUniqueIds.length === 0 && deferred.size > 0,
    distinctCreators: evaluatedUniqueIds.length,
    noveltyRatio: evaluatedUniqueIds.length ? novelIds.length / evaluatedUniqueIds.length : 0,
    duplicateRatio: evaluatedRawCount
      ? Math.max(0, 1 - novelIds.length / evaluatedRawCount)
      : deferred.size ? 0 : 1,
    countryPrecision: evaluatedUniqueIds.length ? input.countryAccepted / evaluatedUniqueIds.length : 0,
    communityDiversity: input.confirmedCount ? input.communityCount / input.confirmedCount : 0,
  };
}

/**
 * A query that produces a sufficiently large, overwhelmingly unresolved or
 * non-trading cohort is unsafe to recycle through autonomous exploration.
 * Quarantine it after the first bad run instead of requiring a second flood to
 * cross the historical performance threshold. This is country-neutral and is
 * based only on observed retrieval outcomes.
 */
export function isSeverelyContaminatedQuery(metrics: QueryFunnelMetrics): boolean {
  const evaluated = metrics.nonTrading + metrics.uncertain + metrics.needsReview + metrics.tradingConfirmed;
  if (metrics.distinctResults < 8 || evaluated < 8) return false;
  const unresolvedOrNonTrading = metrics.nonTrading + metrics.uncertain + metrics.needsReview;
  const contaminationRatio = ratio(unresolvedOrNonTrading, evaluated);
  return contaminationRatio >= 0.8 && metrics.tradingPrecision <= 0.1 && metrics.qualityChannels === 0;
}

export function selectQueryCollection(current: QueryCollection, priorRuns: number, metrics: QueryFunnelMetrics): QueryCollection {
  const totalRuns = priorRuns + 1;
  if (isSeverelyContaminatedQuery(metrics)) return 'REJECTED';
  if (metrics.performanceScore >= 60) return 'PROVEN';
  if (metrics.performanceScore < 25 && totalRuns >= 2) return 'REJECTED';
  return current === 'REJECTED' ? 'REJECTED' : 'EXPERIMENTAL';
}
