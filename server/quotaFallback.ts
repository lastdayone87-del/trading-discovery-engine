/**
 * Provider capability boundary for the official-quota-exhaustion fallback.
 *
 * InnerTube is quota-free but it is not a drop-in replacement for every
 * official request: it has no sort-by-date and no publishedAfter/Before
 * window. A DATE-ordered or windowed run must therefore keep waiting for the
 * official quota reset instead of silently executing a different retrieval
 * treatment on InnerTube. Frontier/canary lineage is also excluded because the
 * frontier decision, not the execution worker, owns provider identity.
 */
export interface InnertubeQuotaFallbackInput {
  providerKey: string;
  searchOrdering: string;
  hasSearchWindow: boolean;
  retrievalTreatmentOrigin: string;
  allocationOrigin: string;
  hasTrial?: boolean;
}

export interface InnertubeQuotaFallbackDecision {
  eligible: boolean;
  reasonCodes: string[];
}

export function evaluateInnertubeQuotaFallback(
  input: InnertubeQuotaFallbackInput,
): InnertubeQuotaFallbackDecision {
  const reasonCodes: string[] = [];
  if (input.providerKey !== 'youtube-search') reasonCodes.push('PROVIDER_NOT_OFFICIAL');
  if (input.searchOrdering !== 'RELEVANCE') reasonCodes.push('ORDERING_NOT_RELEVANCE');
  if (input.hasSearchWindow) reasonCodes.push('SEARCH_WINDOW_UNSUPPORTED');
  if (input.retrievalTreatmentOrigin !== 'CONTROL') reasonCodes.push('RETRIEVAL_TREATMENT_ACTIVE');
  if (input.allocationOrigin === 'FRONTIER_CANARY') reasonCodes.push('FRONTIER_LINEAGE_IMMUTABLE');
  if (input.hasTrial) reasonCodes.push('TRIAL_ACTIVE');
  return { eligible: reasonCodes.length === 0, reasonCodes };
}

/**
 * InnerTube cursors are provider page numbers (REWALK), never opaque official
 * tokens. A run that already completed N pages resumes at provider page N+1.
 */
export function innertubeFallbackCursor(pagesCompleted: number): string {
  return String(Math.max(1, Math.trunc(pagesCompleted) + 1));
}

/**
 * True when a run can continue on InnerTube without mutating immutable
 * provider lineage: an in-flight run with completed official pages is handed
 * off through a continuation child instead of rewriting its provider columns.
 */
export function requiresContinuationHandoff(pagesCompleted: number): boolean {
  return Math.max(0, Math.trunc(pagesCompleted)) > 0;
}

export function quotaFallbackMetadata(input: {
  fromProvider: string;
  reason: string;
  pagesCompleted: number;
}): Record<string, unknown> {
  return {
    providerQuotaFallback: {
      fromProvider: input.fromProvider,
      toProvider: 'youtube-innertube',
      reason: input.reason,
      pagesCompleted: Math.max(0, Math.trunc(input.pagesCompleted)),
      appliedAt: new Date().toISOString(),
    },
  };
}
