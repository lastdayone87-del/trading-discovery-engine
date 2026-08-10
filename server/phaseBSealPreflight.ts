import {
  CREATOR_FOCUS_CLASSIFIER_VERSION,
  CREATOR_FOCUS_POLICY_VERSION
} from './evidenceEngine/classifierV4';
import { EVIDENCE_COVERAGE_POLICY_VERSION } from './evidenceEngine/coverage';
import { EVIDENCE_DUAL_WRITE_VERSION } from './evidenceEngine/dualWrite';
import {
  inspectActivePhaseBCollectionEpoch,
  inspectPhaseBBundleAvailability,
  PHASE_B_DEFAULT_MINIMUM_BUNDLE_AVAILABILITY_BPS,
  fingerprintSamplingSalt
} from './phaseBCollectionEpoch';
import { inspectPhaseBHistoryReadiness } from './phaseBHistoryReadiness';
import {
  inspectPhaseBProspectiveMonitoring,
  PHASE_B_MINIMUM_CLASS_ESS,
  PHASE_B_MINIMUM_EVIDENCE_ELIGIBILITY_BPS,
  type PhaseBProspectiveMonitoringReport
} from './phaseBProspectiveMonitoring';
import { PHASE_B_SHADOW_POLICY_VERSION } from './phaseBShadow';
import type { DatasetDefinition } from './decisionEvaluation';
import { buildPhaseBBenchmarks } from './phaseBBenchmark';

export const PHASE_B_SEAL_PREFLIGHT_VERSION = 'phase-b-seal-preflight-v1';

export interface PhaseBVersionPins {
  samplingPolicyKey: string;
  samplingPolicyVersion: number;
  samplingSaltFingerprint: string;
  coveragePolicyVersion: string;
  creatorFocusPolicyVersion: string;
  classifierVersion: string;
  shadowPolicyVersion: string;
  dualWriteVersion: string;
}

export interface PhaseBSealPreflightSnapshot {
  epochDeclared: boolean;
  epochStartedAt?: string;
  epochPins?: PhaseBVersionPins;
  currentPins: PhaseBVersionPins;
  versionPinsMatch: boolean;
  saltFingerprintConfigured: boolean;
  historyReadinessReady: boolean;
  historyFailCodes: string[];
  prospectiveMonitoringReady: boolean;
  prospectiveReasonCodes: string[];
  projectedEssGenuine: number;
  projectedEssBaselineFalsePositive: number;
  evidenceEligibilityBasisPoints: number;
  joinCompletenessBasisPoints: number;
  bundleAvailabilityReady: boolean;
  bundleAvailabilityBasisPoints: number;
  datasetWindowValid: boolean;
  epochCoversDatasetWindow: boolean;
  datasetKeyPresent: boolean;
}

export interface PhaseBSealPreflightCheck {
  code: string;
  status: 'PASS' | 'FAIL';
  detail: string;
}

export interface PhaseBSealPreflightReport {
  version: string;
  ready: boolean;
  sealingPermitted: boolean;
  servingAuthority: false;
  automaticPromotion: false;
  windowStart: string;
  cutoffAt: string;
  checks: PhaseBSealPreflightCheck[];
  reasonCodes: string[];
  currentPins: PhaseBVersionPins;
  epochPins?: PhaseBVersionPins;
  prospective?: Pick<
    PhaseBProspectiveMonitoringReport,
    'ready' | 'metrics' | 'reasonCodes' | 'minimumClassEss' | 'minimumEvidenceEligibilityBasisPoints'
  >;
}

