import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../server/db';
import { evaluateOfflineAdmissionV2, type OfflineAdmissionExample } from '../server/candidateAdmission/offlineV2';
import { applyStage2RatePressureShadowPolicy } from '../server/release5/stage2RatePressureShadowPolicy';
import { evaluateStage2CanarySubject, getStage2CanaryControlState, recordStage2CanaryHumanOutcome } from '../server/release5/stage2CanaryControlPlane';
import { CREATOR_FOCUS_CLASSIFIER_VERSION, CREATOR_FOCUS_POLICY_VERSION } from '../server/evidenceEngine/classifierV4';
import { EVIDENCE_COVERAGE_POLICY_VERSION } from '../server/evidenceEngine/coverage';
import { STAGE2_LIMITED_CANARY_POLICY } from '../server/release5/stage2LimitedCanaryDesign';

const json = <T>(value: T | string | null | undefined, fallback: T): T => {
  if (value === null || value === undefined) return fallback;
  return typeof value === 'string' ? JSON.parse(value) as T : value;
};
const checksum = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export const STAGE2_LIVE_OBSERVATION_VERSION = 'stage2-live-canary-observation-v1';

function asOfflineExample(row: any): OfflineAdmissionExample {
  const decision = json<any>(row.production_decision, {});
  return {
    exampleKey: `live:${row.diagnostic_id}`,
    channelId: String(row.channel_id),
    split: 'TEST',
    // Ground truth is deliberately not inferred here. evaluateOfflineAdmissionV2
    // does not use this field to choose a decision; actual truth only enters via
    // independently recorded human review below.
    groundTruth: 'NON_TRADING',
    inclusionProbability: 1,
    productionStatus: String(decision.status || 'UNCERTAIN'),
    productionScore: Number(decision.confidenceScore || 0),
    segment: { source: 'LIVE_PRODUCTION_DIAGNOSTIC' },
    creatorFocusSnapshotId: String(row.creator_focus_snapshot_id),
    creatorFocusInputChecksum: String(row.creator_focus_input_checksum || ''),
    creatorFocusDistribution: json(row.creator_focus_distribution, {} as any),
    creatorFocusProposedStatus: row.creator_focus_proposed_status,
    creatorFocusProbability: Number(row.creator_focus_probability || 0),
    creatorFocusLowerConfidenceBound: Number(row.lower_confidence_bound || 0),
    creatorFocusReasonCodes: json(row.creator_focus_reason_codes, []),
    creatorFocusStageReport: json(row.creator_focus_stage_report, {}),
    creatorFocusPolicyVersion: String(row.creator_focus_policy_version),
    coverage: {
      snapshotId: String(row.coverage_snapshot_id),
      disposition: row.completeness_disposition,
      observedDocumentCount: Number(row.observed_document_count || 0),
      expectedDocumentCount: Number(row.expected_document_count || 0),
      independentFamilyCount: Number(row.independent_family_count || 0),
      languageCoverage: json(row.language_coverage, {}),
      temporalCoverage: json(row.temporal_coverage, {}),
      providerAvailability: json(row.provider_availability, []),
      acquisitionFailures: json(row.acquisition_failures, []),
      reasonCodes: json(row.coverage_reason_codes, []),
      inputChecksum: String(row.coverage_input_checksum || ''),
      policyVersion: String(row.coverage_policy_version)
    }
  };
}

export function liveDiagnosticIsStage2Eligible(row: any) {
  const base = evaluateOfflineAdmissionV2(asOfflineExample(row));
  const pressured = applyStage2RatePressureShadowPolicy(base);
  return {
    eligible: pressured.ratePressureFallbackApplied === true && pressured.originalDecision === 'DEFER_INVESTIGATION' && pressured.decision === 'WITHHOLD',
    base,
    pressured
  };
}

