import { getDb } from '../db';
import { assignAdmissionCanary } from '../candidateAdmission/policy';
import { STAGE2_LIMITED_CANARY_DESIGN_VERSION, STAGE2_LIMITED_CANARY_POLICY, type Stage2CanaryKillSwitchMode } from './stage2LimitedCanaryDesign';

const CONTROL_LOCK = 18422026;
const SETTING_KEY = 'stage2_rate_pressure_canary_mode';

export type Stage2AbortReason =
  | 'ANY_HUMAN_CONFIRMED_TRADING_CREATOR_WITHHELD'
  | 'ANY_CANARY_INVARIANT_OR_PROJECTION_MISMATCH'
  | 'TREATMENT_SUBJECT_CAP_EXCEEDED'
  | 'KILL_SWITCH_STATE_MISMATCH'
  | 'REQUIRED_EVIDENCE_SNAPSHOT_MISSING';

export interface Stage2ManualModeChange {
  actor: string;
  reason: string;
  manualApproval: true;
  expectedGeneration: number;
}

export async function getStage2CanaryControlState() {
  const db = await getDb();
  const res = await db.query(`SELECT mode,generation,last_actor,last_reason,aborted_at,updated_at FROM stage2_rate_pressure_canary_control WHERE singleton=TRUE`);
  const row = res.rows[0];
  if (!row) throw new Error('STAGE2_CANARY_CONTROL_ROW_MISSING');
  return {
    settingKey: SETTING_KEY,
    mode: row.mode as Stage2CanaryKillSwitchMode,
    generation: Number(row.generation),
    lastActor: row.last_actor ?? null,
    lastReason: row.last_reason ?? null,
    abortedAt: row.aborted_at ?? null,
    updatedAt: row.updated_at,
    automaticEnableForbidden: true,
    defaultMode: 'OFF' as const
  };
}

export async function setStage2CanaryMode(mode: Stage2CanaryKillSwitchMode, change: Stage2ManualModeChange) {
  if (!change.actor.trim() || !change.reason.trim() || change.manualApproval !== true) throw new Error('MANUAL_OPERATOR_APPROVAL_REQUIRED');
  const db = await getDb();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [CONTROL_LOCK]);
    const current = await client.query(`SELECT mode,generation FROM stage2_rate_pressure_canary_control WHERE singleton=TRUE FOR UPDATE`);
    const row = current.rows[0];
    if (!row) throw new Error('STAGE2_CANARY_CONTROL_ROW_MISSING');
    if (Number(row.generation) !== change.expectedGeneration) throw new Error('STAGE2_CANARY_STALE_CONTROL_GENERATION');
    const nextGeneration = Number(row.generation) + 1;
    await client.query(`UPDATE stage2_rate_pressure_canary_control SET mode=$1,generation=$2,last_actor=$3,last_reason=$4,aborted_at=CASE WHEN $1='CANARY' THEN NULL ELSE aborted_at END,updated_at=now() WHERE singleton=TRUE`, [mode, nextGeneration, change.actor, change.reason]);
    await client.query(`INSERT INTO stage2_rate_pressure_canary_events(event_type,canary_generation,mode,actor,reason,payload) VALUES('MODE_CHANGE',$1,$2,$3,$4,$5)`, [nextGeneration, mode, change.actor, change.reason, JSON.stringify({ from: row.mode, to: mode, generation: nextGeneration, manualApproval: true })]);
    await client.query('COMMIT');
    return { settingKey: SETTING_KEY, mode, generation: nextGeneration, manual: true as const };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function abortStage2Canary(reason: Stage2AbortReason, actor = 'system-safety-abort') {
  const db = await getDb();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [CONTROL_LOCK]);
    const current = await client.query(`SELECT mode,generation FROM stage2_rate_pressure_canary_control WHERE singleton=TRUE FOR UPDATE`);
    const row = current.rows[0];
    if (!row) throw new Error('STAGE2_CANARY_CONTROL_ROW_MISSING');
    const activeGeneration = Number(row.generation);
    const nextGeneration = activeGeneration + 1;
    await client.query(`UPDATE stage2_rate_pressure_canary_control SET mode='OFF',generation=$1,last_actor=$2,last_reason=$3,aborted_at=now(),updated_at=now() WHERE singleton=TRUE`, [nextGeneration, actor, reason]);
    await client.query(`UPDATE stage2_rate_pressure_canary_subjects SET status='ABORTED',updated_at=now() WHERE canary_generation=$1 AND status='ACTIVE'`, [activeGeneration]);
    await client.query(`INSERT INTO stage2_rate_pressure_canary_events(event_type,canary_generation,mode,actor,reason,payload) VALUES('ABORT',$1,'OFF',$2,$3,$4)`, [activeGeneration, actor, reason, JSON.stringify({ previousMode: row.mode, nextGeneration })]);
    await client.query('COMMIT');
    return { mode: 'OFF' as const, generation: nextGeneration, aborted: true as const, reason };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function evaluateStage2CanarySubject(subjectKey: string, evidenceSnapshotChecksum: string) {
  if (!subjectKey.trim()) throw new Error('STAGE2_CANARY_SUBJECT_REQUIRED');
  const state = await getStage2CanaryControlState();
  if (state.mode !== 'CANARY') return { assigned: false, mode: 'OFF' as const, reason: 'KILL_SWITCH_OFF', servingAuthority: false as const };
  if (!evidenceSnapshotChecksum.trim()) {
    await abortStage2Canary('REQUIRED_EVIDENCE_SNAPSHOT_MISSING');
    return { assigned: false, mode: 'OFF' as const, reason: 'REQUIRED_EVIDENCE_SNAPSHOT_MISSING', servingAuthority: false as const };
  }

  const assignment = assignAdmissionCanary(`${STAGE2_LIMITED_CANARY_DESIGN_VERSION}:${subjectKey}`, STAGE2_LIMITED_CANARY_POLICY.allocationBasisPoints);
  if (!assignment.assigned) {
    await appendObservation('ALLOCATION_MISS', state.generation, subjectKey, 'CANARY', { randomizationValue: assignment.randomizationValue });
    return { ...assignment, mode: 'CANARY' as const, reason: 'OUTSIDE_ALLOCATION_BUCKET' as const };
  }

  const reservation = await reserveTreatmentSlot(state.generation, subjectKey, evidenceSnapshotChecksum, assignment.randomizationValue);
  if (!reservation.reserved) {
    await appendObservation('CAP_REJECT', state.generation, subjectKey, reservation.mode, { reason: reservation.reason });
    return { ...assignment, assigned: false, mode: reservation.mode, reason: reservation.reason, servingAuthority: false as const };
  }

  await appendObservation('TREATMENT_RESERVED', state.generation, subjectKey, 'CANARY', { treatmentSlot: reservation.treatmentSlot, randomizationValue: assignment.randomizationValue });
  return { ...assignment, mode: 'CANARY' as const, reason: 'TREATMENT_SLOT_RESERVED' as const, treatmentSlot: reservation.treatmentSlot, canaryGeneration: state.generation, servingAuthority: false as const };
}

