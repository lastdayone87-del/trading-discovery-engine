import { createHash } from 'node:crypto';
import pg, { type PoolClient } from 'pg';
import { verifyChannelTradingRelevance, type RawChannelInput } from '../evidenceEngine';
import { recordProductionClassification } from '../classificationDiagnostics';
import { evaluateOfflineAdmissionV2, type OfflineAdmissionExample, type OfflineAdmissionV2Decision } from '../candidateAdmission/offlineV2';
import { CREATOR_FOCUS_CLASSIFIER_VERSION, CREATOR_FOCUS_POLICY_VERSION } from '../evidenceEngine/classifierV4';
import { EVIDENCE_COVERAGE_POLICY_VERSION } from '../evidenceEngine/coverage';

export const STAGE2_POSTFIX_SHADOW_VERSION = 'stage2-postfix-shadow-v1';

type GroundTruth = 'TRADING_CONFIRMED' | 'NON_TRADING';
type CohortRow = {
  exampleKey: string;
  channelId: string;
  groundTruth: GroundTruth;
  inclusionProbability: number;
  productionStatus: string;
  productionScore: number;
  segment: Record<string, string>;
  sourceDiagnosticId: string;
  input: RawChannelInput;
};

const json = <T>(value: T | string): T => typeof value === 'string' ? JSON.parse(value) as T : value;
const rate = (n: number, d: number) => d > 0 ? n / d : null;
const checksum = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function cleanInput(value: Record<string, unknown>): RawChannelInput {
  const { input_checksum: _ignored, ...input } = value;
  return input as unknown as RawChannelInput;
}

async function loadCohort(client: PoolClient, datasetId: string): Promise<CohortRow[]> {
  const dataset = await client.query(`SELECT id,status FROM decision_evaluation_datasets WHERE id=$1`, [datasetId]);
  if (!dataset.rowCount) throw new Error('SEALED_EVALUATION_DATASET_NOT_FOUND');
  if (String(dataset.rows[0].status) !== 'SEALED') throw new Error('STAGE2_REQUIRES_SEALED_STAGE1_DATASET');

  const rows = await client.query(`
    SELECT e.example_key,e.channel_id,e.ground_truth_label,e.inclusion_probability,
      e.production_status,e.production_score,e.segment,e.decision_diagnostic_id,
      d.normalized_input
    FROM decision_evaluation_examples e
    JOIN production_classification_diagnostics d ON d.id=e.decision_diagnostic_id
    WHERE e.dataset_id=$1 AND e.split='TEST'
    ORDER BY e.example_key`, [datasetId]);

  return rows.rows.map(row => ({
    exampleKey: String(row.example_key),
    channelId: String(row.channel_id),
    groundTruth: String(row.ground_truth_label) as GroundTruth,
    inclusionProbability: Number(row.inclusion_probability),
    productionStatus: String(row.production_status || 'UNCERTAIN'),
    productionScore: Number(row.production_score || 0),
    segment: json<Record<string, string>>(row.segment || {}),
    sourceDiagnosticId: String(row.decision_diagnostic_id),
    input: cleanInput(json<Record<string, unknown>>(row.normalized_input))
  }));
}

async function latestDatasetId(client: PoolClient): Promise<string> {
  const result = await client.query(`SELECT id FROM decision_evaluation_datasets WHERE status='SEALED' ORDER BY cutoff_at DESC,version DESC,id DESC LIMIT 1`);
  if (!result.rowCount) throw new Error('NO_SEALED_EVALUATION_DATASET');
  return String(result.rows[0].id);
}

