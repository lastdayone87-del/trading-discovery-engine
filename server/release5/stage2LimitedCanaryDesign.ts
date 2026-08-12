import { createHash } from 'node:crypto';
import { assignAdmissionCanary } from '../candidateAdmission/policy';
import { runStage2GuardedPromotionGate } from './stage2GuardedPromotionGate';

export const STAGE2_LIMITED_CANARY_DESIGN_VERSION = 'stage2-limited-canary-design-v1';

export const STAGE2_LIMITED_CANARY_POLICY = Object.freeze({
  allocationBasisPoints: 500,
  maximumTreatmentSubjects: 50,
  minimumObservationWindowHours: 72,
  minimumHumanAdjudicatedTreatmentOutcomes: 20,
  minimumConfirmedNonTradingPrecision: 0.90,
  requiredGenuineCreatorRecall: 1,
  maximumConfirmedGenuineFalseWithholds: 0
});

export type Stage2CanaryKillSwitchMode = 'OFF' | 'CANARY';
export type Stage2TreatmentSlotReservation = (
  subjectKey: string,
  maximumTreatmentSubjects: number
) => boolean | Promise<boolean>;

const checksum = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function assignStage2LimitedCanary(
  subjectKey: string,
  killSwitchMode: Stage2CanaryKillSwitchMode,
  reserveTreatmentSlot?: Stage2TreatmentSlotReservation
) {
  if (killSwitchMode !== 'CANARY') {
    return {
      assigned: false,
      mode: 'OFF' as const,
      basisPoints: 0,
      randomizationValue: null,
      servingAuthority: false as const,
      reason: 'KILL_SWITCH_OFF' as const
    };
  }

  const assignment = assignAdmissionCanary(
    `${STAGE2_LIMITED_CANARY_DESIGN_VERSION}:${subjectKey}`,
    STAGE2_LIMITED_CANARY_POLICY.allocationBasisPoints
  );

  if (!assignment.assigned) {
    return { ...assignment, mode: 'CANARY' as const, reason: 'OUTSIDE_ALLOCATION_BUCKET' as const };
  }

  // A bucket hit is not sufficient to enter treatment. The activation control
  // plane must atomically reserve one of the bounded treatment slots first.
  // Failing closed here prevents a caller from bypassing the hard cap.
  if (!reserveTreatmentSlot) {
    return {
      ...assignment,
      assigned: false,
      mode: 'CANARY' as const,
      reason: 'ATOMIC_TREATMENT_SLOT_RESERVATION_REQUIRED' as const
    };
  }

  const reserved = await reserveTreatmentSlot(
    subjectKey,
    STAGE2_LIMITED_CANARY_POLICY.maximumTreatmentSubjects
  );

  if (!reserved) {
    return {
      ...assignment,
      assigned: false,
      mode: 'CANARY' as const,
      reason: 'TREATMENT_SUBJECT_CAP_REACHED' as const
    };
  }

  return { ...assignment, mode: 'CANARY' as const, reason: 'TREATMENT_SLOT_RESERVED' as const };
}

export function buildStage2LimitedCanaryDesign(gate: any) {
  if (gate?.gateStatus !== 'READY_FOR_LIMITED_CANARY_DESIGN') {
    return {
      reportType: 'STAGE2_LIMITED_CANARY_DESIGN',
      version: STAGE2_LIMITED_CANARY_DESIGN_VERSION,
      designStatus: 'BLOCKED',
      blockers: ['GUARDED_PROMOTION_GATE_NOT_READY'],
      servingAuthority: false,
      automaticPromotion: false,
      mutatesOperationalState: false,
      productionActivation: false,
      nextAction: 'REPAIR_GUARDED_PROMOTION_GATE'
    };
  }

  const plan = {
    reportType: 'STAGE2_LIMITED_CANARY_DESIGN',
    version: STAGE2_LIMITED_CANARY_DESIGN_VERSION,
    designStatus: 'READY_FOR_EXPLICIT_ACTIVATION_IMPLEMENTATION',
    sourceDatasetId: gate.datasetId,
    sourceGateVersion: gate.version,
    sourceGateChecksum: gate.outputChecksum,
    servingAuthority: false,
    automaticPromotion: false,
    mutatesOperationalState: false,
    productionActivation: false,
    allocation: {
      basisPoints: STAGE2_LIMITED_CANARY_POLICY.allocationBasisPoints,
      percent: STAGE2_LIMITED_CANARY_POLICY.allocationBasisPoints / 100,
      deterministicAssignment: true,
      maximumTreatmentSubjects: STAGE2_LIMITED_CANARY_POLICY.maximumTreatmentSubjects,
      hardCapEnforcement: 'ATOMIC_SLOT_RESERVATION_REQUIRED'
    },
    candidateEligibility: {
      originalDecision: 'DEFER_INVESTIGATION',
      semanticProviderDegraded: true,
      evidenceCoverageDisposition: 'SUFFICIENT',
      minimumObservedDocuments: 10,
      minimumIndependentSourceFamilies: 3,
      supportedLanguageRequired: true,
      recentEvidenceRequired: true,
      maximumTradingMassExclusive: 0.05,
      candidateAction: 'WITHHOLD'
    },
    killSwitch: {
      settingKey: 'stage2_rate_pressure_canary_mode',
      defaultMode: 'OFF',
      enabledMode: 'CANARY',
      manualEnableRequired: true,
      automaticEnableForbidden: true,
      immediateAbortTriggers: [
        'ANY_HUMAN_CONFIRMED_TRADING_CREATOR_WITHHELD',
        'ANY_CANARY_INVARIANT_OR_PROJECTION_MISMATCH',
        'TREATMENT_SUBJECT_CAP_EXCEEDED',
        'KILL_SWITCH_STATE_MISMATCH',
        'REQUIRED_EVIDENCE_SNAPSHOT_MISSING'
      ]
    },
    observation: {
      minimumWindowHours: STAGE2_LIMITED_CANARY_POLICY.minimumObservationWindowHours,
      minimumHumanAdjudicatedTreatmentOutcomes: STAGE2_LIMITED_CANARY_POLICY.minimumHumanAdjudicatedTreatmentOutcomes,
      requiredMetrics: [
        'treatment_subjects',
        'human_adjudicated_treatment_outcomes',
        'confirmed_non_trading_precision',
        'confirmed_genuine_false_withholds',
        'genuine_creator_recall',
        'provider_degradation_rate',
        'kill_switch_events'
      ]
    },
    promotionCriteria: {
      minimumConfirmedNonTradingPrecision: STAGE2_LIMITED_CANARY_POLICY.minimumConfirmedNonTradingPrecision,
      requiredGenuineCreatorRecall: STAGE2_LIMITED_CANARY_POLICY.requiredGenuineCreatorRecall,
      maximumConfirmedGenuineFalseWithholds: STAGE2_LIMITED_CANARY_POLICY.maximumConfirmedGenuineFalseWithholds,
      automaticRampForbidden: true,
      globalActivationForbidden: true
    },
    rollback: {
      action: 'SET_STAGE2_RATE_PRESSURE_CANARY_MODE_OFF',
      immediate: true,
      preservesObservationalHistory: true
    },
    nextAction: 'IMPLEMENT_EXPLICIT_CANARY_ACTIVATION_CONTROL_PLANE'
  };

  return { ...plan, outputChecksum: checksum(plan) };
}

export async function runStage2LimitedCanaryDesign(requestedDatasetId?: string) {
  const gate = await runStage2GuardedPromotionGate(requestedDatasetId);
  return buildStage2LimitedCanaryDesign(gate);
}
