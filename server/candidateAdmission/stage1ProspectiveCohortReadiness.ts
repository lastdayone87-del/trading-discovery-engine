import pg from 'pg';
import { CREATOR_FOCUS_CLASSIFIER_VERSION, CREATOR_FOCUS_POLICY_VERSION } from '../evidenceEngine/classifierV4';
import { EVIDENCE_COVERAGE_POLICY_VERSION } from '../evidenceEngine/coverage';

export const STAGE1_PROSPECTIVE_COHORT_READINESS_VERSION = 'stage1-prospective-cohort-readiness-v1';
export const DEFAULT_STAGE1_MINIMUM_PER_CLASS = 30;

export type ProspectiveEligibilityReason =
  | 'HUMAN_REVIEW_DECISION_MISSING'
  | 'HUMAN_REVIEW_DECISION_MISMATCH'
  | 'GROUND_TRUTH_OUTBOX_NOT_COMPLETED'
  | 'DIAGNOSTIC_MISSING'
  | 'RETRIEVAL_ASSIGNMENT_MISSING'
  | 'CREATOR_FOCUS_SNAPSHOT_MISSING'
  | 'EVIDENCE_COVERAGE_SNAPSHOT_MISSING';

export type ProspectiveCandidate = {
  label_id: string;
  channel_id: string;
  label: 'TRADING_CONFIRMED' | 'NON_TRADING';
  provenance: 'HUMAN_REVIEW' | 'ADJUDICATION';
  labeled_at: string | Date;
  review_decision_id: string | null;
  review_decision: 'APPROVE' | 'REJECT' | null;
  ground_truth_outbox_status: string | null;
  diagnostic_id: string | null;
  assignment_id: string | null;
  inclusion_basis_points: number | null;
  focus_snapshot_id: string | null;
  coverage_snapshot_id: string | null;
};

export function prospectiveEligibility(row: ProspectiveCandidate): { eligible: boolean; reason: ProspectiveEligibilityReason | null } {
  if (row.provenance === 'HUMAN_REVIEW') {
    if (!row.review_decision_id || !row.review_decision) return { eligible: false, reason: 'HUMAN_REVIEW_DECISION_MISSING' };
    const expected = row.review_decision === 'APPROVE' ? 'TRADING_CONFIRMED' : row.review_decision === 'REJECT' ? 'NON_TRADING' : null;
    if (!expected || expected !== row.label) return { eligible: false, reason: 'HUMAN_REVIEW_DECISION_MISMATCH' };
    if (row.ground_truth_outbox_status !== 'COMPLETED') return { eligible: false, reason: 'GROUND_TRUTH_OUTBOX_NOT_COMPLETED' };
  }
  if (!row.diagnostic_id) return { eligible: false, reason: 'DIAGNOSTIC_MISSING' };
  if (!row.assignment_id || !(Number(row.inclusion_basis_points) > 0)) return { eligible: false, reason: 'RETRIEVAL_ASSIGNMENT_MISSING' };
  if (!row.focus_snapshot_id) return { eligible: false, reason: 'CREATOR_FOCUS_SNAPSHOT_MISSING' };
  if (!row.coverage_snapshot_id) return { eligible: false, reason: 'EVIDENCE_COVERAGE_SNAPSHOT_MISSING' };
  return { eligible: true, reason: null };
}

