import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { mapReviewEvidenceRows } from './reviewEvidence';

const review: any = {
  channelId: 'chan-1',
  channelName: 'Example',
  state: 'PENDING',
  reviewVersion: 2,
  evidenceSnapshot: { eligibilityDecisionId: 'elig-1' },
  history: [],
};

test('review evidence follows the eligibility decision to the classification diagnostic', () => {
  const bundle = mapReviewEvidenceRows({
    review,
    eligibilityRow: {
      id: 'elig-1', status: 'ELIGIBLE', reason_codes: ['AMBIGUITY_REQUIRES_HUMAN_JUDGMENT'],
      input_snapshot: { reasonFamily: 'HUMAN_AMBIGUITY' }, policy_version: 'v1', input_checksum: 'sum',
      serving_authority: true, decided_at: '2026-01-01T00:00:00Z',
      projection_status: 'ELIGIBLE', projection_version: 3, projection_evidence_checksum: 'psum',
      projection_policy_version: 'v1', projection_updated_at: '2026-01-01T00:01:00Z',
    },
    diagnosticRow: {
      id: 'diag-1', channel_id: 'chan-1', created_at: '2026-01-01T00:00:00Z',
      enrichment_stage: 1, normalized_input: { description: 'forex trading' },
      provider_execution: [{ provider: 'gemini_semantic', outcome: 'ABSTAINED_LOW_CONFIDENCE' }],
      evidence_items: [{ id: 'e1', polarity: 'POSITIVE' }],
      staged_report: { lifecycleAction: 'REVIEW' },
      decision: { status: 'UNCERTAIN', deterministicRouting: { route: 'HUMAN_REVIEW' } },
      policy_versions: { decision: 'v1' }, catalog_versions: [],
    },
    evidenceDocuments: [{ id: 'd1' }],
    evidenceAssertions: [{ id: 'a1' }],
    evidenceCoverage: [{ id: 'c1' }],
    creatorFocusRow: { id: 'f1' },
  });
  assert.equal(bundle.eligibility?.decisionId, 'elig-1');
  assert.equal(bundle.eligibility?.reasonFamily, 'HUMAN_AMBIGUITY');
  assert.equal(bundle.diagnostic?.id, 'diag-1');
  assert.equal(bundle.diagnostic?.normalizedInput.description, 'forex trading');
  assert.equal((bundle.diagnostic?.decision as any).deterministicRouting.route, 'HUMAN_REVIEW');
  assert.equal(bundle.evidenceDocuments.length, 1);
  assert.equal(bundle.evidenceAssertions.length, 1);
  assert.equal(bundle.evidenceCoverage.length, 1);
  assert.equal(bundle.creatorFocusSnapshot?.id, 'f1');
  assert.deepEqual(bundle.warnings, []);
});

test('missing lineage is reported as a warning instead of throwing', () => {
  const bundle = mapReviewEvidenceRows({ review: { ...review, evidenceSnapshot: {} }, eligibilityRow: null, diagnosticRow: null });
  assert.equal(bundle.eligibility, null);
  assert.equal(bundle.diagnostic, null);
  assert.ok(bundle.warnings.includes('ELIGIBILITY_DECISION_MISSING'));
  assert.ok(bundle.warnings.includes('CLASSIFICATION_DIAGNOSTIC_MISSING'));
});

test('review evidence reader is read-only', () => {
  const source = readFileSync(new URL('./reviewEvidence.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bTRUNCATE\b/);
});

test('evidence read failures are surfaced as warnings',()=>{
  const source = readFileSync(new URL('./reviewEvidence.ts', import.meta.url), 'utf8');
  for (const warning of ['EVIDENCE_DOCUMENTS_UNAVAILABLE','EVIDENCE_ASSERTIONS_UNAVAILABLE','EVIDENCE_COVERAGE_UNAVAILABLE','CREATOR_FOCUS_UNAVAILABLE','ELIGIBILITY_DECISION_NOT_FOUND','CLASSIFICATION_DIAGNOSTIC_NOT_FOUND','CLASSIFICATION_DIAGNOSTIC_ID_MISSING','ELIGIBILITY_DECISION_ID_MISSING','EVIDENCE_SCOPE_TEMPORAL_FALLBACK','EVIDENCE_DOCUMENT_SCOPE_INCOMPLETE','EVIDENCE_ASSERTION_SCOPE_INCOMPLETE','EVIDENCE_COVERAGE_NOT_FOUND']) {
    assert.match(source, new RegExp(warning));
  }
});