export function currentPhaseBVersionPins(saltFingerprint?: string): PhaseBVersionPins {
  return {
    samplingPolicyKey: 'protected-audit',
    samplingPolicyVersion: 1,
    samplingSaltFingerprint: saltFingerprint ?? fingerprintSamplingSalt(process.env.DECISION_EVALUATION_SAMPLING_SALT),
    coveragePolicyVersion: EVIDENCE_COVERAGE_POLICY_VERSION,
    creatorFocusPolicyVersion: CREATOR_FOCUS_POLICY_VERSION,
    classifierVersion: CREATOR_FOCUS_CLASSIFIER_VERSION,
    shadowPolicyVersion: PHASE_B_SHADOW_POLICY_VERSION,
    dualWriteVersion: EVIDENCE_DUAL_WRITE_VERSION
  };
}

export function validateDatasetWindow(definition: Pick<DatasetDefinition, 'calibrationFrom' | 'testFrom' | 'cutoffAt'>): boolean {
  const calibration = new Date(definition.calibrationFrom);
  const test = new Date(definition.testFrom);
  const cutoff = new Date(definition.cutoffAt);
  if ([calibration, test, cutoff].some(value => !Number.isFinite(value.getTime()))) return false;
  return calibration < test && test <= cutoff;
}

export function versionPinsEqual(left: PhaseBVersionPins, right: PhaseBVersionPins): boolean {
  return (
    left.samplingPolicyKey === right.samplingPolicyKey &&
    left.samplingPolicyVersion === right.samplingPolicyVersion &&
    left.samplingSaltFingerprint === right.samplingSaltFingerprint &&
    left.coveragePolicyVersion === right.coveragePolicyVersion &&
    left.creatorFocusPolicyVersion === right.creatorFocusPolicyVersion &&
    left.classifierVersion === right.classifierVersion &&
    left.shadowPolicyVersion === right.shadowPolicyVersion &&
    left.dualWriteVersion === right.dualWriteVersion
  );
}

export function evaluatePhaseBSealPreflight(snapshot: PhaseBSealPreflightSnapshot): PhaseBSealPreflightReport {
  const checks: PhaseBSealPreflightCheck[] = [];
  const check = (code: string, passes: boolean, detail: string) =>
    checks.push({ code, status: passes ? 'PASS' : 'FAIL', detail });

  check('COLLECTION_EPOCH_DECLARED', snapshot.epochDeclared, 'An active pinned collection epoch must be declared.');
  check('VERSION_PINS_CONSISTENT', snapshot.versionPinsMatch, 'Classifier, policy, coverage, dual-write, shadow, and sampling pins must match the epoch.');
  check('SAMPLING_SALT_PINNED', snapshot.saltFingerprintConfigured, 'Sampling salt fingerprint must be non-empty and pinned.');
  check('HISTORY_READINESS', snapshot.historyReadinessReady, snapshot.historyFailCodes.length
    ? `History readiness failed: ${snapshot.historyFailCodes.join(',')}`
    : 'Phase B history readiness is satisfied.');
  check('PROSPECTIVE_MONITORING', snapshot.prospectiveMonitoringReady, snapshot.prospectiveReasonCodes.length
    ? `Prospective monitoring failed: ${snapshot.prospectiveReasonCodes.join(',')}`
    : 'Projected ESS, join completeness, and segments meet seal floors.');
  check(
    'GENUINE_ESS_FLOOR',
    snapshot.projectedEssGenuine >= PHASE_B_MINIMUM_CLASS_ESS,
    `Genuine ESS ${snapshot.projectedEssGenuine} must be at least ${PHASE_B_MINIMUM_CLASS_ESS}.`
  );
  check(
    'BASELINE_FALSE_POSITIVE_ESS_FLOOR',
    snapshot.projectedEssBaselineFalsePositive >= PHASE_B_MINIMUM_CLASS_ESS,
    `Baseline false-positive ESS ${snapshot.projectedEssBaselineFalsePositive} must be at least ${PHASE_B_MINIMUM_CLASS_ESS}.`
  );
  check(
    'EVIDENCE_ELIGIBILITY_FLOOR',
    snapshot.evidenceEligibilityBasisPoints >= PHASE_B_MINIMUM_EVIDENCE_ELIGIBILITY_BPS,
    `Evidence eligibility ${snapshot.evidenceEligibilityBasisPoints} bps must be at least ${PHASE_B_MINIMUM_EVIDENCE_ELIGIBILITY_BPS}.`
  );
  check(
    'JOIN_COMPLETENESS_FLOOR',
    snapshot.joinCompletenessBasisPoints >= PHASE_B_MINIMUM_EVIDENCE_ELIGIBILITY_BPS,
    `Join completeness ${snapshot.joinCompletenessBasisPoints} bps must be at least ${PHASE_B_MINIMUM_EVIDENCE_ELIGIBILITY_BPS}.`
  );
  check(
    'BUNDLE_AVAILABILITY_FLOOR',
    snapshot.bundleAvailabilityReady,
    `Exact-version coverage/focus availability must meet the ${PHASE_B_DEFAULT_MINIMUM_BUNDLE_AVAILABILITY_BPS} bps floor.`
  );
  check('DATASET_WINDOW_VALID', snapshot.datasetWindowValid, 'Dataset splits must satisfy calibrationFrom < testFrom <= cutoffAt.');
  check('EPOCH_COVERS_DATASET', snapshot.epochCoversDatasetWindow, 'Dataset cutoff must fall after the collection epoch start.');
  check('DATASET_KEY_PRESENT', snapshot.datasetKeyPresent, 'A unique dataset key is required before sealing.');

  const reasonCodes = checks.filter(item => item.status === 'FAIL').map(item => item.code);
  const ready = reasonCodes.length === 0;
  return {
    version: PHASE_B_SEAL_PREFLIGHT_VERSION,
    ready,
    sealingPermitted: ready,
    servingAuthority: false,
    automaticPromotion: false,
    windowStart: snapshot.epochStartedAt || '',
    cutoffAt: '',
    checks,
    reasonCodes,
    currentPins: snapshot.currentPins,
    epochPins: snapshot.epochPins
  };
}

