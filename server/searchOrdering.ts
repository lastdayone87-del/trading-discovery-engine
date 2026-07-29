import type { RetrievalLane } from './retrievalLanes';

export type SearchOrdering = 'RELEVANCE' | 'DATE';

/**
 * Allocates the experimental DATE policy without turning it into a retrieval
 * lane. CHANNEL runs always remain in the RELEVANCE control population.
 */
export function allocateSearchOrdering(
  lane: RetrievalLane,
  dateVideoRuns: number,
  totalVideoRuns: number,
  datePercent: number
): SearchOrdering {
  if (lane !== 'VIDEO') return 'RELEVANCE';
  const target = Math.min(100, Math.max(0, Number.isFinite(datePercent) ? datePercent : 0));
  return ((dateVideoRuns + 1) / (totalVideoRuns + 1)) * 100 <= target ? 'DATE' : 'RELEVANCE';
}

export function youtubeOrder(ordering: SearchOrdering): 'relevance' | 'date' {
  return ordering === 'DATE' ? 'date' : 'relevance';
}
