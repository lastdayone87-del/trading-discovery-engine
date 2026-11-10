import assert from 'node:assert/strict';
import test from 'node:test';
import { canSubmitReviewForSelection, reviewEvidenceIsDecidable } from '../src/reviewSelection';

test('a review can only be submitted for the selected pending channel', () => {
  const bundle = { review: { channelId: 'chan-1', state: 'PENDING' } };
  assert.equal(canSubmitReviewForSelection(bundle, 'chan-1'), true);
  assert.equal(canSubmitReviewForSelection(bundle, 'chan-2'), false);
  assert.equal(canSubmitReviewForSelection({ review: { channelId: 'chan-1', state: 'APPROVED' } }, 'chan-1'), false);
  assert.equal(canSubmitReviewForSelection(null, 'chan-1'), false);
});

test('a missing pinned lineage blocks the decision',()=>{
  assert.equal(reviewEvidenceIsDecidable({ warnings: [] }), true);
  assert.equal(reviewEvidenceIsDecidable({ warnings: ['ELIGIBILITY_DECISION_NOT_FOUND'] }), false);
  assert.equal(reviewEvidenceIsDecidable({ warnings: ['CLASSIFICATION_DIAGNOSTIC_NOT_FOUND'] }), false);
  assert.equal(reviewEvidenceIsDecidable({ warnings: ['ELIGIBILITY_DECISION_ID_MISSING'] }), false);
  assert.equal(reviewEvidenceIsDecidable({ warnings: ['CLASSIFICATION_DIAGNOSTIC_MISSING'] }), false);
  assert.equal(reviewEvidenceIsDecidable({ warnings: ['ELIGIBILITY_DECISION_MISSING'] }), false);
  assert.equal(reviewEvidenceIsDecidable({ warnings: ['EVIDENCE_DOCUMENT_SCOPE_INCOMPLETE'] }), false);
  assert.equal(reviewEvidenceIsDecidable({ warnings: ['EVIDENCE_ASSERTION_SCOPE_INCOMPLETE'] }), false);
  assert.equal(reviewEvidenceIsDecidable({ warnings: ['EVIDENCE_SCOPE_TEMPORAL_FALLBACK'] }), true);
});
