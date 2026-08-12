import type { RetrievalLane } from './retrievalLanes';

export type SearchOrdering = 'RELEVANCE' | 'DATE';

/**
 * Allocates DATE ordering within the VIDEO lane without turning freshness into
 * a separate retrieval lane. Active-creator discovery needs enough date-ordered
 * traffic to avoid repeatedly surfacing historically relevant but dormant
 * channels. A positive configured DATE share therefore has a 50% safety floor;
 * operators can still explicitly disable DATE ordering with 0.
 */
export function allocateSearchOrdering(
  lane: RetrievalLane,
  dateVideoRuns: number,
  totalVideoRuns: number,
  datePercent: number
): SearchOrdering {
  if (lane !== 'VIDEO') return 'RELEVANCE';
  const requested = Math.min(100, Math.max(0, Number.isFinite(datePercent) ? datePercent : 50));
  const target = requested === 0 ? 0 : Math.max(50, requested);
  return ((dateVideoRuns + 1) / (totalVideoRuns + 1)) * 100 <= target ? 'DATE' : 'RELEVANCE';
}

export function youtubeOrder(ordering: SearchOrdering): 'relevance' | 'date' {
  return ordering === 'DATE' ? 'date' : 'relevance';
}
