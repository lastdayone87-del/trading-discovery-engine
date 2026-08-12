export type RetrievalLane = 'VIDEO' | 'CHANNEL';

/**
 * Chooses the next lane that best closes the configured daily allocation gap.
 *
 * Active-creator discovery is primarily a video-retrieval problem: recent video
 * documents carry publish timestamps and let the pipeline prove that a creator
 * is still producing content. Channel search remains a bounded breadth lane for
 * creators whose channel identity is easier to retrieve than an individual
 * upload. A positive configured VIDEO share therefore has an 85% safety floor;
 * operators can still explicitly disable VIDEO retrieval with 0.
 */
export function allocateRetrievalLane(videoRuns: number, totalRuns: number, videoPercent: number): RetrievalLane {
  const requested = Math.min(100, Math.max(0, Number.isFinite(videoPercent) ? videoPercent : 85));
  const target = requested === 0 ? 0 : Math.max(85, requested);
  return ((videoRuns + 1) / (totalRuns + 1)) * 100 <= target ? 'VIDEO' : 'CHANNEL';
}