async function loadFreshExample(client: PoolClient, row: CohortRow, diagnosticId: string): Promise<OfflineAdmissionExample> {
  const snapshot = await client.query(`
    SELECT
      f.id creator_focus_snapshot_id,f.input_checksum creator_focus_input_checksum,
      f.creator_focus_distribution,f.proposed_status creator_focus_proposed_status,
      f.probability creator_focus_probability,f.lower_confidence_bound,
      f.reason_codes creator_focus_reason_codes,f.stage_report creator_focus_stage_report,
      f.policy_version creator_focus_policy_version,
      c.id coverage_snapshot_id,c.completeness_disposition,
      c.observed_document_count,c.expected_document_count,c.independent_family_count,
      c.language_coverage,c.temporal_coverage,c.provider_availability,c.acquisition_failures,
      c.reason_codes coverage_reason_codes,c.input_checksum coverage_input_checksum,
      c.policy_version coverage_policy_version
    FROM (SELECT 1) seed
    LEFT JOIN LATERAL (
      SELECT f.* FROM creator_focus_classification_snapshots f
      WHERE f.classification_diagnostic_id=$1 AND f.classifier_version=$2 AND f.policy_version=$3
      ORDER BY f.observed_at DESC,f.id DESC LIMIT 1
    ) f ON true
    LEFT JOIN LATERAL (
      SELECT c.* FROM evidence_coverage_snapshots c
      WHERE c.classification_diagnostic_id=$1 AND c.policy_version=$4
      ORDER BY c.observed_at DESC,c.id DESC LIMIT 1
    ) c ON true`, [diagnosticId, CREATOR_FOCUS_CLASSIFIER_VERSION, CREATOR_FOCUS_POLICY_VERSION, EVIDENCE_COVERAGE_POLICY_VERSION]);
  const s = snapshot.rows[0] || {};
  if (!s.creator_focus_snapshot_id) throw new Error('POSTFIX_CREATOR_FOCUS_SNAPSHOT_MISSING');
  if (!s.coverage_snapshot_id) throw new Error('POSTFIX_EVIDENCE_COVERAGE_SNAPSHOT_MISSING');

  return {
    exampleKey: row.exampleKey,
    channelId: row.channelId,
    split: 'TEST',
    groundTruth: row.groundTruth,
    inclusionProbability: row.inclusionProbability,
    productionStatus: row.productionStatus,
    productionScore: row.productionScore,
    segment: row.segment,
    creatorFocusSnapshotId: String(s.creator_focus_snapshot_id),
    creatorFocusInputChecksum: String(s.creator_focus_input_checksum || ''),
    creatorFocusDistribution: json(s.creator_focus_distribution),
    creatorFocusProposedStatus: s.creator_focus_proposed_status,
    creatorFocusProbability: Number(s.creator_focus_probability || 0),
    creatorFocusLowerConfidenceBound: Number(s.lower_confidence_bound || 0),
    creatorFocusReasonCodes: json(s.creator_focus_reason_codes || []),
    creatorFocusStageReport: json(s.creator_focus_stage_report || {}),
    creatorFocusPolicyVersion: String(s.creator_focus_policy_version),
    coverage: {
      snapshotId: String(s.coverage_snapshot_id),
      disposition: s.completeness_disposition,
      observedDocumentCount: Number(s.observed_document_count || 0),
      expectedDocumentCount: Number(s.expected_document_count || 0),
      independentFamilyCount: Number(s.independent_family_count || 0),
      languageCoverage: json(s.language_coverage || {}),
      temporalCoverage: json(s.temporal_coverage || {}),
      providerAvailability: json(s.provider_availability || []),
      acquisitionFailures: json(s.acquisition_failures || []),
      reasonCodes: json(s.coverage_reason_codes || []),
      inputChecksum: String(s.coverage_input_checksum || ''),
      policyVersion: String(s.coverage_policy_version)
    }
  };
}

