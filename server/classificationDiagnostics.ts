import { getDb } from './db';
import type { RawChannelInput, VerificationDecision } from './evidenceEngine';
import { persistClassificationEvidenceBundle } from './evidenceEngine/dualWrite';
import { normalizeClassificationInput } from './classificationInputChecksum';
import { assessNegativeEvidence, negativeEvidencePolicyWeight, NEGATIVE_EVIDENCE_ROLE_VERSION } from './evidenceEngine/negativeEvidenceRole';
import { CONTEXTUAL_COMPOSITION_VERSION } from './evidenceEngine/contextualComposition';
import { CLAIM_POLARITY_VERSION } from './evidenceEngine/utils/claimPolarity';
import { TRADING_SIGNAL_TAXONOMY_VERSION } from './evidenceEngine/tradingSignalTaxonomy';
import { RECOGNITION_STATE_VERSION } from './evidenceEngine/recognitionState';
import { STAGED_CLASSIFICATION_VERSION } from './evidenceEngine/stagedClassification';
import { UNIFIED_DECISION_POLICY_VERSION } from './evidenceEngine/decisionPolicy';

/**
 * Retained public name: the immutable diagnostic ledger and the Phase 4
 * semantic result cache must fingerprint evidence identically, so the
 * normalization lives in one shared module.
 */
export const normalizeProductionDiagnosticInput = normalizeClassificationInput;

export interface ProductionClassificationDiagnosticInput {
  channelId: string;
  input: RawChannelInput;
  decision: VerificationDecision;
  jobId?: string;
  queryRunId?: string;
  nominationId?: string;
  catalogVersions?: string[];
  observationKey?: string;
}

/**
 * Persists the authoritative diagnostic exactly once. Durable Phase B diagnostic
 * observations are not complete until coverage and Creator Focus shadow snapshots
 * tied to this diagnostic also exist; ordinary production callers retain the
 * legacy failure-contained dual-write behavior.
 */
