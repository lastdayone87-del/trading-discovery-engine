export type RetrievalLane = 'VIDEO' | 'CHANNEL';

/** Chooses the next lane that best closes the configured daily allocation gap. */
export function allocateRetrievalLane(videoRuns: number, totalRuns: number, videoPercent: number): RetrievalLane {
  const target = Math.min(100, Math.max(0, Number.isFinite(videoPercent) ? videoPercent : 70));
  return ((videoRuns + 1) / (totalRuns + 1)) * 100 <= target ? 'VIDEO' : 'CHANNEL';
}