export function summarizeProspectiveReadiness(rows: ProspectiveCandidate[], minimumPerClass = DEFAULT_STAGE1_MINIMUM_PER_CLASS) {
  const exclusions: Partial<Record<ProspectiveEligibilityReason, number>> = {};
  const byProvenance = { HUMAN_REVIEW: 0, ADJUDICATION: 0 };
  let eligibleTrading = 0;
  let eligibleNonTrading = 0;
  let rawTrading = 0;
  let rawNonTrading = 0;

  for (const row of rows) {
    byProvenance[row.provenance]++;
    if (row.label === 'TRADING_CONFIRMED') rawTrading++;
    else rawNonTrading++;
    const result = prospectiveEligibility(row);
    if (!result.eligible) {
      exclusions[result.reason!] = (exclusions[result.reason!] || 0) + 1;
      continue;
    }
    if (row.label === 'TRADING_CONFIRMED') eligibleTrading++;
    else eligibleNonTrading++;
  }

  const ready = eligibleTrading >= minimumPerClass && eligibleNonTrading >= minimumPerClass;
  return {
    independentLabels: rows.length,
    byProvenance,
    raw: { tradingConfirmed: rawTrading, nonTrading: rawNonTrading },
    eligible: {
      total: eligibleTrading + eligibleNonTrading,
      tradingConfirmed: eligibleTrading,
      nonTrading: eligibleNonTrading
    },
    exclusions,
    minimumPerClass,
    remaining: {
      tradingConfirmed: Math.max(0, minimumPerClass - eligibleTrading),
      nonTrading: Math.max(0, minimumPerClass - eligibleNonTrading)
    },
    ready,
    nextAction: ready ? 'RUN_STAGE1_GROUND_TRUTH_SEAL_PREVIEW' : 'CONTINUE_PROSPECTIVE_HUMAN_REVIEW'
  };
}

async function loadCandidates(client: pg.PoolClient): Promise<ProspectiveCandidate[]> {
  const result = await client.query(`
    WITH latest_labels AS (
      SELECT DISTINCT ON (l.channel_id)
             l.id AS label_id,l.channel_id,l.label,l.provenance,l.labeled_at,l.review_decision_id
        FROM evaluation_ground_truth_labels l
       WHERE l.label IN ('TRADING_CONFIRMED','NON_TRADING')
         AND l.provenance IN ('HUMAN_REVIEW','ADJUDICATION')
       ORDER BY l.channel_id,l.labeled_at DESC,l.id DESC
    )
    SELECT l.*,
           d.decision::text AS review_decision,
           o.status::text AS ground_truth_outbox_status,
           pd.id AS diagnostic_id,
           a.id AS assignment_id,a.inclusion_basis_points,
           f.id AS focus_snapshot_id,
           c.id AS coverage_snapshot_id
      FROM latest_labels l
      LEFT JOIN channel_review_decisions d ON d.id=l.review_decision_id
      LEFT JOIN phase_b_observation_outbox o
        ON o.observation_key='phase-b:ground-truth:'||l.review_decision_id::text
      LEFT JOIN LATERAL (
        SELECT x.id,x.created_at
          FROM production_classification_diagnostics x
         WHERE x.channel_id=l.channel_id AND x.created_at<=l.labeled_at
         ORDER BY x.created_at DESC,x.id DESC LIMIT 1
      ) pd ON true
      LEFT JOIN LATERAL (
        SELECT x.id,x.inclusion_basis_points
          FROM evaluation_cohort_assignments x
         WHERE x.channel_id=l.channel_id
           AND x.cohort<>'NOT_SELECTED'
           AND x.inclusion_basis_points>0
           AND x.assigned_at<=COALESCE(pd.created_at,l.labeled_at)
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
     ORDER BY l.labeled_at,l.channel_id`, [
    CREATOR_FOCUS_CLASSIFIER_VERSION,
    CREATOR_FOCUS_POLICY_VERSION,
    EVIDENCE_COVERAGE_POLICY_VERSION
  ]);
  return result.rows as ProspectiveCandidate[];
}

export async function inspectStage1ProspectiveCohortReadiness(minimumPerClass = DEFAULT_STAGE1_MINIMUM_PER_CLASS) {
  if (!Number.isInteger(minimumPerClass) || minimumPerClass < 1) throw new Error('minimumPerClass must be a positive integer.');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    ssl: process.env.PGSSL === 'disable' ? false : process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    const rows = await loadCandidates(client);
    const summary = summarizeProspectiveReadiness(rows, minimumPerClass);
    await client.query('ROLLBACK');
    return {
      reportType: 'STAGE1_PROSPECTIVE_COHORT_READINESS',
      version: STAGE1_PROSPECTIVE_COHORT_READINESS_VERSION,
      readOnly: true,
      servingAuthority: false,
      automaticPromotion: false,
      groundTruthRule: 'Only HUMAN_REVIEW and ADJUDICATION labels with complete pre-label evaluation lineage are eligible.',
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
