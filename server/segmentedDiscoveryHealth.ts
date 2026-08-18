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
 * Calculates health diagnostics for a specific population segment.
 */
export function calculateSegmentHealth(
  segmentType: SegmentType,
  segmentKey: string,
  data: {
    valuableNewCreators: number;
    totalQuotaConsumed: number;
    underexploredQuotaConsumed: number;
    averageOverlap: number;
    uniqueSources: string[];
    totalExecutions: number;
  }
): SegmentHealthMetrics {
  const quota = Math.max(1, data.totalQuotaConsumed);
  const yieldPer1000 = Math.round((data.valuableNewCreators / quota) * 1000 * 100) / 100;

  // Saturation score 0 to 1
  const saturationScore = Math.min(1.0, Math.max(0.0, Math.round(data.averageOverlap * 100) / 100));

  // Frontier expansion rate: inverse of saturation
  const frontierExpansionRate = Math.round((1.0 - saturationScore) * 100) / 100;

  // Underexplored quota %
  const underexploredQuotaPercent = Math.round((data.underexploredQuotaConsumed / quota) * 100 * 10) / 10;

  // Provenance diversity: ratio of unique discovery sources
  const provenanceDiversity = Math.min(1.0, Math.round((data.uniqueSources.length / Math.max(1, data.totalExecutions)) * 100) / 100);

  // Coverage gap identified if low yield or underexplored quota < 10%
  const coverageGapIdentified = data.valuableNewCreators === 0 || underexploredQuotaPercent < 10.0;

  return {
    segmentType,
    segmentKey,
    valuableNewCreators: data.valuableNewCreators,
    quotaConsumed: data.totalQuotaConsumed,
    yieldPer1000Quota: yieldPer1000,
    saturationScore,
    frontierExpansionRate,
    underexploredQuotaPercent,
    provenanceDiversity,
    coverageGapIdentified
  };
}
