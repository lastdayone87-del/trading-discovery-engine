export interface NeighborhoodObservationMetrics {
  totalResults: number;
  duplicateRatio: number;
  knownCreatorRatio: number;
  newCreatorRatio: number;
  relevantNewCreatorRatio: number;
  qualityNewCreatorRatio: number;
  relevantNewCreatorsCount: number;
  qualityNewCreatorsCount: number;
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
 * Derives neighborhood observation metrics.
 * Note: relevantNewCreatorsCount and qualityNewCreatorsCount MUST be the actual intersection
 * of NEW (previously unseen) creators that are trading-confirmed / quality-qualified.
 * Aggregate counts including known creators must NEVER earn new creator yield credit.
 */
export function deriveNeighborhoodObservationMetrics(
  funnel: {
    rawResults: number;
    distinctResults: number;
    duplicateResults: number;
    knownChannels: number;
    newChannels: number;
  },
  counts: {
    relevantNewCreatorsCount: number; // new ∩ tradingConfirmed
    qualityNewCreatorsCount: number;  // new ∩ qualityQualified
  },
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

  // Enforce boundary constraint: new creator intersections cannot exceed actual total new channels
  const relevantNewCreatorsCount = Math.max(0, Math.min(funnel.newChannels, counts.relevantNewCreatorsCount));
  const qualityNewCreatorsCount = Math.max(0, Math.min(funnel.newChannels, counts.qualityNewCreatorsCount));

  return {
    totalResults: funnel.distinctResults,
    duplicateRatio: funnel.duplicateResults / raw,
    knownCreatorRatio: funnel.knownChannels / distinct,
    newCreatorRatio: funnel.newChannels / distinct,
    relevantNewCreatorRatio: relevantNewCreatorsCount / distinct,
    qualityNewCreatorRatio: qualityNewCreatorsCount / distinct,
    relevantNewCreatorsCount,
    qualityNewCreatorsCount,
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
