import { getAppSetting } from '../db';
import type { RawChannelInput, VerificationDecision } from './types';
import { buildCanonicalEvidenceCorpus } from './canonicalEvidencePlane';
import { projectEvidenceDocuments } from './documentProjection';
import { persistEvidenceDocuments } from './documentStore';
import { persistEvidenceAssertions } from './assertionStore';
import { buildEvidenceCoverageSnapshot } from './coverage';
import { persistEvidenceCoverage } from './coverageStore';
import { compareLegacyEvidenceProjection } from './providerV2';

export const EVIDENCE_DUAL_WRITE_VERSION = 'evidence-dual-write-v1';

/** Observation-only dual write. Failures are contained by the caller and never alter the supplied decision. */
export async function persistClassificationEvidenceBundle(input: RawChannelInput, decision: VerificationDecision, classificationDiagnosticId?: string) {
  const documentsEnabled = await getAppSetting('evidence_document_dual_write_enabled', 'false') === 'true';
  const assertionsEnabled = await getAppSetting('evidence_assertion_dual_write_enabled', 'false') === 'true';
  if (!documentsEnabled) return { enabled: false, documents: 0, assertions: 0, coverage: false, servingAuthority: false };
  const observedAt = decision.timestamp, corpus = input.evidence_corpus || buildCanonicalEvidenceCorpus(input);
  const documents = projectEvidenceDocuments(input, corpus, observedAt), evidence = [...decision.positiveEvidence, ...decision.negativeEvidence];
  const comparison = compareLegacyEvidenceProjection(input, evidence, documents, observedAt);
  if (!comparison.equivalent) throw new Error('LEGACY_EVIDENCE_PROJECTION_MISMATCH');
  const assertions = assertionsEnabled ? comparison.assertions : [];
  const documentResult = await persistEvidenceDocuments(documents);
  let assertionResult = { attempted: 0, inserted: 0 };
  if (assertionsEnabled) assertionResult = await persistEvidenceAssertions(assertions);
  const coverage = buildEvidenceCoverageSnapshot(input, documents, decision.evidenceCollection, observedAt, classificationDiagnosticId);
  const coverageResult = await persistEvidenceCoverage(coverage);
  return {
    enabled: true, documents: documentResult, assertions: assertionResult, coverage: coverageResult,
    comparison: { equivalent: true, projectableCount: comparison.projectableCount, excludedEvidenceIds: comparison.excludedEvidenceIds },
    servingAuthority: false, version: EVIDENCE_DUAL_WRITE_VERSION
  };
}
