/**
 * Stable code carried by YouTubeQuarantinedInputError. Kept dependency-free so
 * the job-failure policy can classify the error without importing the provider
 * implementation (which would create a db -> youtube -> db cycle).
 */
export const YOUTUBE_INPUT_QUARANTINED_CODE = 'YOUTUBE_INPUT_QUARANTINED';

export function isYouTubeInputQuarantineFailure(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === YOUTUBE_INPUT_QUARANTINED_CODE;
}

/** Only search-query quarantines justify cooling a query or failing the job
 * permanently. Channel-ID quarantines are handled by the enrichment lifecycle. */
export function isYouTubeSearchQueryQuarantineFailure(error: unknown): boolean {
  return isYouTubeInputQuarantineFailure(error)
    && (error as { inputKind?: unknown } | null)?.inputKind === 'searchQuery';
}