export async function inspectPhaseBSealPreflight(input: {
  definition: DatasetDefinition;
  windowStart?: string;
  minimumClassEss?: number;
  minimumEvidenceEligibilityBasisPoints?: number;
}): Promise<PhaseBSealPreflightReport> {
  if (!input.definition?.datasetKey?.trim()) {
    throw new Error('DATASET_KEY_REQUIRED');
  }
  if (!validateDatasetWindow(input.definition)) {
    throw new Error('INVALID_DATASET_WINDOW');
  }

  const epoch = await inspectActivePhaseBCollectionEpoch();
  const windowStart =
    input.windowStart ||
    (epoch.epoch?.startedAt ? new Date(String(epoch.epoch.startedAt)).toISOString() : undefined);
  if (!windowStart) throw new Error('PHASE_B_WINDOW_START_OR_COLLECTION_EPOCH_REQUIRED');

  const cutoffAt = input.definition.cutoffAt;
  const currentPins = currentPhaseBVersionPins();
  const epochPins: PhaseBVersionPins | undefined = epoch.epoch
    ? {
        samplingPolicyKey: String(epoch.epoch.samplingPolicyKey),
        samplingPolicyVersion: Number(epoch.epoch.samplingPolicyVersion),
        samplingSaltFingerprint: String(epoch.epoch.samplingSaltFingerprint),
        coveragePolicyVersion: String(epoch.epoch.coveragePolicyVersion),
        creatorFocusPolicyVersion: String(epoch.epoch.creatorFocusPolicyVersion),
        classifierVersion: String(epoch.epoch.classifierVersion),
        shadowPolicyVersion: String(epoch.epoch.shadowPolicyVersion),
        dualWriteVersion: String(epoch.epoch.dualWriteVersion)
      }
    : undefined;

  const [history, prospective, bundle] = await Promise.all([
    inspectPhaseBHistoryReadiness(),
    inspectPhaseBProspectiveMonitoring({
      windowStart,
      cutoffAt,
      minimumClassEss: input.minimumClassEss,
      minimumEvidenceEligibilityBasisPoints: input.minimumEvidenceEligibilityBasisPoints
    }),
    inspectPhaseBBundleAvailability({
      windowStart,
      cutoffAt,
      minimumAvailabilityBasisPoints: PHASE_B_DEFAULT_MINIMUM_BUNDLE_AVAILABILITY_BPS
    })
  ]);

  const epochStartMs = epoch.epoch?.startedAt ? new Date(String(epoch.epoch.startedAt)).getTime() : NaN;
  const cutoffMs = new Date(cutoffAt).getTime();
  const epochCoversDatasetWindow = Number.isFinite(epochStartMs) && Number.isFinite(cutoffMs) && epochStartMs < cutoffMs;

  const snapshot: PhaseBSealPreflightSnapshot = {
    epochDeclared: epoch.declared,
    epochStartedAt: epoch.epoch?.startedAt ? String(epoch.epoch.startedAt) : undefined,
    epochPins,
    currentPins,
    versionPinsMatch: !!epochPins && versionPinsEqual(currentPins, epochPins),
    saltFingerprintConfigured: !!currentPins.samplingSaltFingerprint,
    historyReadinessReady: history.ready,
    historyFailCodes: history.checks.filter(check => check.status === 'FAIL').map(check => check.code),
    prospectiveMonitoringReady: prospective.ready,
    prospectiveReasonCodes: prospective.reasonCodes,
    projectedEssGenuine: prospective.metrics.projectedEssGenuine,
    projectedEssBaselineFalsePositive: prospective.metrics.projectedEssBaselineFalsePositive,
    evidenceEligibilityBasisPoints: prospective.metrics.evidenceEligibilityBasisPoints,
    joinCompletenessBasisPoints: prospective.metrics.joinCompletenessBasisPoints,
    bundleAvailabilityReady: bundle.ready,
    bundleAvailabilityBasisPoints: bundle.metrics.availabilityBasisPoints,
    datasetWindowValid: validateDatasetWindow(input.definition),
    epochCoversDatasetWindow,
    datasetKeyPresent: !!input.definition.datasetKey.trim()
  };

  const report = evaluatePhaseBSealPreflight(snapshot);
  report.windowStart = windowStart;
  report.cutoffAt = cutoffAt;
  report.prospective = {
    ready: prospective.ready,
    metrics: prospective.metrics,
    reasonCodes: prospective.reasonCodes,
    minimumClassEss: prospective.minimumClassEss,
    minimumEvidenceEligibilityBasisPoints: prospective.minimumEvidenceEligibilityBasisPoints
  };
  return report;
}

/**
 * Fail-closed gate in front of the existing Phase B sealer.
 * Does not duplicate the decision-evaluation sealer; only gates then delegates to buildPhaseBBenchmarks.
 */
export async function sealPhaseBBenchmarksAfterPreflight(input: {
  definition: DatasetDefinition;
  actor: string;
  minimumEffectiveSampleSize?: number;
  windowStart?: string;
}): Promise<{
  preflight: PhaseBSealPreflightReport;
  sealed: Awaited<ReturnType<typeof buildPhaseBBenchmarks>>;
}> {
  const preflight = await inspectPhaseBSealPreflight({
    definition: input.definition,
    windowStart: input.windowStart,
    minimumClassEss: input.minimumEffectiveSampleSize
  });
  if (!preflight.sealingPermitted) {
    throw new Error(`PHASE_B_SEAL_PREFLIGHT_FAILED:${preflight.reasonCodes.join(',')}`);
  }
  const sealed = await buildPhaseBBenchmarks({
    definition: input.definition,
    actor: input.actor,
    minimumEffectiveSampleSize: input.minimumEffectiveSampleSize
  });
  return { preflight, sealed };
}
