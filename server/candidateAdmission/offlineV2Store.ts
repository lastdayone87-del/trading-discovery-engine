import pg from 'pg';
import type { CreatorFocusDistribution } from '../evidenceEngine/hypothesisTaxonomy';
import { CREATOR_FOCUS_CLASSIFIER_VERSION, CREATOR_FOCUS_POLICY_VERSION } from '../evidenceEngine/classifierV4';
import { EVIDENCE_COVERAGE_POLICY_VERSION } from '../evidenceEngine/coverage';
import { buildOfflineAdmissionV2Report, type OfflineAdmissionCoverage, type OfflineAdmissionExample, type OfflineAdmissionV2Report } from './offlineV2';

const json = <T>(value: T | string): T => typeof value === 'string' ? JSON.parse(value) as T : value;

/**
 * Read-only historical loader. The sealed dataset, ground-truth examples,
 * creator-focus snapshots, and coverage snapshots are all immutable tables.
 */
export async function evaluateSealedDatasetOfflineV2(datasetId: string): Promise<OfflineAdmissionV2Report> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(datasetId)) throw new Error('A sealed evaluation dataset UUID is required.');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for offline historical evaluation.');
  const { Pool } = pg;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'disable' ? false : process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined });
  const db = await pool.connect();
  try {
    await db.query('BEGIN TRANSACTION READ ONLY');
    const datasetResult = await db.query(`SELECT id,dataset_key,version,cutoff_at,checksum FROM decision_evaluation_datasets WHERE id=$1`, [datasetId]);
    if (!datasetResult.rowCount) throw new Error('SEALED_EVALUATION_DATASET_NOT_FOUND');
    const datasetRow = datasetResult.rows[0];
    const rows = await db.query(`
      SELECT e.example_key,e.channel_id,e.split,e.ground_truth_label,e.inclusion_probability,
        e.production_status,e.production_score,e.segment,e.decision_diagnostic_id,
        focus.id creator_focus_snapshot_id,focus.input_checksum creator_focus_input_checksum,
        focus.creator_focus_distribution,focus.proposed_status creator_focus_proposed_status,
        focus.probability creator_focus_probability,focus.lower_confidence_bound,
        focus.reason_codes creator_focus_reason_codes,focus.stage_report creator_focus_stage_report,
        focus.policy_version creator_focus_policy_version,
        coverage.id coverage_snapshot_id,coverage.completeness_disposition,
        coverage.observed_document_count,coverage.expected_document_count,
        coverage.independent_family_count,coverage.language_coverage,coverage.temporal_coverage,
        coverage.provider_availability,coverage.acquisition_failures,coverage.reason_codes coverage_reason_codes,
        coverage.input_checksum coverage_input_checksum,coverage.policy_version coverage_policy_version
      FROM decision_evaluation_examples e
      LEFT JOIN LATERAL (
        SELECT f.* FROM creator_focus_classification_snapshots f
        WHERE f.classification_diagnostic_id=e.decision_diagnostic_id AND f.observed_at<=$2
          AND f.classifier_version=$3 AND f.policy_version=$4
        ORDER BY f.observed_at DESC,f.id DESC LIMIT 1
      ) focus ON true
      LEFT JOIN LATERAL (
        SELECT c.* FROM evidence_coverage_snapshots c
        WHERE c.classification_diagnostic_id=e.decision_diagnostic_id AND c.observed_at<=$2 AND c.policy_version=$5
        ORDER BY c.observed_at DESC,c.id DESC LIMIT 1
      ) coverage ON true
      WHERE e.dataset_id=$1 AND e.split='TEST'
      ORDER BY e.example_key`, [datasetId, datasetRow.cutoff_at, CREATOR_FOCUS_CLASSIFIER_VERSION, CREATOR_FOCUS_POLICY_VERSION, EVIDENCE_COVERAGE_POLICY_VERSION]);

    const examples: OfflineAdmissionExample[] = [];
    const excludedExamples: OfflineAdmissionV2Report['excludedExamples'] = [];
    for (const row of rows.rows) {
      if (!row.creator_focus_snapshot_id || !row.coverage_snapshot_id) {
        excludedExamples.push({ exampleKey: row.example_key, channelId: row.channel_id, reasonCode: !row.creator_focus_snapshot_id ? 'CREATOR_FOCUS_SNAPSHOT_MISSING' : 'EVIDENCE_COVERAGE_SNAPSHOT_MISSING' });
        continue;
      }
      const coverage: OfflineAdmissionCoverage = {
        snapshotId: row.coverage_snapshot_id,
        disposition: row.completeness_disposition,
        observedDocumentCount: Number(row.observed_document_count),
        expectedDocumentCount: Number(row.expected_document_count),
        independentFamilyCount: Number(row.independent_family_count),
        languageCoverage: json(row.language_coverage), temporalCoverage: json(row.temporal_coverage),
        providerAvailability: json(row.provider_availability), acquisitionFailures: json(row.acquisition_failures),
        reasonCodes: json(row.coverage_reason_codes), inputChecksum: row.coverage_input_checksum,
        policyVersion: row.coverage_policy_version
      };
      examples.push({
        exampleKey: row.example_key, channelId: row.channel_id, split: row.split,
        groundTruth: row.ground_truth_label, inclusionProbability: Number(row.inclusion_probability),
        productionStatus: row.production_status, productionScore: Number(row.production_score),
        segment: json(row.segment), creatorFocusSnapshotId: row.creator_focus_snapshot_id,
        creatorFocusInputChecksum: row.creator_focus_input_checksum,
        creatorFocusDistribution: json<CreatorFocusDistribution>(row.creator_focus_distribution),
        creatorFocusProposedStatus: row.creator_focus_proposed_status,
        creatorFocusProbability: Number(row.creator_focus_probability),
        creatorFocusLowerConfidenceBound: Number(row.lower_confidence_bound),
        creatorFocusReasonCodes: json(row.creator_focus_reason_codes),
        creatorFocusStageReport: json(row.creator_focus_stage_report),
        creatorFocusPolicyVersion: row.creator_focus_policy_version,
        coverage
      });
    }
    const report = buildOfflineAdmissionV2Report({
      dataset: { id: datasetRow.id, key: datasetRow.dataset_key, version: Number(datasetRow.version), cutoffAt: new Date(datasetRow.cutoff_at).toISOString(), checksum: datasetRow.checksum },
      examples,
      excludedExamples
    });
    await db.query('COMMIT');
    return report;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    db.release();
    await pool.end();
  }
}
