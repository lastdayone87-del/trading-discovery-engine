export type SegmentType =
  | 'COUNTRY'
  | 'LANGUAGE'
  | 'INTENT'
  | 'INSTRUMENT'
  | 'SOURCE'
  | 'CREATOR_SIZE'
  | 'ORDERING'
  | 'NEIGHBORHOOD';

export type CreatorSizeBand =
  | 'MICRO_<10K'
  | 'MID_10K_100K'
  | 'LARGE_100K_500K'
  | 'MAJOR_500K+'
  | 'UNKNOWN';

export interface BoundedSegmentHistory {
  segmentType: SegmentType;
  segmentKey: string;
  totalExecutions: number;
  totalQuotaConsumed: number;
  valuableNewCreators: number;
  totalNewCreators: number;
  totalDistinctCreators: number;
  uniqueSources: string[];
  averageOverlap: number;
  underexploredQuotaConsumed: number;
}

export interface SegmentHealthMetrics {
  segmentType: SegmentType;
  segmentKey: string;
  valuableNewCreators: number;
  quotaConsumed: number;
  yieldPer1000Quota: number;
  saturationScore: number;
  frontierExpansionRate: number;
  underexploredQuotaPercent: number;
  provenanceDiversity: number;
  coverageGapIdentified: boolean;
  totalExecutions: number;
  metadata?: Record<string, unknown>;
}

/**
 * Classifies subscriber count into creator-size bands purely for diagnostic breakdown.
 * Diagnostic only — NEVER used as a filter/threshold to reject small creators.
 */
export function classifyCreatorSizeBand(subscriberCount: number | string | undefined | null): CreatorSizeBand {
  if (subscriberCount === undefined || subscriberCount === null) return 'UNKNOWN';

  let num = typeof subscriberCount === 'number' ? subscriberCount : NaN;
  if (typeof subscriberCount === 'string') {
    const raw = subscriberCount.trim().toUpperCase();
    if (raw.endsWith('K')) num = parseFloat(raw) * 1_000;
    else if (raw.endsWith('M')) num = parseFloat(raw) * 1_000_000;
    else num = parseFloat(raw);
  }

  if (Number.isNaN(num) || num < 0) return 'UNKNOWN';
  if (num < 10_000) return 'MICRO_<10K';
  if (num < 100_000) return 'MID_10K_100K';
  if (num < 500_000) return 'LARGE_100K_500K';
  return 'MAJOR_500K+';
}

/**
 * Calculates real health diagnostics from a bounded historical window across any supported segment.
 */
export function calculateSegmentHealthFromHistory(
  history: BoundedSegmentHistory
): SegmentHealthMetrics {
  const totalExecutions = Math.max(1, history.totalExecutions);
  const totalQuota = Math.max(1, history.totalQuotaConsumed);

  const yieldPer1000 = Math.round((history.valuableNewCreators / totalQuota) * 1000 * 100) / 100;
  const saturationScore = Math.min(1.0, Math.max(0.0, Math.round(history.averageOverlap * 100) / 100));
  const frontierExpansionRate = Math.round((1.0 - saturationScore) * 100) / 100;
  const underexploredQuotaPercent = Math.min(100.0, Math.round((history.underexploredQuotaConsumed / totalQuota) * 100 * 10) / 10);
  const provenanceDiversity = Math.min(1.0, Math.round((history.uniqueSources.length / totalExecutions) * 100) / 100);

  // Coverage gap flagged if zero valuable creators found, low underexplored quota expenditure, or low execution history
  const coverageGapIdentified = history.valuableNewCreators === 0 || underexploredQuotaPercent < 15.0 || totalExecutions < 3;

  return {
    segmentType: history.segmentType,
    segmentKey: history.segmentKey,
    valuableNewCreators: history.valuableNewCreators,
    quotaConsumed: history.totalQuotaConsumed,
    yieldPer1000Quota: yieldPer1000,
    saturationScore,
    frontierExpansionRate,
    underexploredQuotaPercent,
    provenanceDiversity,
    coverageGapIdentified,
    totalExecutions
  };
}
