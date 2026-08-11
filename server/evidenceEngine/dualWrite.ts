import { createHash } from 'node:crypto';
import { getAppSetting } from '../db';
import type { RawChannelInput, VerificationDecision } from './types';
import { buildCanonicalEvidenceCorpus } from './canonicalEvidencePlane';
import { projectEvidenceDocuments } from './documentProjection';
import { persistEvidenceDocuments } from './documentStore';
import { persistEvidenceAssertions } from './assertionStore';
import { buildEvidenceCoverageSnapshot } from './coverage';
import { persistEvidenceCoverage } from './coverageStore';
import { compareLegacyEvidenceProjection } from './providerV2';
import { runCreatorFocusShadow } from './creatorFocusClassifier';
import { recordGapSpecificPlan } from '../gapSpecificInvestigation';
import { recordProjectionObservation } from '../phaseBShadow';

export const EVIDENCE_DUAL_WRITE_VERSION = 'evidence-dual-write-v1';

/**
 * Observation-only dual write. Failures are contained by the production caller
 * unless a durable Phase B diagnostic requires the complete observational bundle.
 */
export async function persistClassificationEvidenceBundle(
  input: RawChannelInput,
  decision: VerificationDecision,
  classificationDiagnosticId?: string,
  options: { requireCompleteObservation?: boolean } = {}
) {
  const started = Date.now();
  const configuredDocumentsEnabled = await getAppSetting('evidence_document_dual_write_enabled', 'false') === 'true';
  const documentsEnabled = configuredDocumentsEnabled || options.requireCompleteObservation === true;
  const assertionsEnabled = await getAppSetting('evidence_assertion_dual_write_enabled', 'false') === 'true';
  if (!documentsEnabled) {
    return { enabled: false, documents: 0, assertions: 0, coverage: false, servingAuthority: false as const };
  }

  const observedAt = decision.timestamp;
  const corpus = input.evidence_corpus || buildCanonicalEvidenceCorpus(input);
  const documents = projectEvidenceDocuments(input, corpus, observedAt);
  const evidence = [...decision.positiveEvidence, ...decision.negativeEvidence];
  const comparison = compareLegacyEvidenceProjection(input, evidence, documents, observedAt);
  if (!comparison.equivalent) {
    await recordProjectionObservation({
      channelId: input.channel_id || 'UNKNOWN',
      diagnosticId: classificationDiagnosticId,
      inputChecksum: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
      equivalent: false,
      documentCount: documents.length,
      assertionCount: 0,
      projectedEvidenceCount: comparison.projectableCount,
      excludedEvidenceIds: comparison.excludedEvidenceIds,
      coveragePersisted: false,
      durationMs: Date.now() - started,
      reasonCodes: ['LEGACY_EVIDENCE_PROJECTION_MISMATCH'],
      observedAt: decision.timestamp
    });
    throw new Error('LEGACY_EVIDENCE_PROJECTION_MISMATCH');
  }

  const assertions = assertionsEnabled ? comparison.assertions : [];
  const documentResult = await persistEvidenceDocuments(documents);
  let assertionResult = { attempted: 0, inserted: 0 };
  if (assertionsEnabled) assertionResult = await persistEvidenceAssertions(assertions);

  const coverage = buildEvidenceCoverageSnapshot(input, documents, decision.evidenceCollection, observedAt, classificationDiagnosticId);
  const coverageResult = await persistEvidenceCoverage(coverage);
  if (!coverageResult.id) throw new Error('EVIDENCE_COVERAGE_SNAPSHOT_ID_REQUIRED');

  const creatorFocus = classificationDiagnosticId
    ? await runCreatorFocusShadow({
        channelId: input.channel_id,
        subjectEntityId: coverage.subjectEntityId,
        diagnosticId: classificationDiagnosticId,
        productionStatus: decision.status,
        documents,
        assertions,
        coverage,
        coverageSnapshotId: coverageResult.id,
        forceShadowObservation: options.requireCompleteObservation === true
      })
    : { enabled: false, servingAuthority: false as const };

  if (options.requireCompleteObservation && !creatorFocus.enabled) {
    throw new Error('CREATOR_FOCUS_SNAPSHOT_REQUIRED_FOR_DURABLE_DIAGNOSTIC');
  }

  // Gap-specific planning remains failure-contained and non-authoritative.
  const gapPlan = creatorFocus.enabled && 'decision' in creatorFocus
    ? await recordGapSpecificPlan({
        channelId: input.channel_id,
        diagnosticId: classificationDiagnosticId,
        creatorFocusSnapshotId: 'snapshotId' in creatorFocus ? (creatorFocus as { snapshotId?: string }).snapshotId : undefined,
        decision: (creatorFocus as any).decision,
        providerQuotaRemaining: Number(await getAppSetting('gap_specific_case_quota_cap', '303')),
        caseQuotaRemaining: Number(await getAppSetting('gap_specific_case_quota_cap', '303')),
        deadlineRemainingMs: Number(await getAppSetting('gap_specific_deadline_minutes', '30')) * 60_000,
        reviewCapacity: 0
      }).catch(error => ({ enabled: false, servingAuthority: false as const, error: error instanceof Error ? error.message : String(error) }))
    : { enabled: false, servingAuthority: false as const };

  await recordProjectionObservation({
    channelId: input.channel_id || 'UNKNOWN',
    diagnosticId: classificationDiagnosticId,
    inputChecksum: coverage.inputChecksum,
    equivalent: true,
    documentCount: documents.length,
    assertionCount: assertions.length,
    projectedEvidenceCount: comparison.projectableCount,
    excludedEvidenceIds: comparison.excludedEvidenceIds,
    coveragePersisted: true,
    durationMs: Date.now() - started,
    reasonCodes: [
      'PROJECTION_EQUIVALENT',
      'DOCUMENT_COVERAGE_PERSISTED',
      ...(creatorFocus.enabled ? ['CREATOR_FOCUS_SNAPSHOT_PERSISTED'] : ['CREATOR_FOCUS_OBSERVER_DISABLED']),
      ...(options.requireCompleteObservation ? ['DURABLE_DIAGNOSTIC_COMPLETE_OBSERVATION_REQUIRED'] : [])
    ],
    observedAt
  });

  return {
    enabled: true,
    documents: documentResult,
    assertions: assertionResult,
    coverage: coverageResult,
    comparison: {
      equivalent: true,
      projectableCount: comparison.projectableCount,
      excludedEvidenceIds: comparison.excludedEvidenceIds
    },
    creatorFocus,
    gapPlan,
    servingAuthority: false as const,
    version: EVIDENCE_DUAL_WRITE_VERSION
  };
}
