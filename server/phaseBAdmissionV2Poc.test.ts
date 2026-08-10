import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  evaluatePhaseBAdmissionV2PocVerification,
  PHASE_B_ADMISSION_V2_POC_VERSION,
  type PhaseBAdmissionV2PocVerificationSnapshot
} from './phaseBAdmissionV2Poc';

const passing = (): PhaseBAdmissionV2PocVerificationSnapshot => ({
  datasetFound: true,
  datasetChecksumPresent: true,
  datasetKeyPresent: true,
  totalExamples: 100,
  testExamples: 40,
  calibrationExamples: 60,
  testMissingCreatorFocus: 0,
  testMissingCoverage: 0,
  testMissingCoverageFocusLineage: 0,
  testVersionMismatchedSnapshots: 0,
  offlineReportGenerated: true,
  offlineServingAuthorityFalse: true,
  offlineAutomaticPromotionFalse: true,
  offlineGeneratedFromImmutableHistory: true,
  offlineInputChecksumPresent: true,
  offlineOutputChecksumPresent: true,
  offlineEvaluatedExamples: 40,
  deterministicReplay: true,
  outputChecksumsMatch: true
});

test('Admission V2 PoC verification is ready only when sealed membership, snapshots, and deterministic offline report pass', () => {
  const report = evaluatePhaseBAdmissionV2PocVerification(passing());
  assert.equal(report.ready, true);
  assert.equal(report.servingAuthority, false);
  assert.equal(report.automaticPromotion, false);
  assert.equal(report.version, PHASE_B_ADMISSION_V2_POC_VERSION);
  assert.deepEqual(report.reasonCodes, []);
  assert.ok(report.checks.every(check => check.status === 'PASS'));
});

test('Admission V2 PoC verification fails closed on missing snapshots, authority flags, or non-deterministic replay', () => {
  const snapshot = passing();
  snapshot.datasetFound = false;
  snapshot.datasetChecksumPresent = false;
  snapshot.testExamples = 0;
  snapshot.calibrationExamples = 0;
  snapshot.testMissingCreatorFocus = 3;
  snapshot.testMissingCoverage = 2;
  snapshot.testMissingCoverageFocusLineage = 1;
  snapshot.testVersionMismatchedSnapshots = 4;
  snapshot.offlineServingAuthorityFalse = false;
  snapshot.offlineAutomaticPromotionFalse = false;
  snapshot.offlineGeneratedFromImmutableHistory = false;
  snapshot.offlineInputChecksumPresent = false;
  snapshot.offlineOutputChecksumPresent = false;
  snapshot.offlineEvaluatedExamples = 0;
  snapshot.deterministicReplay = false;
  snapshot.outputChecksumsMatch = false;
  const report = evaluatePhaseBAdmissionV2PocVerification(snapshot);
  assert.equal(report.ready, false);
  for (const code of [
    'DATASET_FOUND',
    'DATASET_CHECKSUM',
    'TEST_SPLIT_PRESENT',
    'CALIBRATION_SPLIT_PRESENT',
    'CREATOR_FOCUS_SNAPSHOTS_COMPLETE',
    'COVERAGE_SNAPSHOTS_COMPLETE',
    'COVERAGE_FOCUS_LINEAGE_COMPLETE',
    'EXACT_VERSION_SNAPSHOTS',
    'OFFLINE_NON_AUTHORITATIVE',
    'OFFLINE_IMMUTABLE_HISTORY',
    'OFFLINE_INPUT_CHECKSUM',
    'OFFLINE_OUTPUT_CHECKSUM',
    'OFFLINE_EVALUATED_EXAMPLES',
    'DETERMINISTIC_REPLAY'
  ]) assert.equal(report.checks.find(check => check.code === code)?.status, 'FAIL', code);
});

test('Admission V2 PoC reuses existing offline evaluator and remains observational', () => {
  const source = readFileSync(new URL('./phaseBAdmissionV2Poc.ts', import.meta.url), 'utf8');
  const pkg = readFileSync('package.json', 'utf8');
  const offlineStore = readFileSync(new URL('./candidateAdmission/offlineV2Store.ts', import.meta.url), 'utf8');
  assert.match(source, /evaluateSealedDatasetOfflineV2/);
  assert.match(source, /BEGIN TRANSACTION READ ONLY/);
  assert.match(source, /servingAuthority: false/);
  assert.match(source, /automaticPromotion: false/);
  assert.match(source, /DETERMINISTIC_REPLAY/);
  assert.match(source, /decision_evaluation_datasets/);
  assert.match(source, /decision_evaluation_examples/);
  assert.match(offlineStore, /evaluateSealedDatasetOfflineV2/);
  assert.match(pkg, /phaseb:admission-v2-poc/);
  assert.match(pkg, /admission:v2-poc/);
  assert.doesNotMatch(source, /db\.query\([`'"]\s*(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP)\b/i);
});
