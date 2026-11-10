/** A review decision is only valid for the currently selected pending review. */
/** A pinned lineage that could not be loaded must not be silently decided. */
const BLOCKING_LINEAGE_WARNINGS = new Set([
  'ELIGIBILITY_DECISION_MISSING',
  'ELIGIBILITY_DECISION_ID_MISSING',
  'ELIGIBILITY_DECISION_NOT_FOUND',
  'CLASSIFICATION_DIAGNOSTIC_MISSING',
  'CLASSIFICATION_DIAGNOSTIC_ID_MISSING',
  'CLASSIFICATION_DIAGNOSTIC_NOT_FOUND',
  'EVIDENCE_DOCUMENT_SCOPE_INCOMPLETE',
  'EVIDENCE_ASSERTION_SCOPE_INCOMPLETE',
  'EVIDENCE_DOCUMENT_SCOPE_MALFORMED',
  'EVIDENCE_ASSERTION_SCOPE_MALFORMED',
  'EVIDENCE_DOCUMENT_SCOPE_MISSING',
  'EVIDENCE_ASSERTION_SCOPE_MISSING',
]);

export function reviewEvidenceIsDecidable(
  bundle: { warnings?: string[] } | null,
): boolean {
  const warnings = bundle?.warnings || [];
  return !warnings.some(warning => BLOCKING_LINEAGE_WARNINGS.has(warning));
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
