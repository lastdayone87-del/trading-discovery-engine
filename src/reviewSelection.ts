/** A review decision is only valid for the currently selected pending review. */
/** A pinned lineage that could not be loaded must not be silently decided. */
export function reviewEvidenceIsDecidable(
  bundle: { warnings?: string[] } | null,
): boolean {
  const warnings = bundle?.warnings || [];
  return !warnings.includes('ELIGIBILITY_DECISION_NOT_FOUND')
    && !warnings.includes('CLASSIFICATION_DIAGNOSTIC_NOT_FOUND');
}

export function canSubmitReviewForSelection(
  bundle: { review?: { channelId?: string; state?: string } } | null,
  selectedChannelId: string | null,
): boolean {
  return Boolean(
    bundle?.review?.channelId
    && selectedChannelId
    && bundle.review.channelId === selectedChannelId
    && bundle.review.state === 'PENDING',
  );
}
