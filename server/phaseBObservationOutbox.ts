import { createHash } from 'node:crypto';
import pg from 'pg';
import { getDb } from './db';
import { recordProductionClassification, type ProductionClassificationDiagnosticInput } from './classificationDiagnostics';
import { recordEvaluationGroundTruth, recordRetrievalEvaluationAssignment, type EvaluationGroundTruthInput, type SamplingPolicy } from './decisionEvaluation';

export const PHASE_B_OBSERVATION_OUTBOX_VERSION = 'phase-b-observation-outbox-v1';
export type PhaseBObservationType = 'RETRIEVAL_ASSIGNMENT' | 'PRODUCTION_DIAGNOSTIC' | 'GROUND_TRUTH_LABEL';

export interface RetrievalAssignmentPayload {
  type: 'RETRIEVAL_ASSIGNMENT';
  input: Parameters<typeof recordRetrievalEvaluationAssignment>[0];
  policy: SamplingPolicy;
}

export interface ProductionDiagnosticPayload {
  type: 'PRODUCTION_DIAGNOSTIC';
  input: ProductionClassificationDiagnosticInput;
}

export interface GroundTruthLabelPayload {
  type: 'GROUND_TRUTH_LABEL';
  input: EvaluationGroundTruthInput & { reviewDecisionId: string; provenance: 'HUMAN_REVIEW' };
}

export type PhaseBObservationPayload = RetrievalAssignmentPayload | ProductionDiagnosticPayload | GroundTruthLabelPayload;

export interface PhaseBObservationProcessorDependencies {
  recordAssignment: typeof recordRetrievalEvaluationAssignment;
  recordDiagnostic: typeof recordProductionClassification;
  recordGroundTruth: typeof recordEvaluationGroundTruth;
}

const stable = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
    : item
);
const hash = (value: unknown): string => createHash('sha256').update(stable(value)).digest('hex');

export function retrievalAssignmentObservationKey(payload: RetrievalAssignmentPayload): string {
  return `phase-b:assignment:${hash({ version: PHASE_B_OBSERVATION_OUTBOX_VERSION, ...payload })}`;
}

export function productionDiagnosticObservationKey(payload: ProductionDiagnosticPayload): string {
  return `phase-b:diagnostic:${hash({ version: PHASE_B_OBSERVATION_OUTBOX_VERSION, ...payload })}`;
}

export function groundTruthLabelObservationKey(reviewDecisionId: string): string {
  if (!reviewDecisionId.trim()) throw new Error('REVIEW_DECISION_ID_REQUIRED');
  return `phase-b:ground-truth:${reviewDecisionId}`;
}

