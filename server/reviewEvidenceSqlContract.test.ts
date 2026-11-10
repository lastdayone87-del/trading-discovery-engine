import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./reviewEvidence.ts', import.meta.url), 'utf8');

test('review evidence resolves the diagnostic through the eligibility decision first', () => {
  assert.match(source, /classification_diagnostic_id/);
  assert.match(source, /WHERE id=\$1 AND channel_id=\$2/);
  assert.match(source, /ORDER BY created_at DESC,id DESC\s+LIMIT 1/);
});

test('review evidence selects explicit diagnostic columns and bounded evidence reads', () => {
  assert.match(source, /normalized_input/);
  assert.match(source, /evidence_items/);
  assert.match(source, /staged_report/);
  assert.match(source, /provider_execution/);
  assert.doesNotMatch(source, /SELECT\s+\*\s+FROM production_classification_diagnostics/i);
});

test('review evidence is scoped to the exact Creator Focus document and assertion keys', () => {
  assert.match(source, /document_keys/);
  assert.match(source, /assertion_keys/);
  assert.match(source, /documentKeys: exactDocumentScope \? documentScope\.keys : undefined/);
  assert.match(source, /assertionKeys: exactAssertionScope \? assertionScope\.keys : undefined/);
  assert.match(source, /classificationDiagnosticId: diagnosticRow\?\.id/);
  assert.match(source, /EVIDENCE_SCOPE_TEMPORAL_FALLBACK/);
  assert.match(source, /EVIDENCE_DOCUMENT_SCOPE_INCOMPLETE/);
  assert.match(source, /EVIDENCE_ASSERTION_SCOPE_INCOMPLETE/);
  assert.match(source, /EVIDENCE_DOCUMENT_SCOPE_MALFORMED/);
  assert.match(source, /EVIDENCE_ASSERTION_SCOPE_MALFORMED/);
  assert.match(source, /EVIDENCE_DOCUMENT_SCOPE_EMPTY/);
  assert.match(source, /EVIDENCE_DOCUMENT_SCOPE_MISSING/);
  assert.match(source, /EVIDENCE_ASSERTION_SCOPE_MISSING/);
  assert.match(source, /documentScope\.present/);
  assert.match(source, /assertionScope\.present/);
  assert.match(source, /blockingReviewEvidenceWarnings/);
  assert.match(source, /EVIDENCE_ASSERTION_SCOPE_EMPTY/);
});

test('review evidence uses real Creator Focus columns', () => {
  assert.match(source, /creator_focus_distribution/);
  assert.match(source, /lower_confidence_bound/);
  assert.match(source, /probability/);
  assert.match(source, /proposed_status/);
  assert.match(source, /effective_status/);
  assert.doesNotMatch(source, /document_count,independent_families,trading_mass,alternative_mass/);
});

test('the review queue endpoint returns a durable total for pagination', () => {
  const store = readFileSync(new URL('./reviewStore.ts', import.meta.url), 'utf8');
  assert.match(store, /export async function listReviewQueuePage/);
  assert.match(store, /COUNT\(\*\)::int AS total/);
  assert.match(store, /return \{items,total:count\}/);
});

test('evidence stores support exact-key and exact-diagnostic scoping', () => {
  const documents = readFileSync(new URL('./evidenceEngine/documentStore.ts', import.meta.url), 'utf8');
  const assertions = readFileSync(new URL('./evidenceEngine/assertionStore.ts', import.meta.url), 'utf8');
  const coverage = readFileSync(new URL('./evidenceEngine/coverageStore.ts', import.meta.url), 'utf8');
  assert.match(documents, /document_key=ANY\(\$4\)/);
  assert.match(assertions, /assertion_key=ANY\(\$4\)/);
  assert.match(coverage, /classification_diagnostic_id=\$3/);
});

test('the authoritative decision route revalidates blocking evidence scope', () => {
  const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
  assert.match(server, /blockingReviewEvidenceWarnings\(req\.params\.channelId\)/);
  assert.match(server, /REVIEW_EVIDENCE_INCOMPLETE/);
  assert.match(server, /action!=='FORCE_RESCAN'/);
});
