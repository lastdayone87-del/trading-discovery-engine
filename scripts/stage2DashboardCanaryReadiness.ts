import { mkdir, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { evaluateStage1SealedDatasetReplay } from '../server/candidateAdmission/stage1SealedDatasetReplay';
import { evaluateStage2DashboardCanaryReadiness } from '../server/release5/stage2DashboardCanaryReadiness';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'disable' ? false : process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
});

const client = await pool.connect();
let datasetId = process.env.STAGE1_DATASET_ID || '';
let runtime: {
  dashboardServingMode: string;
  rolloutMode?: string | null;
  rolloutGateDecision?: string | null;
  rolloutActivationId?: string | null;
  assignedTreatmentCount?: number;
};

try {
  await client.query('BEGIN TRANSACTION READ ONLY');
  if (!datasetId) {
    const latest = await client.query(`SELECT id FROM decision_evaluation_datasets ORDER BY cutoff_at DESC, version DESC, id DESC LIMIT 1`);
    if (!latest.rowCount) throw new Error('NO_SEALED_EVALUATION_DATASET');
    datasetId = String(latest.rows[0].id);
  }

  const control = await client.query(`
    SELECT
      COALESCE((SELECT setting_value FROM app_settings WHERE setting_key='release5_dashboard_serving_mode'),'OFF') dashboard_serving_mode,
      p.mode rollout_mode,
      p.activation_id rollout_activation_id,
      g.decision rollout_gate_decision,
      COALESCE((SELECT count(*)::int FROM release5_serving_assignments a
        WHERE a.capability='DASHBOARD_CORPUS'
          AND a.assigned=true
          AND (p.activation_id IS NULL OR a.activation_id=p.activation_id)),0)::int assigned_treatment_count
    FROM (SELECT 1) seed
    LEFT JOIN release5_rollout_projection p ON p.capability='DASHBOARD_CORPUS'
    LEFT JOIN decision_promotion_gates g ON g.id=p.promotion_gate_id
  `);
  const row = control.rows[0] || {};
  runtime = {
    dashboardServingMode: String(row.dashboard_serving_mode || 'OFF'),
    rolloutMode: row.rollout_mode || null,
    rolloutGateDecision: row.rollout_gate_decision || null,
    rolloutActivationId: row.rollout_activation_id || null,
    assignedTreatmentCount: Number(row.assigned_treatment_count || 0)
  };
  await client.query('ROLLBACK');
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  client.release();
}

try {
  const stage1 = await evaluateStage1SealedDatasetReplay(datasetId);
  const report = evaluateStage2DashboardCanaryReadiness(stage1 as any, runtime!);
  await mkdir('stage2-output', { recursive: true });
  await writeFile('stage2-output/stage2-dashboard-canary-readiness.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ datasetId, readyForPromotionGate: report.readyForPromotionGate, reasons: report.reasons, runtime: report.observed.runtime }, null, 2));
} finally {
  await pool.end();
}
