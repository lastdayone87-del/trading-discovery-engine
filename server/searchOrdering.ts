import type { RetrievalLane } from './retrievalLanes';

export type SearchOrdering = 'RELEVANCE' | 'DATE';

/**
 * Allocates DATE ordering as a freshness lane without turning it into a separate
 * retrieval lane. CHANNEL runs always remain in the RELEVANCE control population.
 *
 * Autonomous discovery is intended to find currently active creators, so a tiny
 * DATE allocation is not enough: relevance-only searches can repeatedly surface
 * historically popular videos from dormant channels. Keep a configurable
 * freshness floor for VIDEO runs while preserving a meaningful relevance lane.
 * Setting DISCOVERY_RECENCY_FLOOR_PERCENT=0 disables the floor explicitly.
 */
export function allocateSearchOrdering(
  lane: RetrievalLane,
  dateVideoRuns: number,
  totalVideoRuns: number,
  datePercent: number
): SearchOrdering {
  if (lane !== 'VIDEO') return 'RELEVANCE';
  const configuredTarget = Math.min(100, Math.max(0, Number.isFinite(datePercent) ? datePercent : 0));
  const configuredFloor = Number(process.env.DISCOVERY_RECENCY_FLOOR_PERCENT ?? '60');
  const freshnessFloor = Math.min(100, Math.max(0, Number.isFinite(configuredFloor) ? configuredFloor : 60));
  const target = freshnessFloor === 0 ? configuredTarget : Math.max(configuredTarget, freshnessFloor);
  return ((dateVideoRuns + 1) / (totalVideoRuns + 1)) * 100 <= target ? 'DATE' : 'RELEVANCE';
}

export function youtubeOrder(ordering: SearchOrdering): 'relevance' | 'date' {
  return ordering === 'DATE' ? 'date' : 'relevance';
}
