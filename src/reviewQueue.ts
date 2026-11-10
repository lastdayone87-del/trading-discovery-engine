export interface ReviewQueuePage<T> {
  items: T[];
  total: number;
}

export interface ReviewQueuePageState {
  page: number;
  pageCount: number;
}

/** Parse the paginated review-queue contract without trusting the payload. */
export function parseReviewQueuePage<T extends { channelId: string }>(data: unknown): ReviewQueuePage<T> {
  const body = data as { items?: unknown; total?: unknown } | null;
  const items = Array.isArray(body?.items)
    ? body.items.filter((item): item is T => Boolean(item) && typeof (item as { channelId?: unknown }).channelId === 'string')
    : [];
  const rawTotal = body?.total;
  const total = typeof rawTotal === 'number' && Number.isInteger(rawTotal) && rawTotal >= 0
    ? rawTotal
    : items.length;
  return { items, total };
}

/** Keep the selected review only when it is still on the loaded page. */
export function selectionAfterQueueLoad<T extends { channelId: string }>(
  previous: string | null,
  items: T[],
): string | null {
  if (previous && items.some(item => item.channelId === previous)) return previous;
  return items[0]?.channelId || null;
}

export function reviewQueuePageState(total: number, offset: number, limit = 50): ReviewQueuePageState {
  const normalizedLimit = Math.max(1, limit);
  const normalizedOffset = Math.max(0, offset);
  return {
    page: Math.floor(normalizedOffset / normalizedLimit) + 1,
    pageCount: Math.max(1, Math.ceil(Math.max(0, total) / normalizedLimit)),
  };
}

export interface CreatorFocusSummary {
  mode: string;
  proposedStatus: string;
  effectiveStatus: string;
  probability: number | null;
  lowerConfidenceBound: number | null;
  documentCount: number;
  assertionCount: number;
  observedAt: string | null;
}

/** Non-authoritative display summary for the review console. */
export function creatorFocusSummary(snapshot: Record<string, unknown> | null | undefined): CreatorFocusSummary | null {
  if (!snapshot) return null;
  return {
    mode: typeof snapshot.mode === 'string' ? snapshot.mode : '—',
    proposedStatus: typeof snapshot.proposed_status === 'string' ? snapshot.proposed_status : '—',
    effectiveStatus: typeof snapshot.effective_status === 'string' ? snapshot.effective_status : 'UNCERTAIN',
    probability: typeof snapshot.probability === 'number' ? snapshot.probability : null,
    lowerConfidenceBound: typeof snapshot.lower_confidence_bound === 'number' ? snapshot.lower_confidence_bound : null,
    documentCount: Array.isArray(snapshot.document_keys) ? snapshot.document_keys.length : 0,
    assertionCount: Array.isArray(snapshot.assertion_keys) ? snapshot.assertion_keys.length : 0,
    observedAt: typeof snapshot.observed_at === 'string' ? snapshot.observed_at : null,
  };
}
