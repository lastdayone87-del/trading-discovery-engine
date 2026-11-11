export const BLOCKING_REVIEW_EVIDENCE_WARNINGS = new Set([
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
  'EVIDENCE_DOCUMENT_SCOPE_TRUNCATED',
  'EVIDENCE_ASSERTION_SCOPE_TRUNCATED',
]);

/** Return the warnings that make a review decision unsafe to record. */
export function reviewEvidenceWarningsBlockDecision(warnings?: string[] | null): string[] {
  return (warnings || []).filter(warning => BLOCKING_REVIEW_EVIDENCE_WARNINGS.has(warning));
}

/** A pinned lineage that could not be loaded must not be silently decided. */
export function reviewEvidenceIsDecidable(
  bundle: { warnings?: string[] } | null,
): boolean {
  return reviewEvidenceWarningsBlockDecision(bundle?.warnings).length === 0;
}