async function loadUnobservedDiagnostics(generation: number, limit: number) {
  const db = await getDb();
  const result = await db.query(`
    SELECT d.id diagnostic_id,d.channel_id,d.decision production_decision,
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
    FROM production_classification_diagnostics d
    JOIN LATERAL (
      SELECT f.* FROM creator_focus_classification_snapshots f
      WHERE f.classification_diagnostic_id=d.id AND f.classifier_version=$2 AND f.policy_version=$3
      ORDER BY f.observed_at DESC,f.id DESC LIMIT 1
    ) f ON true
    JOIN LATERAL (
      SELECT c.* FROM evidence_coverage_snapshots c
      WHERE c.classification_diagnostic_id=d.id AND c.policy_version=$4
      ORDER BY c.observed_at DESC,c.id DESC LIMIT 1
    ) c ON true
    WHERE NOT EXISTS (
      SELECT 1 FROM stage2_rate_pressure_canary_events e
      WHERE e.canary_generation=$1 AND e.subject_key=d.channel_id
        AND e.event_type IN('ALLOCATION_MISS','CAP_REJECT','TREATMENT_RESERVED')
    )
    ORDER BY d.created_at DESC
    LIMIT $5`, [generation, CREATOR_FOCUS_CLASSIFIER_VERSION, CREATOR_FOCUS_POLICY_VERSION, EVIDENCE_COVERAGE_POLICY_VERSION, limit]);
  return result.rows;
}

async function importHumanOutcomes(generation: number) {
  const db = await getDb();
  const rows = await db.query(`
    SELECT s.subject_key,r.id review_decision_id,r.decision,r.decided_at
    FROM stage2_rate_pressure_canary_subjects s
    JOIN LATERAL (
      SELECT id,decision,decided_at FROM channel_review_decisions r
      WHERE r.channel_id=s.subject_key AND r.decision IN('APPROVE','REJECT')
      ORDER BY r.decided_at DESC,r.id DESC LIMIT 1
    ) r ON true
    WHERE s.canary_generation=$1
      AND NOT EXISTS (
        SELECT 1 FROM stage2_rate_pressure_canary_events e
        WHERE e.canary_generation=$1 AND e.subject_key=s.subject_key AND e.event_type='HUMAN_OUTCOME'
      )
    ORDER BY r.decided_at,s.subject_key`, [generation]);

  let imported = 0;
  for (const row of rows.rows) {
    const verdict = row.decision === 'APPROVE' ? 'GENUINE_TRADING_CREATOR' as const : 'CONFIRMED_NON_TRADING' as const;
    const result = await recordStage2CanaryHumanOutcome({
      subjectKey: String(row.subject_key),
      verdict,
      actor: 'stage2-human-review-import',
      notes: `Imported from channel_review_decisions:${row.review_decision_id}`
    });
    imported++;
    if ('aborted' in result && result.aborted) break;
  }
  return imported;
}