async function captureObservation(observationKey: string, channelId: string, payload: PhaseBObservationPayload): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO phase_b_observation_outbox(observation_key,observation_type,channel_id,payload)
     VALUES($1,$2,$3,$4) ON CONFLICT(observation_key) DO NOTHING`,
    [observationKey, payload.type, channelId, JSON.stringify(payload)]
  );
}

async function processObservation(observationKey: string): Promise<string | undefined> {
  const db = await getDb(), client = await db.connect();
  let payload: PhaseBObservationPayload | undefined;
  try {
    await client.query('BEGIN');
    const claimed = await client.query(
      `SELECT payload,status,result_reference FROM phase_b_observation_outbox
       WHERE observation_key=$1 AND status<>'COMPLETED' AND run_after<=now()
       FOR UPDATE SKIP LOCKED`,
      [observationKey]
    );
    if (!claimed.rowCount) {
      const prior = await client.query('SELECT result_reference FROM phase_b_observation_outbox WHERE observation_key=$1', [observationKey]);
      await client.query('COMMIT');
      return prior.rows[0]?.result_reference || undefined;
    }
    payload = claimed.rows[0].payload as PhaseBObservationPayload;
    await client.query(`UPDATE phase_b_observation_outbox SET status='PROCESSING',attempts=attempts+1,last_error=NULL,updated_at=now() WHERE observation_key=$1`, [observationKey]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  try {
    const resultReference = await executePhaseBObservation(payload, observationKey);
    await db.query(
      `UPDATE phase_b_observation_outbox SET status='COMPLETED',result_reference=$2,last_error=NULL,completed_at=now(),updated_at=now() WHERE observation_key=$1`,
      [observationKey, resultReference || null]
    );
    return resultReference;
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).slice(0, 2000);
    await db.query(
      `UPDATE phase_b_observation_outbox SET status='PENDING',last_error=$2,run_after=now()+(LEAST(900,30*power(2,LEAST(attempts,5)))||' seconds')::interval,updated_at=now() WHERE observation_key=$1`,
      [observationKey, message]
    );
    throw error;
  }
}

export async function executePhaseBObservation(
  payload: PhaseBObservationPayload,
  observationKey: string,
  dependencies: PhaseBObservationProcessorDependencies = { recordAssignment: recordRetrievalEvaluationAssignment, recordDiagnostic: recordProductionClassification, recordGroundTruth: recordEvaluationGroundTruth }
): Promise<string> {
  if (payload.type === 'RETRIEVAL_ASSIGNMENT') {
    const assignment = await dependencies.recordAssignment(payload.input, payload.policy);
    return assignment.assignmentKey;
  }
  if (payload.type === 'PRODUCTION_DIAGNOSTIC') {
    const diagnosticId = await dependencies.recordDiagnostic({ ...payload.input, observationKey });
    if (!diagnosticId) throw new Error('PRODUCTION_DIAGNOSTIC_ID_REQUIRED');
    return diagnosticId;
  }
  const label = await dependencies.recordGroundTruth(payload.input);
  if (!label?.id) throw new Error('GROUND_TRUTH_LABEL_ID_REQUIRED');
  return String(label.id);
}

export async function observeRetrievalAssignmentReliably(payload: RetrievalAssignmentPayload): Promise<string | undefined> {
  const observationKey = retrievalAssignmentObservationKey(payload);
  await captureObservation(observationKey, payload.input.channelId, payload);
  return processObservation(observationKey);
}

export async function observeProductionDiagnosticReliably(payload: ProductionDiagnosticPayload): Promise<string | undefined> {
  const observationKey = productionDiagnosticObservationKey(payload);
  await captureObservation(observationKey, payload.input.channelId, payload);
  return processObservation(observationKey);
}

export async function observeGroundTruthLabelReliably(payload: GroundTruthLabelPayload): Promise<string | undefined> {
  const observationKey = groundTruthLabelObservationKey(payload.input.reviewDecisionId);
  await captureObservation(observationKey, payload.input.channelId, payload);
  return processObservation(observationKey);
}

export async function reconcileMissingGroundTruthObservations(limit = 25): Promise<{ discovered: number; completed: number; failed: number }> {
  const db = await getDb(), bounded = Math.min(100, Math.max(1, Math.trunc(limit)));
  const missing = await db.query(
    `SELECT d.id,d.channel_id,d.decision,d.evidence_snapshot
       FROM channel_review_decisions d
       LEFT JOIN evaluation_ground_truth_labels l ON l.review_decision_id=d.id
       LEFT JOIN phase_b_observation_outbox o ON o.observation_key='phase-b:ground-truth:'||d.id::text
      WHERE d.decision IN('APPROVE','REJECT') AND l.id IS NULL AND o.id IS NULL
      ORDER BY d.decided_at,d.id LIMIT $1`,
    [bounded]
  );
  let completed = 0, failed = 0;
  for (const row of missing.rows) {
    try {
      await observeGroundTruthLabelReliably({ type: 'GROUND_TRUTH_LABEL', input: { channelId: String(row.channel_id), reviewDecisionId: String(row.id), label: row.decision === 'APPROVE' ? 'TRADING_CONFIRMED' : 'NON_TRADING', provenance: 'HUMAN_REVIEW', evidenceSnapshot: row.evidence_snapshot || {} } });
      completed++;
    } catch { failed++; }
  }
  return { discovered: missing.rowCount || 0, completed, failed };
}

export async function reconcilePendingPhaseBObservations(limit = 25): Promise<{ attempted: number; completed: number; failed: number }> {
  const db = await getDb(), bounded = Math.min(100, Math.max(1, Math.trunc(limit)));
  await db.query(`UPDATE phase_b_observation_outbox SET status='PENDING',run_after=now(),last_error='STALE_PROCESSING_RECOVERED',updated_at=now() WHERE status='PROCESSING' AND updated_at<now()-interval '10 minutes'`);
  const pending = await db.query(
    `SELECT observation_key FROM phase_b_observation_outbox WHERE status='PENDING' AND run_after<=now() ORDER BY created_at,observation_key LIMIT $1`,
    [bounded]
  );
  let completed = 0, failed = 0;
  for (const row of pending.rows) {
    try { await processObservation(String(row.observation_key)); completed++; }
    catch { failed++; }
  }
  return { attempted: pending.rowCount || 0, completed, failed };
}

let reconciliationInFlight = false;
export function triggerPhaseBObservationReconciliation(limit = 25): boolean {
  if (reconciliationInFlight) return false;
  reconciliationInFlight = true;
  void reconcileMissingGroundTruthObservations(limit).then(() => reconcilePendingPhaseBObservations(limit))
    .catch(error => console.warn('[PhaseB] Observation reconciliation failed:', error instanceof Error ? error.message : error))
    .finally(() => { reconciliationInFlight = false; });
  return true;
}

export interface PhaseBObservationCompletenessReport {
  version: string;
  servingAuthority: false;
  totals: Record<PhaseBObservationType, { captured: number; completed: number; pending: number; missingResultReferences: number; oldestPendingAt?: string }>;
  groundTruthReviews: { eligible: number; labeled: number; unreconciled: number };
  complete: boolean;
}

export function buildPhaseBObservationCompleteness(rows: Array<{ observation_type: PhaseBObservationType; captured: number | string; completed: number | string; pending: number | string; missing_result_references?: number | string; oldest_pending_at?: string | Date | null }>, groundTruthReviews: { eligible: number; labeled: number; unreconciled: number } = { eligible: 0, labeled: 0, unreconciled: 0 }): PhaseBObservationCompletenessReport {
  const totals = Object.fromEntries((['RETRIEVAL_ASSIGNMENT', 'PRODUCTION_DIAGNOSTIC', 'GROUND_TRUTH_LABEL'] as PhaseBObservationType[]).map(type => {
    const row = rows.find(item => item.observation_type === type);
    return [type, { captured: Number(row?.captured || 0), completed: Number(row?.completed || 0), pending: Number(row?.pending || 0), missingResultReferences: Number(row?.missing_result_references || 0), ...(row?.oldest_pending_at ? { oldestPendingAt: new Date(row.oldest_pending_at).toISOString() } : {}) }];
  })) as PhaseBObservationCompletenessReport['totals'];
  return { version: PHASE_B_OBSERVATION_OUTBOX_VERSION, servingAuthority: false, totals, groundTruthReviews, complete: groundTruthReviews.unreconciled === 0 && Object.values(totals).every(item => item.pending === 0 && item.missingResultReferences === 0 && item.captured === item.completed) };
}

export async function inspectPhaseBObservationCompleteness(): Promise<PhaseBObservationCompletenessReport> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for Phase B completeness inspection.');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, ssl: process.env.PGSSL === 'disable' ? false : process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined });
  const db = await pool.connect();
  try {
    await db.query('BEGIN TRANSACTION READ ONLY');
    const result = await db.query(
      `SELECT o.observation_type,count(*)::int captured,count(*) FILTER(WHERE o.status='COMPLETED')::int completed,
            count(*) FILTER(WHERE status<>'COMPLETED')::int pending,
            count(*) FILTER(WHERE o.status='COMPLETED' AND ((o.observation_type='RETRIEVAL_ASSIGNMENT' AND a.id IS NULL) OR (o.observation_type='PRODUCTION_DIAGNOSTIC' AND d.id IS NULL) OR (o.observation_type='GROUND_TRUTH_LABEL' AND l.id IS NULL)))::int missing_result_references,
            min(o.created_at) FILTER(WHERE o.status<>'COMPLETED') oldest_pending_at
       FROM phase_b_observation_outbox o
       LEFT JOIN evaluation_cohort_assignments a ON o.observation_type='RETRIEVAL_ASSIGNMENT' AND a.assignment_key=o.result_reference
       LEFT JOIN production_classification_diagnostics d ON o.observation_type='PRODUCTION_DIAGNOSTIC' AND d.id::text=o.result_reference
       LEFT JOIN evaluation_ground_truth_labels l ON o.observation_type='GROUND_TRUTH_LABEL' AND l.id::text=o.result_reference
       GROUP BY o.observation_type ORDER BY o.observation_type`
    );
    const reviewCoverage = await db.query(`SELECT count(*)::int eligible,count(l.id)::int labeled,count(*) FILTER(WHERE l.id IS NULL)::int unreconciled FROM channel_review_decisions d LEFT JOIN evaluation_ground_truth_labels l ON l.review_decision_id=d.id WHERE d.decision IN('APPROVE','REJECT')`);
    const report = buildPhaseBObservationCompleteness(result.rows, { eligible: Number(reviewCoverage.rows[0]?.eligible || 0), labeled: Number(reviewCoverage.rows[0]?.labeled || 0), unreconciled: Number(reviewCoverage.rows[0]?.unreconciled || 0) });
    await db.query('ROLLBACK');
    return report;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    db.release();
    await pool.end();
  }
}