export async function runStage2PostFixShadowEvaluation(requestedDatasetId?: string) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'disable' ? false : process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined });
  const db = await pool.connect();
  try {
    const datasetId = requestedDatasetId || await latestDatasetId(db);
    const cohort = await loadCohort(db, datasetId);
    const rows: any[] = [];
    const failures: Array<{exampleKey:string;channelId:string;reason:string}> = [];

    for (const item of cohort) {
      const observationKey = `${STAGE2_POSTFIX_SHADOW_VERSION}:${datasetId}:${item.exampleKey}`;
      try {
        const existing = await db.query(`SELECT id FROM production_classification_diagnostics WHERE observation_key=$1`, [observationKey]);
        let diagnosticId = existing.rows[0]?.id ? String(existing.rows[0].id) : '';
        if (!diagnosticId) {
          const decision = await verifyChannelTradingRelevance(item.input);
          diagnosticId = String(await recordProductionClassification({ channelId: item.channelId, input: item.input, decision, observationKey }) || '');
          if (!diagnosticId) throw new Error('POSTFIX_DIAGNOSTIC_ID_MISSING');
        }
        const example = await loadFreshExample(db, item, diagnosticId);
        const result = evaluateOfflineAdmissionV2(example);
        rows.push({ ...result, sourceDiagnosticId: item.sourceDiagnosticId, postFixDiagnosticId: diagnosticId });
      } catch (error) {
        failures.push({ exampleKey: item.exampleKey, channelId: item.channelId, reason: error instanceof Error ? error.message : String(error) });
      }
    }

    const counts: Record<OfflineAdmissionV2Decision, number> = { ADMIT_CONFIRMED: 0, ADMIT_REVIEW: 0, WITHHOLD: 0, DEFER_INVESTIGATION: 0 };
    for (const row of rows) counts[row.decision as OfflineAdmissionV2Decision]++;
    const nonTrading = rows.filter(row => row.groundTruth === 'NON_TRADING');
    const genuine = rows.filter(row => row.groundTruth === 'TRADING_CONFIRMED');
    const withheldNonTrading = nonTrading.filter(row => row.decision === 'WITHHOLD');
    const retainedGenuine = genuine.filter(row => row.decision !== 'WITHHOLD');
    const decisive = rows.filter(row => row.decision === 'WITHHOLD' || row.decision === 'ADMIT_CONFIRMED');
    const providerDegraded = rows.filter(row => Array.isArray(row.evidenceCoverage?.acquisitionFailures) && row.evidenceCoverage.acquisitionFailures.length > 0);

    return {
      reportType: 'STAGE2_POSTFIX_SHADOW_EVALUATION',
      version: STAGE2_POSTFIX_SHADOW_VERSION,
      datasetId,
      groundTruthAnchor: 'SEALED_STAGE1_DATASET',
      generatedFromPostFixObservations: true,
      servingAuthority: false,
      automaticPromotion: false,
      mutatesOperationalState: false,
      totals: { sealedExamples: cohort.length, evaluated: rows.length, failed: failures.length, decisionCounts: counts },
      metrics: {
        evaluationCoverage: { rate: rate(rows.length, cohort.length) },
        decisiveDecisionRate: { decisive: decisive.length, evaluated: rows.length, rate: rate(decisive.length, rows.length) },
        falsePositiveWithhold: { nonTradingCreators: nonTrading.length, withheldNonTrading: withheldNonTrading.length, rate: rate(withheldNonTrading.length, nonTrading.length) },
        genuineCreatorRecall: { genuineCreators: genuine.length, retainedCreators: retainedGenuine.length, rate: rate(retainedGenuine.length, genuine.length) },
        providerDegradation: { affectedExamples: providerDegraded.length, evaluated: rows.length, rate: rate(providerDegraded.length, rows.length) }
      },
      failures,
      rows,
      outputChecksum: checksum(rows.map(row => ({ exampleKey: row.exampleKey, decision: row.decision, reasonCodes: row.reasonCodes, postFixDiagnosticId: row.postFixDiagnosticId }))),
      nextAction: failures.length > 0 ? 'RETRY_FAILED_POSTFIX_OBSERVATIONS' : 'REVIEW_POSTFIX_METRICS_FOR_STAGE2_PROMOTION_GATE'
    };
  } finally {
    db.release();
    await pool.end();
  }
}
