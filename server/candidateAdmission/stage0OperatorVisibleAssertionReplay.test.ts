import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./stage0OperatorVisibleAssertionReplay.ts', import.meta.url), 'utf8');

test('operator-visible assertion replay remains read-only and reuses canonical replay/evaluator', () => {
  assert.match(source, /BEGIN TRANSACTION READ ONLY/);
  assert.match(source, /ROLLBACK/);
  assert.match(source, /replayCreatorFocusFromDiagnostic/);
  assert.match(source, /evaluateOfflineAdmissionV2/);
  assert.doesNotMatch(source, /\bINSERT\s+INTO\b/i);
  assert.doesNotMatch(source, /\bUPDATE\s+\w+/i);
  assert.doesNotMatch(source, /\bDELETE\s+FROM\b/i);
});

test('replay report declares zero serving and promotion authority', () => {
  assert.match(source, /readOnly:true/);
  assert.match(source, /servingAuthority:false/);
  assert.match(source, /automaticPromotion:false/);
  assert.match(source, /persisted:false/);
  assert.match(source, /historicalReplay:true/);
});

test('replay inputs are sourced from immutable diagnostics and persisted document keys', () => {
  assert.match(source, /production_classification_diagnostics/);
  assert.match(source, /normalized_input/);
  assert.match(source, /evidence_items/);
  assert.match(source, /evidence_documents/);
  assert.match(source, /document_keys/);
});

test('missing direct coverage lineage may recover only from one exact diagnostic match', () => {
  assert.match(source, /ec\.classification_diagnostic_id=lf\.classification_diagnostic_id/);
  assert.match(source, /count\(\*\)::int AS candidate_count/);
  assert.match(source, /exact_coverage\.candidate_count=1/);
  assert.match(source, /RECOVERED_EXACT_DIAGNOSTIC/);
  assert.match(source, /AMBIGUOUS_DIAGNOSTIC_COVERAGE/);
  assert.match(source, /COVERAGE_SNAPSHOT_LINEAGE_AMBIGUOUS/);
});

test('direct coverage lineage remains preferred and lineage source is auditable', () => {
  assert.match(source, /lf\.evidence_coverage_snapshot_id IS NOT NULL THEN 'DIRECT_LINK'/);
  assert.match(source, /COALESCE\(\s*lf\.evidence_coverage_snapshot_id::text/);
  assert.match(source, /coverageLineageSource/);
  assert.match(source, /coverageLineageCounts/);
});
