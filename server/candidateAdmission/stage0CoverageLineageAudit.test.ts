import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { classifyStage0CoverageLineage } from './stage0CoverageLineageAudit';

test('classifies direct and exact-diagnostic recoverable lineage conservatively', () => {
  assert.equal(classifyStage0CoverageLineage({
    focusSnapshotId: 'focus-1', classificationDiagnosticId: 'diag-1',
    directCoverageSnapshotId: 'cov-1', directCoverageDiagnosticId: 'diag-1'
  }), 'DIRECT_LINK');

  assert.equal(classifyStage0CoverageLineage({
    focusSnapshotId: 'focus-1', classificationDiagnosticId: 'diag-1',
    exactDiagnosticCoverageIds: ['cov-1']
  }), 'RECOVERABLE_EXACT_DIAGNOSTIC');

  assert.equal(classifyStage0CoverageLineage({
    focusSnapshotId: 'focus-1', classificationDiagnosticId: 'diag-1',
    exactDiagnosticCoverageIds: ['cov-1', 'cov-2']
  }), 'AMBIGUOUS_DIAGNOSTIC_COVERAGE');

  assert.equal(classifyStage0CoverageLineage({
    focusSnapshotId: 'focus-1', classificationDiagnosticId: 'diag-1', exactDiagnosticCoverageIds: []
  }), 'COVERAGE_MISSING');
});

test('fails closed on missing or contradictory lineage', () => {
  assert.equal(classifyStage0CoverageLineage({}), 'FOCUS_MISSING');
  assert.equal(classifyStage0CoverageLineage({ focusSnapshotId: 'focus-1' }), 'DIAGNOSTIC_MISSING');
  assert.equal(classifyStage0CoverageLineage({
    focusSnapshotId: 'focus-1', classificationDiagnosticId: 'diag-1',
    directCoverageSnapshotId: 'cov-1', directCoverageDiagnosticId: 'diag-2'
  }), 'DIRECT_LINK_DIAGNOSTIC_MISMATCH');
});

test('audit source is read-only and exact-diagnostic recovery is diagnostic-scoped', () => {
  const source = readFileSync(new URL('./stage0CoverageLineageAudit.ts', import.meta.url), 'utf8');
  assert.match(source, /BEGIN TRANSACTION READ ONLY/);
  assert.match(source, /ROLLBACK/);
  assert.match(source, /c\.classification_diagnostic_id=lf\.classification_diagnostic_id/);
  assert.doesNotMatch(source, /\bINSERT\s+INTO\b/i);
  assert.doesNotMatch(source, /\bUPDATE\s+\w+/i);
  assert.doesNotMatch(source, /\bDELETE\s+FROM\b/i);
  assert.match(source, /servingAuthority: false/);
  assert.match(source, /automaticPromotion: false/);
});
