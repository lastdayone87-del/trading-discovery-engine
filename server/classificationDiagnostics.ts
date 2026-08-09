import { createHash } from 'node:crypto';
import { getDb } from './db';
import type { RawChannelInput, VerificationDecision } from './evidenceEngine';
import { persistClassificationEvidenceBundle } from './evidenceEngine/dualWrite';

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

function normalize(input: RawChannelInput) {
  const stable = {
    ...input,
    channel_name: input.channel_name.normalize('NFKC').trim(),
    description: input.description || '',
    external_links: [...(input.external_links || [])].sort()
  };
  return {
    ...stable,
    input_checksum: createHash('sha256').update(JSON.stringify(stable)).digest('hex')
  };
}

/**
 * Persists the authoritative diagnostic exactly once, then invokes the
 * Release 2/3 evidence plane as a failure-contained observational write.
 */
export async function recordProductionClassification(
  diagnostic: ProductionClassificationDiagnosticInput
): Promise<string | undefined> {
  const db = await getDb();
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
      JSON.stringify(normalize(diagnostic.input)),
      JSON.stringify(diagnostic.decision.evidenceCollection.providers),
      JSON.stringify([
        ...diagnostic.decision.positiveEvidence,
        ...diagnostic.decision.negativeEvidence
      ]),
      JSON.stringify(diagnostic.decision.stagedClassification || {}),
      JSON.stringify({
        schemaVersion: 'production-decision-envelope-v2',
        status: diagnostic.decision.status,
        confidenceScore: diagnostic.decision.confidenceScore,
        category: diagnostic.decision.category,
        positiveWeight: diagnostic.decision.totalPositiveWeight,
        negativeWeight: diagnostic.decision.totalNegativeWeight,
        justification: diagnostic.decision.mathematicalJustification,
        evidenceCollection: diagnostic.decision.evidenceCollection,
        stagedClassification: diagnostic.decision.stagedClassification,
        decisionPolicy: diagnostic.decision.decisionPolicy
      }),
      JSON.stringify(diagnostic.decision.versions),
      JSON.stringify(diagnostic.catalogVersions || []),
      diagnostic.observationKey || null
    ]
  );
  const diagnosticId = inserted.rows[0]?.id || (diagnostic.observationKey
    ? (await db.query('SELECT id FROM production_classification_diagnostics WHERE observation_key=$1', [diagnostic.observationKey])).rows[0]?.id
    : undefined);

  await persistClassificationEvidenceBundle(
    diagnostic.input,
    diagnostic.decision,
    diagnosticId
  ).catch(error => console.warn(
    `[EvidenceDualWrite] observational write failed for ${diagnostic.channelId}:`,
    error instanceof Error ? error.message : error
  ));

  return diagnosticId;
}
