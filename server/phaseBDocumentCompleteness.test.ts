import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildPhaseBDocumentCompletenessReport,
  PHASE_B_DOCUMENT_COMPLETENESS_VERSION
} from './phaseBDocumentCompleteness';
import {
  executePhaseBObservation,
  productionDiagnosticObservationKey,
  type ProductionDiagnosticPayload
} from './phaseBObservationOutbox';

test('document completeness fails closed on projection, coverage, and Creator Focus lineage gaps', () => {
  const metrics = {
    diagnostics: 5,
    completeProjections: 3,
    missingProjections: 1,
    nonEquivalentProjections: 1,
    incompleteCoverage: 1,
    missingDiagnosticLineage: 1,
    pendingDiagnosticObservations: 1,
    missingCoverageSnapshots: 1,
    missingCreatorFocusSnapshots: 1,
    missingCoverageFocusLineage: 1
  };
  const report = buildPhaseBDocumentCompletenessReport({
    windowStart: '2026-08-01T00:00:00.000Z',
    cutoffAt: '2026-08-02T00:00:00.000Z',
    metrics
  });
  assert.equal(report.ready, false);
  assert.equal(report.servingAuthority, false);
  assert.equal(report.assertionAuthority, false);
  assert.equal(report.version, PHASE_B_DOCUMENT_COMPLETENESS_VERSION);
  for (const reason of [
    'DOCUMENT_PROJECTION_MISSING',
    'DOCUMENT_PROJECTION_MISMATCH',
    'DOCUMENT_OR_COVERAGE_INCOMPLETE',
    'DIAGNOSTIC_LINEAGE_MISSING',
    'OBSERVATION_RECONCILIATION_PENDING',
    'COVERAGE_SNAPSHOT_MISSING',
    'CREATOR_FOCUS_SNAPSHOT_MISSING',
    'COVERAGE_FOCUS_LINEAGE_MISSING',
    'DOCUMENT_COMPLETENESS_COUNT_MISMATCH'
  ]) assert.ok(report.reasonCodes.includes(reason), reason);
});

test('transient document projection failure keeps the diagnostic observation retryable', async () => {
  const payload: ProductionDiagnosticPayload = {
    type: 'PRODUCTION_DIAGNOSTIC',
    input: { channelId: 'channel-1', input: {} as any, decision: {} as any }
  };
  const key = productionDiagnosticObservationKey(payload);
  let attempts = 0;
  const dependencies = {
    recordAssignment: async () => ({ assignmentKey: 'unused' } as any),
    recordGroundTruth: async () => ({ id: 'unused' } as any),
    recordDiagnostic: async () => {
      attempts++;
      if (attempts === 1) throw new Error('document projection transient failure');
      return 'diagnostic-1';
    }
  };
  await assert.rejects(executePhaseBObservation(payload, key, dependencies), /document projection transient failure/);
  assert.equal(await executePhaseBObservation(payload, key, dependencies), 'diagnostic-1');
  assert.equal(attempts, 2);
});

test('evidence dual-write requires resolved coverage lineage and does not swallow Creator Focus failures', () => {
  const diagnostics = readFileSync(new URL('./classificationDiagnostics.ts', import.meta.url), 'utf8');
  const dualWrite = readFileSync(new URL('./evidenceEngine/dualWrite.ts', import.meta.url), 'utf8');
  const coverageStore = readFileSync(new URL('./evidenceEngine/coverageStore.ts', import.meta.url), 'utf8');
  const creatorFocus = readFileSync(new URL('./evidenceEngine/creatorFocusClassifier.ts', import.meta.url), 'utf8');
  const phaseB = readFileSync(new URL('./phaseBShadow.ts', import.meta.url), 'utf8');
  const inspection = readFileSync(new URL('./phaseBDocumentCompleteness.ts', import.meta.url), 'utf8');
  const outbox = readFileSync(new URL('./phaseBObservationOutbox.ts', import.meta.url), 'utf8');

  assert.match(diagnostics, /if \(diagnostic\.observationKey\) throw error/);
  assert.match(dualWrite, /EVIDENCE_COVERAGE_SNAPSHOT_ID_REQUIRED/);
  assert.match(dualWrite, /coverageSnapshotId:\s*coverageResult\.id/);
  assert.match(dualWrite, /await runCreatorFocusShadow\(\{/);
  assert.doesNotMatch(dualWrite, /await runCreatorFocusShadow\([\s\S]{0,400}\)\.catch\(/);
  assert.match(coverageStore, /SELECT id FROM evidence_coverage_snapshots WHERE snapshot_key/);
  assert.match(creatorFocus, /evidence_coverage_snapshot_id/);
  assert.match(creatorFocus, /coverageSnapshotId/);
  assert.match(creatorFocus, /'UNCERTAIN'/);
  assert.match(phaseB, /OBSERVATION_RECONCILIATION_PENDING/);
  assert.match(phaseB, /PASSING_DOCUMENT_VALIDATION_REQUIRED/);
  assert.match(inspection, /BEGIN TRANSACTION READ ONLY/);
  assert.match(inspection, /CREATOR_FOCUS_SNAPSHOT_MISSING/);
  assert.match(inspection, /COVERAGE_FOCUS_LINEAGE_MISSING/);
  assert.doesNotMatch(inspection, /db\.query\([`'"]\s*(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP)\b/i);
  assert.match(outbox, /reconcileIncompleteEvidenceBundles/);
  assert.match(outbox, /servingAuthority: false/);
});

test('complete document metrics report ready only when coverage and focus lineage are present', () => {
  const report = buildPhaseBDocumentCompletenessReport({
    windowStart: '2026-08-01T00:00:00.000Z',
    cutoffAt: '2026-08-02T00:00:00.000Z',
    metrics: {
      diagnostics: 3,
      completeProjections: 3,
      missingProjections: 0,
      nonEquivalentProjections: 0,
      incompleteCoverage: 0,
      missingDiagnosticLineage: 0,
      pendingDiagnosticObservations: 0,
      missingCoverageSnapshots: 0,
      missingCreatorFocusSnapshots: 0,
      missingCoverageFocusLineage: 0
    }
  });
  assert.equal(report.ready, true);
  assert.equal(report.servingAuthority, false);
  assert.deepEqual(report.reasonCodes, []);
});
