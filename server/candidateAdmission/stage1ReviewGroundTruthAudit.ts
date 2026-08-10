import pg from 'pg';
import { CREATOR_FOCUS_CLASSIFIER_VERSION, CREATOR_FOCUS_POLICY_VERSION } from '../evidenceEngine/classifierV4';
import { EVIDENCE_COVERAGE_POLICY_VERSION } from '../evidenceEngine/coverage';

export const STAGE1_REVIEW_GROUND_TRUTH_AUDIT_VERSION = 'stage1-review-ground-truth-audit-v1';

type AuditRow = {
  decision: 'APPROVE' | 'REJECT';
  label_id: string | null;
  outbox_id: string | null;
  outbox_status: string | null;
  diagnostic_id: string | null;
  assignment_id: string | null;
  inclusion_basis_points: number | null;
  focus_snapshot_id: string | null;
  coverage_snapshot_id: string | null;
};

export function summarizeStage1ReviewGroundTruthAudit(rows: AuditRow[]) {
  const summary = {
    reviewDecisions: rows.length,
    approve: 0,
    reject: 0,
    linkedGroundTruthLabels: 0,
    missingGroundTruthLabels: 0,
    outboxCaptured: 0,
    outboxPending: 0,
    exactLineageRecoverableAfterLabelReconciliation: 0,
    exactLineageRecoverableTrading: 0,
    exactLineageRecoverableNonTrading: 0,
    exclusions: {
      DIAGNOSTIC_MISSING: 0,
      RETRIEVAL_ASSIGNMENT_MISSING: 0,
      CREATOR_FOCUS_SNAPSHOT_MISSING: 0,
      EVIDENCE_COVERAGE_SNAPSHOT_MISSING: 0
    }
  };

  for (const row of rows) {
    if (row.decision === 'APPROVE') summary.approve++;
    else summary.reject++;
    if (row.label_id) summary.linkedGroundTruthLabels++;
    else summary.missingGroundTruthLabels++;
    if (row.outbox_id) summary.outboxCaptured++;
    if (row.outbox_id && row.outbox_status !== 'COMPLETED') summary.outboxPending++;

    if (!row.diagnostic_id) { summary.exclusions.DIAGNOSTIC_MISSING++; continue; }
    if (!row.assignment_id || !(Number(row.inclusion_basis_points) > 0)) { summary.exclusions.RETRIEVAL_ASSIGNMENT_MISSING++; continue; }
    if (!row.focus_snapshot_id) { summary.exclusions.CREATOR_FOCUS_SNAPSHOT_MISSING++; continue; }
    if (!row.coverage_snapshot_id) { summary.exclusions.EVIDENCE_COVERAGE_SNAPSHOT_MISSING++; continue; }

    summary.exactLineageRecoverableAfterLabelReconciliation++;
    if (row.decision === 'APPROVE') summary.exactLineageRecoverableTrading++;
    else summary.exactLineageRecoverableNonTrading++;
  }

  return summary;
}

export async function inspectStage1ReviewGroundTruthAudit() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    ssl: process.env.PGSSL === 'disable' ? false : process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    const result = await client.query(`
      SELECT d.id AS review_decision_id,d.channel_id,d.decision,d.decided_at,
             l.id AS label_id,
             o.id AS outbox_id,o.status AS outbox_status,
             pd.id AS diagnostic_id,
             a.id AS assignment_id,a.inclusion_basis_points,
             f.id AS focus_snapshot_id,
             c.id AS coverage_snapshot_id
        FROM channel_review_decisions d
        LEFT JOIN evaluation_ground_truth_labels l ON l.review_decision_id=d.id
        LEFT JOIN phase_b_observation_outbox o ON o.observation_key='phase-b:ground-truth:'||d.id::text
        LEFT JOIN LATERAL (
          SELECT x.id,x.created_at
            FROM production_classification_diagnostics x
           WHERE x.channel_id=d.channel_id AND x.created_at<=d.decided_at
           ORDER BY x.created_at DESC,x.id DESC LIMIT 1
        ) pd ON true
        LEFT JOIN LATERAL (
          SELECT x.id,x.inclusion_basis_points
            FROM evaluation_cohort_assignments x
           WHERE x.channel_id=d.channel_id
             AND x.cohort<>'NOT_SELECTED'
             AND x.inclusion_basis_points>0
             AND x.assigned_at<=COALESCE(pd.created_at,d.decided_at)
           ORDER BY x.assigned_at DESC,x.id DESC LIMIT 1
        ) a ON true
        LEFT JOIN LATERAL (
          SELECT x.id
            FROM creator_focus_classification_snapshots x
           WHERE x.classification_diagnostic_id=pd.id
             AND x.classifier_version=$1
             AND x.policy_version=$2
           ORDER BY x.observed_at DESC,x.id DESC LIMIT 1
        ) f ON true
        LEFT JOIN LATERAL (
          SELECT x.id
            FROM evidence_coverage_snapshots x
           WHERE x.classification_diagnostic_id=pd.id
             AND x.policy_version=$3
           ORDER BY x.observed_at DESC,x.id DESC LIMIT 1
        ) c ON true
       WHERE d.decision IN('APPROVE','REJECT')
       ORDER BY d.decided_at,d.id`, [
         CREATOR_FOCUS_CLASSIFIER_VERSION,
         CREATOR_FOCUS_POLICY_VERSION,
         EVIDENCE_COVERAGE_POLICY_VERSION
       ]);
    const summary = summarizeStage1ReviewGroundTruthAudit(result.rows as AuditRow[]);
    await client.query('ROLLBACK');
    return {
      reportType: 'STAGE1_REVIEW_GROUND_TRUTH_LINEAGE_AUDIT',
      version: STAGE1_REVIEW_GROUND_TRUTH_AUDIT_VERSION,
      readOnly: true,
      servingAuthority: false,
      automaticPromotion: false,
      summary
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
