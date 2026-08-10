import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateStage0PromotionReadiness,
  promotionEvidenceFromReport,
  STAGE0_GUARDRAILS,
  type Stage0PromotionEvidence
} from './stage0PromotionReadiness';

const supportedWindow = (key: string, cutoffAt: string): Stage0PromotionEvidence => ({
  evidenceKey: key,
  cutoffAt,
  servingAuthority: false,
  automaticPromotion: false,
  hypothesisOutcome: 'SUPPORTED',
  metrics: {
    historicalEvidenceEligibility: { rate: 0.95 },
    falsePositiveReduction: { rate: 0.25, effectiveSampleSize: 40 },
    genuineCreatorRecall: { rate: 0.98, effectiveSampleSize: 45 },
    projectedReviewWorkloadReduction: { rate: 0.2 }
  }
});

test('one otherwise-good window cannot establish temporal stability', () => {
  const result = evaluateStage0PromotionReadiness([supportedWindow('window-a', '2026-07-31T00:00:00.000Z')]);
  assert.equal(result.recommendation, 'HOLD_STAGE0');
  assert.ok(result.reasonCodes.includes('TEMPORAL_STABILITY_EVIDENCE_INSUFFICIENT'));
  assert.equal(result.servingAuthority, false);
  assert.equal(result.automaticPromotion, false);
});

test('two independent windows that hold all existing safety guardrails are ready only for Stage 1 design', () => {
  const result = evaluateStage0PromotionReadiness([
    supportedWindow('window-a', '2026-07-31T00:00:00.000Z'),
    supportedWindow('window-b', '2026-08-07T00:00:00.000Z')
  ]);
  assert.equal(result.recommendation, 'READY_FOR_STAGE1_DESIGN');
  assert.deepEqual(result.reasonCodes, []);
  assert.equal(result.independentWindows, STAGE0_GUARDRAILS.minimumIndependentWindows);
  assert.equal(result.servingAuthority, false);
  assert.equal(result.automaticPromotion, false);
});

test('positive false-positive reduction is not enough when projected review reduction is zero', () => {
  const second = supportedWindow('window-b', '2026-08-07T00:00:00.000Z');
  second.metrics!.projectedReviewWorkloadReduction.rate = 0;
  const result = evaluateStage0PromotionReadiness([
    supportedWindow('window-a', '2026-07-31T00:00:00.000Z'),
    second
  ]);
  assert.equal(result.recommendation, 'HOLD_STAGE0');
  assert.ok(result.windows[1].reasonCodes.includes('NO_PROJECTED_REVIEW_WORKLOAD_REDUCTION'));
});

test('ESS and recall floors remain the existing Offline V2 values', () => {
  const second = supportedWindow('window-b', '2026-08-07T00:00:00.000Z');
  second.metrics!.genuineCreatorRecall.effectiveSampleSize = 29;
  second.metrics!.genuineCreatorRecall.rate = 0.94;
  const result = evaluateStage0PromotionReadiness([
    supportedWindow('window-a', '2026-07-31T00:00:00.000Z'),
    second
  ]);
  assert.equal(result.recommendation, 'HOLD_STAGE0');
  assert.ok(result.windows[1].reasonCodes.includes('GENUINE_CREATOR_EFFECTIVE_SAMPLE_SIZE_INSUFFICIENT'));
  assert.ok(result.windows[1].reasonCodes.includes('GENUINE_CREATOR_RECALL_BELOW_FLOOR'));
});

test('report normalization accepts Stage 0 wrapper metrics without granting authority', () => {
  const evidence = promotionEvidenceFromReport({
    reportVersion: 'stage0-test',
    generatedAt: '2026-08-10T00:00:00.000Z',
    servingAuthority: false,
    automaticPromotion: false,
    labeledOfflineReport: {
      hypothesisAssessment: { outcome: 'SUPPORTED' },
      metrics: supportedWindow('x', 'x').metrics
    },
    inputChecksum: 'abc'
  }, 'fallback');
  assert.equal(evidence.hypothesisOutcome, 'SUPPORTED');
  assert.equal(evidence.servingAuthority, false);
  assert.equal(evidence.automaticPromotion, false);
  assert.equal(evidence.metrics?.genuineCreatorRecall.rate, 0.98);
});
