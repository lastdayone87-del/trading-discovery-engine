import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  currentPhaseBVersionPins,
  evaluatePhaseBSealPreflight,
  PHASE_B_SEAL_PREFLIGHT_VERSION,
  validateDatasetWindow,
  versionPinsEqual,
  type PhaseBSealPreflightSnapshot,
  type PhaseBVersionPins
} from './phaseBSealPreflight';
import { PHASE_B_MINIMUM_CLASS_ESS, PHASE_B_MINIMUM_EVIDENCE_ELIGIBILITY_BPS } from './phaseBProspectiveMonitoring';

const pins = (overrides: Partial<PhaseBVersionPins> = {}): PhaseBVersionPins => ({
  samplingPolicyKey: 'protected-audit',
  samplingPolicyVersion: 1,
  samplingSaltFingerprint: 'salt-fingerprint',
  coveragePolicyVersion: 'evidence-coverage-policy-v1',
  creatorFocusPolicyVersion: 'creator-focus-policy-v4-draft-1',
  classifierVersion: 'creator-focus-classifier-v4-shadow-1',
  shadowPolicyVersion: 'phase-b-shadow-v1',
  dualWriteVersion: 'evidence-dual-write-v1',
  ...overrides
});

const passingSnapshot = (): PhaseBSealPreflightSnapshot => ({
  epochDeclared: true,
  epochStartedAt: '2026-08-01T00:00:00.000Z',
  epochPins: pins(),
  currentPins: pins(),
  versionPinsMatch: true,
  saltFingerprintConfigured: true,
  historyReadinessReady: true,
  historyFailCodes: [],
  prospectiveMonitoringReady: true,
  prospectiveReasonCodes: [],
  projectedEssGenuine: PHASE_B_MINIMUM_CLASS_ESS,
  projectedEssBaselineFalsePositive: PHASE_B_MINIMUM_CLASS_ESS,
  evidenceEligibilityBasisPoints: PHASE_B_MINIMUM_EVIDENCE_ELIGIBILITY_BPS,
  joinCompletenessBasisPoints: PHASE_B_MINIMUM_EVIDENCE_ELIGIBILITY_BPS,
  bundleAvailabilityReady: true,
  bundleAvailabilityBasisPoints: 9000,
  datasetWindowValid: true,
  epochCoversDatasetWindow: true,
  datasetKeyPresent: true
});

test('seal preflight permits sealing only when epoch, versions, ESS, and completeness floors pass', () => {
  const report = evaluatePhaseBSealPreflight(passingSnapshot());
  assert.equal(report.ready, true);
  assert.equal(report.sealingPermitted, true);
  assert.equal(report.servingAuthority, false);
  assert.equal(report.automaticPromotion, false);
  assert.equal(report.version, PHASE_B_SEAL_PREFLIGHT_VERSION);
  assert.deepEqual(report.reasonCodes, []);
  assert.ok(report.checks.every(check => check.status === 'PASS'));
});

test('seal preflight fails closed on version drift, missing epoch, or sample insufficiency', () => {
  const snapshot = passingSnapshot();
  snapshot.epochDeclared = false;
  snapshot.versionPinsMatch = false;
  snapshot.saltFingerprintConfigured = false;
  snapshot.historyReadinessReady = false;
  snapshot.historyFailCodes = ['CREATOR_FOCUS_SHADOW_ONLY'];
  snapshot.prospectiveMonitoringReady = false;
  snapshot.prospectiveReasonCodes = ['GENUINE_ESS_BELOW_FLOOR'];
  snapshot.projectedEssGenuine = 10;
  snapshot.projectedEssBaselineFalsePositive = 10;
  snapshot.evidenceEligibilityBasisPoints = 5000;
  snapshot.joinCompletenessBasisPoints = 5000;
  snapshot.bundleAvailabilityReady = false;
  snapshot.datasetWindowValid = false;
  snapshot.epochCoversDatasetWindow = false;
  snapshot.datasetKeyPresent = false;
  const report = evaluatePhaseBSealPreflight(snapshot);
  assert.equal(report.sealingPermitted, false);
  for (const code of [
    'COLLECTION_EPOCH_DECLARED',
    'VERSION_PINS_CONSISTENT',
    'SAMPLING_SALT_PINNED',
    'HISTORY_READINESS',
    'PROSPECTIVE_MONITORING',
    'GENUINE_ESS_FLOOR',
    'BASELINE_FALSE_POSITIVE_ESS_FLOOR',
    'EVIDENCE_ELIGIBILITY_FLOOR',
    'JOIN_COMPLETENESS_FLOOR',
    'BUNDLE_AVAILABILITY_FLOOR',
    'DATASET_WINDOW_VALID',
    'EPOCH_COVERS_DATASET',
    'DATASET_KEY_PRESENT'
  ]) assert.equal(report.checks.find(check => check.code === code)?.status, 'FAIL', code);
});

test('dataset window validation and version pin equality are deterministic', () => {
  assert.equal(
    validateDatasetWindow({
      calibrationFrom: '2026-08-01T00:00:00.000Z',
      testFrom: '2026-08-10T00:00:00.000Z',
      cutoffAt: '2026-08-15T00:00:00.000Z'
    }),
    true
  );
  assert.equal(
    validateDatasetWindow({
      calibrationFrom: '2026-08-10T00:00:00.000Z',
      testFrom: '2026-08-01T00:00:00.000Z',
      cutoffAt: '2026-08-15T00:00:00.000Z'
    }),
    false
  );
  assert.equal(versionPinsEqual(pins(), pins()), true);
  assert.equal(versionPinsEqual(pins(), pins({ classifierVersion: 'other' })), false);
  const current = currentPhaseBVersionPins('abc');
  assert.equal(current.samplingSaltFingerprint, 'abc');
  assert.match(current.classifierVersion, /creator-focus-classifier/);
});

test('seal preflight reuses existing Phase B surfaces and does not replace the sealer', () => {
  const source = readFileSync(new URL('./phaseBSealPreflight.ts', import.meta.url), 'utf8');
  const sealScript = readFileSync('scripts/phaseBSealBenchmark.ts', 'utf8');
  const pkg = readFileSync('package.json', 'utf8');
  const benchmark = readFileSync(new URL('./phaseBBenchmark.ts', import.meta.url), 'utf8');
  assert.match(source, /inspectPhaseBProspectiveMonitoring/);
  assert.match(source, /inspectPhaseBHistoryReadiness/);
  assert.match(source, /inspectActivePhaseBCollectionEpoch/);
  assert.match(source, /inspectPhaseBBundleAvailability/);
  assert.match(source, /buildPhaseBBenchmarks/);
  assert.match(source, /sealingPermitted/);
  assert.match(source, /servingAuthority: false/);
  assert.match(source, /automaticPromotion: false/);
  assert.match(source, /buildPhaseBBenchmarks/);
  assert.match(benchmark, /sealEvaluationDataset/);
  assert.match(benchmark, /servingAuthority:false/);
  assert.match(sealScript, /sealPhaseBBenchmarksAfterPreflight|inspectPhaseBSealPreflight/);
  assert.match(pkg, /phaseb:seal-preflight/);
  assert.match(pkg, /phaseb:seal-benchmark/);
});
