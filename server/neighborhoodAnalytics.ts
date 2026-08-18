import type { QueryFunnelMetrics } from './queryPerformance';

export interface NeighborhoodObservationMetrics {
  totalResults: number;
  duplicateRatio: number;
  knownCreatorRatio: number;
  newCreatorRatio: number;
  relevantNewCreatorRatio: number;
  qualityNewCreatorRatio: number;
  jaccardSimilarity: number | null;
  resultSetOverlap: number | null;
  quotaConsumed: number;
  retrievalDepth: number;
  searchOrdering: string;
}

export interface RollingNeighborhoodTrend {
  recentYieldTrend: number[];
  recentOverlapTrend: number[];
  isSaturating: boolean;
}

/**
 * Calculates Jaccard similarity between two sets of channel IDs.
 * J(A, B) = |A ∩ B| / |A ∪ B|
 */
export function calculateJaccardSimilarity(setA: Set<string> | string[], setB: Set<string> | string[]): number {
  const a = new Set(setA);
  const b = new Set(setB);
  if (a.size === 0 && b.size === 0) return 0;

  let intersectionCount = 0;
  for (const item of a) {
    if (b.has(item)) intersectionCount++;
  }

  const unionCount = a.size + b.size - intersectionCount;
  return unionCount > 0 ? intersectionCount / unionCount : 0;
}

/**
 * Calculates result-set overlap between a new run's channel IDs and historical channel IDs.
 * Overlap = |Current ∩ Historical| / |Current|
 */
export function calculateResultSetOverlap(currentChannels: Set<string> | string[], historicalChannels: Set<string> | string[]): number {
  const current = new Set(currentChannels);
  const historical = new Set(historicalChannels);
  if (current.size === 0) return 0;

  let overlapCount = 0;
  for (const channelId of current) {
    if (historical.has(channelId)) overlapCount++;
  }

  return overlapCount / current.size;
}

/**
 * Derives neighborhood observation metrics from QueryFunnelMetrics and result channel IDs.
 */
export function deriveNeighborhoodObservationMetrics(
  funnel: QueryFunnelMetrics,
  currentChannelIds: string[],
  previousChannelIds: string[] | null,
  recentNeighborhoodChannelIds: string[] | null,
  attribution: {
    quotaConsumed?: number;
    retrievalDepth?: number;
    searchOrdering?: string;
  } = {}
): NeighborhoodObservationMetrics {
  const distinct = Math.max(1, funnel.distinctResults);
  const raw = Math.max(1, funnel.rawResults);

  const jaccard = previousChannelIds ? calculateJaccardSimilarity(currentChannelIds, previousChannelIds) : null;
  const overlap = recentNeighborhoodChannelIds ? calculateResultSetOverlap(currentChannelIds, recentNeighborhoodChannelIds) : null;

  return {
    totalResults: funnel.distinctResults,
    duplicateRatio: funnel.duplicateResults / raw,
    knownCreatorRatio: funnel.knownChannels / distinct,
    newCreatorRatio: funnel.newChannels / distinct,
    relevantNewCreatorRatio: Math.min(1.0, funnel.tradingConfirmed / distinct),
    qualityNewCreatorRatio: Math.min(1.0, funnel.qualityChannels / distinct),
    jaccardSimilarity: jaccard !== null ? Math.round(jaccard * 1000) / 1000 : null,
    resultSetOverlap: overlap !== null ? Math.round(overlap * 1000) / 1000 : null,
    quotaConsumed: attribution.quotaConsumed ?? 100,
    retrievalDepth: attribution.retrievalDepth ?? 1,
    searchOrdering: attribution.searchOrdering ?? 'RELEVANCE'
  };
}

/**
 * Evaluates rolling yield trends to provide evidence of saturation over time.
 * Note: Saturation is evidence, not an automatic rejection trigger.
 */
export function evaluateNeighborhoodTrend(
  recentYields: number[],
  recentOverlaps: number[]
): RollingNeighborhoodTrend {
  if (recentYields.length < 3) {
    return { recentYieldTrend: recentYields, recentOverlapTrend: recentOverlaps, isSaturating: false };
  }

  // Declining yield pattern (e.g. 60% -> 30% -> 10%) combined with high overlap (>70%)
  const latestYield = recentYields[recentYields.length - 1];
  const earliestYield = recentYields[0];
  const latestOverlap = recentOverlaps.length > 0 ? recentOverlaps[recentOverlaps.length - 1] : 0;

  const isDecliningYield = latestYield < earliestYield * 0.5 && latestYield < 0.15;
  const isHighOverlap = latestOverlap > 0.70;

  return {
    recentYieldTrend: recentYields,
    recentOverlapTrend: recentOverlaps,
    isSaturating: isDecliningYield && isHighOverlap
  };
}
