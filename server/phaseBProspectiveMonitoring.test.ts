import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildPhaseBProspectiveMonitoringReport,
  effectiveSampleSizeFromWeights,
  PHASE_B_MINIMUM_CLASS_ESS,
  PHASE_B_MINIMUM_EVIDENCE_ELIGIBILITY_BPS,
  PHASE_B_PROSPECTIVE_MONITORING_VERSION,
  propensityWeightFromBasisPoints
} from './phaseBProspectiveMonitoring';

test('propensity weights and ESS match inverse-probability Kish formula', () => {
  assert.equal(propensityWeightFromBasisPoints(100), 100);
  assert.equal(propensityWeightFromBasisPoints(10000), 1);
  assert.throws(() => propensityWeightFromBasisPoints(0), /INCLUSION_BASIS_POINTS_OUT_OF_RANGE/);
  const equal = Array.from({ length: 30 }, () => 100);
  assert.equal(effectiveSampleSizeFromWeights(equal), 30);
  const uneven = effectiveSampleSizeFromWeights([1, 99]);
  assert.ok(Math.abs(uneven - (100 * 100) / (1 + 99 * 99)) < 1e-9);
});

test('prospective monitoring reports fail closed until ESS, join completeness, and epoch readiness hold', () => {
  const report = buildPhaseBProspectiveMonitoringReport({
    windowStart: '2026-08-01T00:00:00.000Z',
    cutoffAt: '2026-08-10T00:00:00.000Z',
    segmentCounts: { countries: {}, languages: {}, discoveryOrigins: {} },
    metrics: {
      selectedAssignments: 100,
      diagnosticsMatched: 100,
      coverageMatched: 90,
      creatorFocusMatched: 90,
      labelsMatched: 40,
      fullyJoinableExamples: 40,
      disputedLabels: 1,
      unlabeledSelectedAssignments: 60,
      pendingGroundTruthObservations: 2,
      genuineLabeledCount: 20,
      baselineFalsePositiveLabeledCount: 20,
      meanInclusionProbability: 0.01,
      labelLagHoursP50: 12,
      labelLagHoursP95: 48,
      countries: 0,
      languages: 0,
      discoveryOrigins: 0,
      epochDeclared: false,
      genuineWeights: Array.from({ length: 20 }, () => 100),
      baselineFalsePositiveWeights: Array.from({ length: 20 }, () => 100)
    }
  });
  assert.equal(report.ready, false);
  assert.equal(report.servingAuthority, false);
  assert.equal(report.automaticPromotion, false);
  assert.equal(report.version, PHASE_B_PROSPECTIVE_MONITORING_VERSION);
  assert.equal(report.metrics.projectedEssGenuine, 20);
  assert.equal(report.metrics.projectedEssBaselineFalsePositive, 20);
  assert.equal(report.metrics.evidenceEligibilityBasisPoints, 4000);
  for (const code of [
    'COLLECTION_EPOCH_UNDECLARED',
    'LABEL_LAG_PRESENT',
    'GROUND_TRUTH_RECONCILIATION_PENDING',
    'EVIDENCE_ELIGIBILITY_BELOW_FLOOR',
    'JOIN_COMPLETENESS_BELOW_FLOOR',
    'GENUINE_ESS_BELOW_FLOOR',
    'BASELINE_FALSE_POSITIVE_ESS_BELOW_FLOOR',
    'SEGMENT_COVERAGE_INSUFFICIENT'
  ]) assert.ok(report.reasonCodes.includes(code), code);
});

test('prospective monitoring is ready only when both class ESS floors and eligibility floors pass', () => {
  const report = buildPhaseBProspectiveMonitoringReport({
    windowStart: '2026-08-01T00:00:00.000Z',
    cutoffAt: '2026-08-20T00:00:00.000Z',
    segmentCounts: {
      countries: { NG: 40, US: 30 },
      languages: { en: 50, ha: 20 },
      discoveryOrigins: { SEARCH: 70 }
    },
    metrics: {
      selectedAssignments: 100,
      diagnosticsMatched: 100,
      coverageMatched: 100,
      creatorFocusMatched: 100,
      labelsMatched: 100,
      fullyJoinableExamples: 100,
      disputedLabels: 0,
      unlabeledSelectedAssignments: 0,
      pendingGroundTruthObservations: 0,
      genuineLabeledCount: 50,
      baselineFalsePositiveLabeledCount: 50,
      meanInclusionProbability: 0.01,
      labelLagHoursP50: 6,
      labelLagHoursP95: 24,
      countries: 2,
      languages: 2,
      discoveryOrigins: 1,
      epochDeclared: true,
      epochStartedAt: '2026-08-01T00:00:00.000Z',
      genuineWeights: Array.from({ length: PHASE_B_MINIMUM_CLASS_ESS }, () => 100),
      baselineFalsePositiveWeights: Array.from({ length: PHASE_B_MINIMUM_CLASS_ESS }, () => 100)
    }
  });
  assert.equal(report.ready, true);
  assert.equal(report.metrics.projectedEssGenuine, PHASE_B_MINIMUM_CLASS_ESS);
  assert.equal(report.metrics.projectedEssBaselineFalsePositive, PHASE_B_MINIMUM_CLASS_ESS);
  assert.equal(report.metrics.evidenceEligibilityBasisPoints, 10000);
  assert.equal(report.minimumEvidenceEligibilityBasisPoints, PHASE_B_MINIMUM_EVIDENCE_ELIGIBILITY_BPS);
  assert.deepEqual(report.reasonCodes, []);
});

test('prospective monitoring remains observational and reuses Phase B surfaces', () => {
  const source = readFileSync(new URL('./phaseBProspectiveMonitoring.ts', import.meta.url), 'utf8');
  const pkg = readFileSync('package.json', 'utf8');
  assert.match(source, /BEGIN TRANSACTION READ ONLY/);
  assert.match(source, /servingAuthority: false/);
  assert.match(source, /automaticPromotion: false/);
  assert.match(source, /inspectActivePhaseBCollectionEpoch/);
  assert.match(source, /evaluation_cohort_assignments/);
  assert.match(source, /evaluation_ground_truth_labels/);
  assert.match(source, /creator_focus_classification_snapshots/);
  assert.match(source, /phase_b_observation_outbox/);
  assert.doesNotMatch(source, /db\.query\([`'"]\s*(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP)\b/i);
  assert.match(pkg, /phaseb:prospective-monitoring/);
});