async function reserveTreatmentSlot(canaryGeneration: number, subjectKey: string, evidenceSnapshotChecksum: string, randomizationValue: number): Promise<{reserved:boolean;mode:Stage2CanaryKillSwitchMode;reason:string;treatmentSlot?:number}> {
  const db = await getDb();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [CONTROL_LOCK]);
    const control = await client.query(`SELECT mode,generation FROM stage2_rate_pressure_canary_control WHERE singleton=TRUE FOR UPDATE`);
    const row = control.rows[0];
    if (!row || row.mode !== 'CANARY' || Number(row.generation) !== canaryGeneration) {
      await client.query('ROLLBACK');
      return { reserved: false, mode: 'OFF', reason: 'KILL_SWITCH_STATE_MISMATCH' };
    }
    const existing = await client.query(`SELECT treatment_slot FROM stage2_rate_pressure_canary_subjects WHERE canary_generation=$1 AND subject_key=$2`, [canaryGeneration, subjectKey]);
    if (existing.rows[0]) {
      await client.query('COMMIT');
      return { reserved: true, mode: 'CANARY', reason: 'ALREADY_RESERVED', treatmentSlot: Number(existing.rows[0].treatment_slot) };
    }
    const slot = await client.query(`SELECT s.slot FROM generate_series(1,$2::int) AS s(slot) LEFT JOIN stage2_rate_pressure_canary_subjects t ON t.canary_generation=$1 AND t.treatment_slot=s.slot WHERE t.treatment_slot IS NULL ORDER BY s.slot LIMIT 1`, [canaryGeneration, STAGE2_LIMITED_CANARY_POLICY.maximumTreatmentSubjects]);
    if (!slot.rows[0]) {
      await client.query('ROLLBACK');
      await abortStage2Canary('TREATMENT_SUBJECT_CAP_EXCEEDED');
      return { reserved: false, mode: 'OFF', reason: 'TREATMENT_SUBJECT_CAP_REACHED' };
    }
    const treatmentSlot = Number(slot.rows[0].slot);
    await client.query(`INSERT INTO stage2_rate_pressure_canary_subjects(canary_generation,subject_key,treatment_slot,allocation_basis_points,randomization_value,evidence_snapshot_checksum) VALUES($1,$2,$3,$4,$5,$6)`, [canaryGeneration, subjectKey, treatmentSlot, STAGE2_LIMITED_CANARY_POLICY.allocationBasisPoints, randomizationValue, evidenceSnapshotChecksum]);
    await client.query('COMMIT');
    return { reserved: true, mode: 'CANARY', reason: 'RESERVED', treatmentSlot };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function appendObservation(eventType: string, canaryGeneration: number | null, subjectKey: string | null, mode: Stage2CanaryKillSwitchMode, payload: Record<string, unknown>) {
  const db = await getDb();
  await db.query(`INSERT INTO stage2_rate_pressure_canary_events(event_type,canary_generation,subject_key,mode,payload) VALUES($1,$2,$3,$4,$5)`, [eventType, canaryGeneration, subjectKey, mode, JSON.stringify(payload)]);
}

export async function recordStage2CanaryHumanOutcome(input: { subjectKey: string; verdict: 'CONFIRMED_NON_TRADING' | 'GENUINE_TRADING_CREATOR'; actor: string; notes?: string }) {
  const state = await getStage2CanaryControlState();
  await appendObservation('HUMAN_OUTCOME', state.generation, input.subjectKey, state.mode, { verdict: input.verdict, actor: input.actor, notes: input.notes ?? null });
  if (state.mode === 'CANARY' && input.verdict === 'GENUINE_TRADING_CREATOR') {
    return abortStage2Canary('ANY_HUMAN_CONFIRMED_TRADING_CREATOR_WITHHELD', input.actor);
  }
  return { recorded: true as const, aborted: false as const };
}