export async function recordProductionClassification(
  diagnostic: ProductionClassificationDiagnosticInput
): Promise<string | undefined> {
  const db = await getDb();
  const fullComposition = diagnostic.decision.compositionReport;
  const compositionForDiagnostics = fullComposition
    ? {
      ...fullComposition,
      familyClassifications: fullComposition.familyClassifications.map(({ signals, suppressedSignals, ...family }) => ({
        ...family,
        signalCount: signals?.length || 0,
        suppressedSignalCount: suppressedSignals?.length || 0,
      })),
    }
    : undefined;
  const terminalNegativeStatus = diagnostic.decision.evidenceCollection?.terminalNegativeSufficiency?.status;
  const negativeRoleOptions = terminalNegativeStatus
    ? { terminalEligible: terminalNegativeStatus === 'SUFFICIENT' }
    : {};
  const normalizedDiagnosticInput = normalizeProductionDiagnosticInput(diagnostic.input);
  const signalMatches = (fullComposition?.familyClassifications || []).flatMap(family =>
    (family.signals || []).map(signal => ({
      ...signal,
      field: family.field,
      sourceFamilyId: family.sourceFamilyId,
    }))
  ).slice(0, 200);
  const suppressedSignalMatches = (fullComposition?.familyClassifications || []).flatMap(family =>
    (family.suppressedSignals || []).map(signal => ({
      ...signal,
      field: family.field,
      sourceFamilyId: family.sourceFamilyId,
    }))
  ).slice(0, 200);
  const inserted = await db.query(
    `INSERT INTO production_classification_diagnostics(
      channel_id, job_id, query_run_id, nomination_id, enrichment_stage,
      normalized_input, provider_execution, evidence_items, staged_report,
      decision, policy_versions, catalog_versions, observation_key
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT(observation_key) WHERE observation_key IS NOT NULL DO NOTHING
    RETURNING id`,
    [
      diagnostic.channelId,
      diagnostic.jobId || null,
      diagnostic.queryRunId || null,
      diagnostic.nominationId || null,
      diagnostic.input.enrichment_stage || 0,
      JSON.stringify(normalizedDiagnosticInput),
      JSON.stringify(diagnostic.decision.evidenceCollection.providers),
      JSON.stringify([
        ...diagnostic.decision.positiveEvidence,
        ...diagnostic.decision.negativeEvidence
      ]),
      JSON.stringify(diagnostic.decision.stagedClassification || {}),
      JSON.stringify({
        schemaVersion: 'production-decision-envelope-v3',
        status: diagnostic.decision.status,
        confidenceScore: diagnostic.decision.confidenceScore,
        category: diagnostic.decision.category,
        positiveWeight: diagnostic.decision.totalPositiveWeight,
        negativeWeight: diagnostic.decision.totalNegativeWeight,
        justification: diagnostic.decision.mathematicalJustification,
        evidenceCollection: diagnostic.decision.evidenceCollection,
        stagedClassification: diagnostic.decision.stagedClassification,
        decisionPolicy: diagnostic.decision.decisionPolicy,
        // v3: retain the decisive C5/C6 state instead of forcing operators to
        // replay normalized_input to discover why a decision abstained.
        composition: compositionForDiagnostics || diagnostic.decision.composition,
        signalMatches,
        suppressedSignalMatches,
        recognition: diagnostic.decision.recognitionAssessment || {
          version: RECOGNITION_STATE_VERSION,
          state: diagnostic.decision.recognitionState,
          semanticPolicy: diagnostic.decision.semanticPolicy,
          semanticSkippedReason: diagnostic.decision.semanticSkippedReason,
        },
        negativeEvidence: [
          ...diagnostic.decision.negativeEvidence,
        ].map(item => ({
          id: item.id,
          ...assessNegativeEvidence(item, negativeRoleOptions),
          weight: -negativeEvidencePolicyWeight(item),
        })),
        policyVersions: {
          composition: CONTEXTUAL_COMPOSITION_VERSION,
          taxonomy: TRADING_SIGNAL_TAXONOMY_VERSION,
          polarity: CLAIM_POLARITY_VERSION,
          negativeEvidenceRole: NEGATIVE_EVIDENCE_ROLE_VERSION,
          recognition: RECOGNITION_STATE_VERSION,
          stagedClassification: STAGED_CLASSIFICATION_VERSION,
          decisionPolicy: UNIFIED_DECISION_POLICY_VERSION,
          evidenceEngine: diagnostic.decision.versions.evidenceEngineVersion,
          scoringEngine: diagnostic.decision.versions.scoringEngineVersion,
        },
        replay: {
          inputChecksum: normalizedDiagnosticInput.input_checksum,
          inputChecksumVersion: normalizedDiagnosticInput.input_checksum_version,
          codeVersion: diagnostic.decision.versions.evidenceEngineVersion,
        },
      }),
      JSON.stringify(diagnostic.decision.versions),
      JSON.stringify(diagnostic.catalogVersions || []),
      diagnostic.observationKey || null
    ]
  );
  const diagnosticId = inserted.rows[0]?.id || (diagnostic.observationKey
    ? (await db.query('SELECT id FROM production_classification_diagnostics WHERE observation_key=$1', [diagnostic.observationKey])).rows[0]?.id
    : undefined);

  try {
    await persistClassificationEvidenceBundle(
      diagnostic.input,
      diagnostic.decision,
      diagnosticId,
      { requireCompleteObservation: Boolean(diagnostic.observationKey) }
    );
  } catch (error) {
    console.warn(`[EvidenceDualWrite] observational write failed for ${diagnostic.channelId}:`, error instanceof Error ? error.message : error);
    // A durable Phase B observation must remain retryable until the entire
    // diagnostic -> coverage -> Creator Focus lineage is present.
    if (diagnostic.observationKey) throw error;
  }

  return diagnosticId;
}
