import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildPhaseBBundleAvailabilityReport,
  collectionEpochKey,
  evaluatePhaseBCollectionEpochGate,
  fingerprintSamplingSalt,
  PHASE_B_COLLECTION_EPOCH_VERSION,
  PHASE_B_DEFAULT_MINIMUM_BUNDLE_AVAILABILITY_BPS,
  type PhaseBCollectionEpochGateSnapshot
} from './phaseBCollectionEpoch';

const passingGate = (): PhaseBCollectionEpochGateSnapshot => ({
  validationStatus: 'PASS',
  validationRunId: '11111111-1111-4111-8111-111111111111',
  assertionsEnabled: true,
  assertionActivationHasPassingValidation: true,
  documentsEnabled: true,
  samplingEnabled: true,
  creatorFocusMode: 'SHADOW',
  creatorFocusCanaryBasisPoints: 0,
  gapSpecificMode: 'OFF',
  advisoryMode: 'OFF',
  protectedAuditPolicyApproved: true,
  samplingSaltFingerprint: fingerprintSamplingSalt('pinned-salt'),
  invalidCreatorFocusEffectiveStatusCount: 0
});

test('collection epoch gate passes only when assertions are PASS-governed and authority stays observational', () => {
  const report = evaluatePhaseBCollectionEpochGate(passingGate());
  assert.equal(report.ready, true);
  assert.equal(report.servingAuthority, false);
  assert.equal(report.automaticPromotion, false);
  assert.equal(report.version, PHASE_B_COLLECTION_EPOCH_VERSION);
  assert.ok(report.checks.every(check => check.status === 'PASS'));
});

test('collection epoch gate fails closed without PASS validation, assertions, or non-shadow focus', () => {
  const snapshot = passingGate();
  snapshot.validationStatus = 'FAIL';
  snapshot.assertionsEnabled = false;
  snapshot.assertionActivationHasPassingValidation = false;
  snapshot.creatorFocusMode = 'CANARY';
  snapshot.creatorFocusCanaryBasisPoints = 250;
  snapshot.gapSpecificMode = 'SHADOW';
  snapshot.advisoryMode = 'CANARY';
  snapshot.samplingSaltFingerprint = '';
  snapshot.invalidCreatorFocusEffectiveStatusCount = 2;
  const report = evaluatePhaseBCollectionEpochGate(snapshot);
  assert.equal(report.ready, false);
  for (const code of [
    'PASSING_DOCUMENT_VALIDATION',
    'ASSERTIONS_ENABLED',
    'ASSERTION_ACTIVATION_GOVERNED',
    'CREATOR_FOCUS_SHADOW_ONLY',
    'CREATOR_FOCUS_CANARY_DISABLED',
    'INVESTIGATION_AUTHORITY_DISABLED',
    'ADVISORY_AUTHORITY_DISABLED',
    'SAMPLING_SALT_PINNED',
    'EFFECTIVE_STATUS_NON_AUTHORITATIVE'
  ]) assert.equal(report.checks.find(check => check.code === code)?.status, 'FAIL', code);
});

test('epoch keys are deterministic and salt fingerprints never embed the raw salt', () => {
  const left = collectionEpochKey({
    validationRunId: '11111111-1111-4111-8111-111111111111',
    startedAt: '2026-08-10T00:00:00.000Z',
    samplingPolicyKey: 'protected-audit',
    samplingPolicyVersion: 1,
    samplingSaltFingerprint: fingerprintSamplingSalt('pinned-salt'),
    coveragePolicyVersion: 'evidence-coverage-policy-v1',
    creatorFocusPolicyVersion: 'creator-focus-policy-v4-draft-1',
    classifierVersion: 'creator-focus-classifier-v4-shadow-1'
  });
  const right = collectionEpochKey({
    validationRunId: '11111111-1111-4111-8111-111111111111',
    startedAt: '2026-08-10T00:00:00.000Z',
    samplingPolicyKey: 'protected-audit',
    samplingPolicyVersion: 1,
    samplingSaltFingerprint: fingerprintSamplingSalt('pinned-salt'),
    coveragePolicyVersion: 'evidence-coverage-policy-v1',
    creatorFocusPolicyVersion: 'creator-focus-policy-v4-draft-1',
    classifierVersion: 'creator-focus-classifier-v4-shadow-1'
  });
  assert.equal(left, right);
  assert.match(left, /^phase-b:epoch:/);
  assert.equal(fingerprintSamplingSalt(''), '');
  assert.notEqual(fingerprintSamplingSalt('pinned-salt'), 'pinned-salt');
  assert.doesNotMatch(fingerprintSamplingSalt('pinned-salt'), /pinned-salt/);
});

test('bundle availability requires the 90 percent complete-bundle floor by default', () => {
  const below = buildPhaseBBundleAvailabilityReport({
    windowStart: '2026-08-01T00:00:00.000Z',
    cutoffAt: '2026-08-10T00:00:00.000Z',
    metrics: {
      diagnostics: 100,
      withCoverage: 95,
      withCreatorFocus: 95,
      withCoverageFocusLineage: 95,
      completeBundles: 89
    }
  });
  assert.equal(below.ready, false);
  assert.equal(below.servingAuthority, false);
  assert.equal(below.minimumAvailabilityBasisPoints, PHASE_B_DEFAULT_MINIMUM_BUNDLE_AVAILABILITY_BPS);
  assert.ok(below.reasonCodes.includes('BUNDLE_AVAILABILITY_BELOW_FLOOR'));
  assert.equal(below.metrics.availabilityBasisPoints, 8900);

  const ready = buildPhaseBBundleAvailabilityReport({
    windowStart: '2026-08-01T00:00:00.000Z',
    cutoffAt: '2026-08-10T00:00:00.000Z',
    metrics: {
      diagnostics: 100,
      withCoverage: 100,
      withCreatorFocus: 100,
      withCoverageFocusLineage: 100,
      completeBundles: 90
    }
  });
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.reasonCodes, []);
  assert.equal(ready.metrics.availabilityBasisPoints, 9000);
});

test('collection epoch remains observational and is pinned by migration 083', () => {
  const migration = readFileSync('server/db/migrations/083_phase_b_collection_epochs.sql', 'utf8');
  const source = readFileSync(new URL('./phaseBCollectionEpoch.ts', import.meta.url), 'utf8');
  const readiness = readFileSync(new URL('./phaseBHistoryReadiness.ts', import.meta.url), 'utf8');
  const pkg = readFileSync('package.json', 'utf8');
  assert.match(migration, /phase_b_collection_epochs/);
  assert.match(migration, /serving_authority BOOLEAN NOT NULL DEFAULT false CHECK\(serving_authority = false\)/);
  assert.match(migration, /COLLECTION_EPOCH/);
  assert.match(migration, /phase_b_collection_epochs_immutable/);
  assert.match(source, /servingAuthority: false/);
  assert.match(source, /automaticPromotion: false/);
  assert.match(source, /PASSING_DOCUMENT_VALIDATION/);
  assert.match(source, /ASSERTION_ACTIVATION_GOVERNED/);
  assert.match(source, /BEGIN TRANSACTION READ ONLY/);
  assert.match(readiness, /83/);
  assert.match(readiness, /phase_b_collection_epochs/);
  assert.match(pkg, /phaseb:declare-collection-epoch/);
  assert.match(pkg, /phaseb:collection-epoch-readiness/);
});
