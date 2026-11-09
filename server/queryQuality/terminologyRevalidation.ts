/**
 * Saved query terminology revalidation.
 *
 * Query rows outlive the term observation that generated them. A term can be
 * demoted or lose search eligibility while the full query remains genuinely
 * useful. Blanket-deleting those queries would discard valid discovery
 * surfaces; keeping the stale attribution would make the dashboard/LCB report
 * a lifecycle that no longer exists.
 *
 * The selector therefore resolves one of three dispositions:
 * - CURRENT: the term is still trial/proven and search eligible.
 * - DIGEST: the term is stale/missing, but the query still passes its own
 *   admission and execution-authority gates. Keep the query and remove the
 *   stale terminology linkage from its runtime metadata.
 * - RETIRE: the term is stale and the query itself is no longer eligible. The
 *   normal admission/authority gates already exclude it.
 */
export interface SavedQueryTerminologyStatus {
  termId: number;
  term: string;
  lifecycleStatus: string;
  searchEligible: boolean;
}

export type SavedTerminologyDisposition = 'CURRENT' | 'DIGEST' | 'RETIRE';

const CURRENT_LIFECYCLES = new Set(['SEARCH_TRIAL', 'PROVEN_SEARCH_TERM']);

export function resolveSavedTerminologyDisposition(
  status: SavedQueryTerminologyStatus | undefined,
  queryEligible: boolean,
): SavedTerminologyDisposition {
  if (status && status.searchEligible && CURRENT_LIFECYCLES.has(status.lifecycleStatus)) return 'CURRENT';
  return queryEligible ? 'DIGEST' : 'RETIRE';
}

export function digestQueryTerminologyMetadata(
  metadata: Record<string, unknown> | null | undefined,
  status: SavedQueryTerminologyStatus | undefined,
  revalidatedAt: string,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(metadata || {}) };
  const previousTermId = next.terminologyId ?? null;
  const previousLifecycle = next.terminologyLifecycle ?? null;
  const previousDecayedYield = next.terminologyDecayedYield ?? null;
  delete next.terminologyId;
  delete next.terminologyLifecycle;
  delete next.terminologyDecayedYield;
  next.terminologyRevalidation = {
    disposition: 'DIGESTED',
    previousTermId,
    previousTerm: status?.term ?? null,
    previousLifecycle,
    previousSearchEligible: status?.searchEligible ?? null,
    previousDecayedYield,
    reason: status ? 'TERMINOLOGY_NOT_CURRENTLY_ELIGIBLE' : 'TERMINOLOGY_ROW_MISSING',
    revalidatedAt,
  };
  return next;
}
