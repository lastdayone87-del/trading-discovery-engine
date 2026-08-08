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
import {recordGapSpecificPlan} from '../gapSpecificInvestigation';
import {recordProjectionObservation} from '../phaseBShadow';
import {createHash} from 'node:crypto';

export const EVIDENCE_DUAL_WRITE_VERSION = 'evidence-dual-write-v1';

/** Observation-only dual write. Failures are contained by the caller and never alter the supplied decision. */
export async function persistClassificationEvidenceBundle(input: RawChannelInput, decision: VerificationDecision, classificationDiagnosticId?: string) {
  const started=Date.now();
  const documentsEnabled = await getAppSetting('evidence_document_dual_write_enabled', 'false') === 'true';
  const assertionsEnabled = await getAppSetting('evidence_assertion_dual_write_enabled', 'false') === 'true';
  if (!documentsEnabled) return { enabled: false, documents: 0, assertions: 0, coverage: false, servingAuthority: false };
  const observedAt = decision.timestamp, corpus = input.evidence_corpus || buildCanonicalEvidenceCorpus(input);
  const documents = projectEvidenceDocuments(input, corpus, observedAt), evidence = [...decision.positiveEvidence, ...decision.negativeEvidence];
  const comparison = compareLegacyEvidenceProjection(input, evidence, documents, observedAt);
  if (!comparison.equivalent) {await recordProjectionObservation({channelId:input.channel_id||'UNKNOWN',diagnosticId:classificationDiagnosticId,inputChecksum:createHash('sha256').update(JSON.stringify(input)).digest('hex'),equivalent:false,documentCount:documents.length,assertionCount:0,projectedEvidenceCount:comparison.projectableCount,excludedEvidenceIds:comparison.excludedEvidenceIds,coveragePersisted:false,durationMs:Date.now()-started,reasonCodes:['LEGACY_EVIDENCE_PROJECTION_MISMATCH'],observedAt:decision.timestamp});throw new Error('LEGACY_EVIDENCE_PROJECTION_MISMATCH');}
  const assertions = assertionsEnabled ? comparison.assertions : [];
  const documentResult = await persistEvidenceDocuments(documents);
  let assertionResult = { attempted: 0, inserted: 0 };
  if (assertionsEnabled) assertionResult = await persistEvidenceAssertions(assertions);
  const coverage = buildEvidenceCoverageSnapshot(input, documents, decision.evidenceCollection, observedAt, classificationDiagnosticId);
  const coverageResult = await persistEvidenceCoverage(coverage);
  const creatorFocus = classificationDiagnosticId ? await runCreatorFocusShadow({channelId:input.channel_id,subjectEntityId:coverage.subjectEntityId,diagnosticId:classificationDiagnosticId,documents,assertions,coverage}).catch(error=>({enabled:false,servingAuthority:false,error:error instanceof Error?error.message:String(error)})) : {enabled:false,servingAuthority:false};
  const gapPlan = creatorFocus.enabled&&'decision' in creatorFocus ? await recordGapSpecificPlan({channelId:input.channel_id,diagnosticId:classificationDiagnosticId,creatorFocusSnapshotId:undefined,decision:creatorFocus.decision,providerQuotaRemaining:Number(await getAppSetting('gap_specific_case_quota_cap','303')),caseQuotaRemaining:Number(await getAppSetting('gap_specific_case_quota_cap','303')),deadlineRemainingMs:Number(await getAppSetting('gap_specific_deadline_minutes','30'))*60_000,reviewCapacity:0}).catch(error=>({enabled:false,servingAuthority:false,error:error instanceof Error?error.message:String(error)})) : {enabled:false,servingAuthority:false};
  await recordProjectionObservation({channelId:input.channel_id||'UNKNOWN',diagnosticId:classificationDiagnosticId,inputChecksum:coverage.inputChecksum,equivalent:true,documentCount:documents.length,assertionCount:assertions.length,projectedEvidenceCount:comparison.projectableCount,excludedEvidenceIds:comparison.excludedEvidenceIds,coveragePersisted:true,durationMs:Date.now()-started,reasonCodes:['PROJECTION_EQUIVALENT','DOCUMENT_COVERAGE_PERSISTED'],observedAt});
  return {
    enabled: true, documents: documentResult, assertions: assertionResult, coverage: coverageResult,
    comparison: { equivalent: true, projectableCount: comparison.projectableCount, excludedEvidenceIds: comparison.excludedEvidenceIds },
    creatorFocus, gapPlan, servingAuthority: false, version: EVIDENCE_DUAL_WRITE_VERSION
  };
}