async function buildReport() {
  const db = await getDb();
  const state = await getStage2CanaryControlState();
  const subjects = await db.query(`SELECT COUNT(*)::int total FROM stage2_rate_pressure_canary_subjects WHERE canary_generation=$1`, [state.generation]);
  const outcomes = await db.query(`
    SELECT COUNT(*)::int total,
      COUNT(*) FILTER (WHERE payload->>'verdict'='CONFIRMED_NON_TRADING')::int confirmed_non_trading,
      COUNT(*) FILTER (WHERE payload->>'verdict'='GENUINE_TRADING_CREATOR')::int genuine_creators,
      MIN(created_at) first_outcome_at
    FROM stage2_rate_pressure_canary_events
    WHERE canary_generation=$1 AND event_type='HUMAN_OUTCOME'`, [state.generation]);
  const treatment = await db.query(`SELECT MIN(created_at) first_treatment_at FROM stage2_rate_pressure_canary_events WHERE canary_generation=$1 AND event_type='TREATMENT_RESERVED'`, [state.generation]);
  const aborts = await db.query(`SELECT COUNT(*)::int total FROM stage2_rate_pressure_canary_events WHERE canary_generation=$1 AND event_type='ABORT'`, [state.generation]);
  const treatmentSubjects = Number(subjects.rows[0]?.total || 0);
  const humanOutcomes = Number(outcomes.rows[0]?.total || 0);
  const confirmedNonTrading = Number(outcomes.rows[0]?.confirmed_non_trading || 0);
  const genuineCreators = Number(outcomes.rows[0]?.genuine_creators || 0);
  const firstTreatmentAt = treatment.rows[0]?.first_treatment_at ? new Date(treatment.rows[0].first_treatment_at).toISOString() : null;
  const observationHours = firstTreatmentAt ? (Date.now() - Date.parse(firstTreatmentAt)) / 3_600_000 : 0;
  const precision = humanOutcomes > 0 ? confirmedNonTrading / humanOutcomes : null;
  return {
    reportType: 'STAGE2_LIVE_CANARY_OBSERVATION',
    version: STAGE2_LIVE_OBSERVATION_VERSION,
    generatedAt: new Date().toISOString(),
    state,
    servingAuthority: false,
    productionMutation: false,
    observationClockStartsAtFirstTreatmentReservation: true,
    firstTreatmentAt,
    observationHours,
    treatmentSubjects,
    humanOutcomes,
    confirmedNonTrading,
    confirmedGenuineFalseWithholds: genuineCreators,
    confirmedNonTradingPrecision: precision,
    abortEvents: Number(aborts.rows[0]?.total || 0),
    thresholds: STAGE2_LIMITED_CANARY_POLICY,
    readyForPromotionReview: state.mode === 'CANARY'
      && observationHours >= STAGE2_LIMITED_CANARY_POLICY.minimumObservationWindowHours
      && humanOutcomes >= STAGE2_LIMITED_CANARY_POLICY.minimumHumanAdjudicatedTreatmentOutcomes
      && precision !== null && precision >= STAGE2_LIMITED_CANARY_POLICY.minimumConfirmedNonTradingPrecision
      && genuineCreators === 0,
    automaticPromotion: false,
    nextAction: genuineCreators > 0 || state.mode === 'OFF'
      ? 'CANARY_ABORTED_OR_OFF_REVIEW_SAFETY_EVENT'
      : treatmentSubjects === 0
        ? 'WAIT_FOR_ELIGIBLE_LIVE_PRODUCTION_DIAGNOSTICS'
        : 'CONTINUE_BOUNDED_OBSERVATION_AND_HUMAN_ADJUDICATION'
  };
}

export async function runStage2CanaryLiveObservation() {
  const before = await getStage2CanaryControlState();
  let scanned = 0, eligible = 0, assigned = 0;
  if (before.mode === 'CANARY') {
    const rows = await loadUnobservedDiagnostics(before.generation, 500);
    scanned = rows.length;
    for (const row of rows) {
      const current = await getStage2CanaryControlState();
      if (current.mode !== 'CANARY' || current.generation !== before.generation) break;
      const evaluation = liveDiagnosticIsStage2Eligible(row);
      if (!evaluation.eligible) continue;
      eligible++;
      const evidenceSnapshotChecksum = checksum({
        diagnosticId: row.diagnostic_id,
        creatorFocusSnapshotId: row.creator_focus_snapshot_id,
        creatorFocusInputChecksum: row.creator_focus_input_checksum,
        coverageSnapshotId: row.coverage_snapshot_id,
        coverageInputChecksum: row.coverage_input_checksum,
        creatorFocusPolicyVersion: row.creator_focus_policy_version,
        coveragePolicyVersion: row.coverage_policy_version
      });
      const assignment = await evaluateStage2CanarySubject(String(row.channel_id), evidenceSnapshotChecksum);
      if (assignment.assigned) assigned++;
    }
    await importHumanOutcomes(before.generation);
  }

  const report = { ...(await buildReport()), scan: { scannedDiagnostics: scanned, eligibleCandidates: eligible, newlyAssignedTreatment: assigned } };
  fs.mkdirSync(path.resolve('stage2-output'), { recursive: true });
  fs.writeFileSync(path.resolve('stage2-output/stage2-live-canary-observation.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runStage2CanaryLiveObservation().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
