import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateStage2DashboardCanaryReadiness } from './stage2DashboardCanaryReadiness';

const passingStage1 = () => ({
  servingAuthority: false,
  automaticPromotion: false,
  dataset: { id: 'sealed-stage1-dataset' },
  metrics: {
    historicalEvidenceEligibility: { rate: 0.95 },
    falsePositiveWithhold: { rate: 0.4, effectiveSampleSize: 30 },
    genuineCreatorRecall: { rate: 0.97, effectiveSampleSize: 30 },
    projectedReviewReduction: { rate: 0.2 }
  }
});

const dormantRuntime = () => ({
  dashboardServingMode: 'OFF',
  rolloutMode: null,
  rolloutGateDecision: null,
  rolloutActivationId: null,
  assignedTreatmentCount: 0
});

test('stage 2 readiness remains non-serving even when evidence is sufficient', () => {
  const report = evaluateStage2DashboardCanaryReadiness(passingStage1(), dormantRuntime());
  assert.equal(report.readyForPromotionGate, true);
  assert.equal(report.servingAuthority, false);
  assert.equal(report.automaticActivation, false);
  assert.equal(report.requestedServingMode, 'OFF');
  assert.match(report.nextAction, /DO_NOT_ACTIVATE/);
});

test('stage 2 cannot advance without independent non-trading and genuine ESS floors', () => {
  const stage1 = passingStage1();
  stage1.metrics.falsePositiveWithhold.effectiveSampleSize = 29;
  stage1.metrics.genuineCreatorRecall.effectiveSampleSize = 29;
  const report = evaluateStage2DashboardCanaryReadiness(stage1, dormantRuntime());
  assert.equal(report.readyForPromotionGate, false);
  assert.ok(report.reasons.includes('NON_TRADING_EFFECTIVE_SAMPLE_SIZE'));
  assert.ok(report.reasons.includes('GENUINE_EFFECTIVE_SAMPLE_SIZE'));
});

test('stage 2 refuses a serving or automatically promoted stage 1 report', () => {
  const stage1 = { ...passingStage1(), servingAuthority: true, automaticPromotion: true };
  const report = evaluateStage2DashboardCanaryReadiness(stage1, dormantRuntime());
  assert.equal(report.readyForPromotionGate, false);
  assert.ok(report.reasons.includes('STAGE1_REPORT_MUST_BE_NON_SERVING'));
  assert.ok(report.reasons.includes('STAGE1_AUTOMATIC_PROMOTION_MUST_BE_DISABLED'));
});

test('stage 2 preparation fails closed if dashboard serving is already enabled', () => {
  const report = evaluateStage2DashboardCanaryReadiness(passingStage1(), {
    ...dormantRuntime(),
    dashboardServingMode: 'CANARY',
    rolloutMode: 'CANARY',
    assignedTreatmentCount: 1
  });
  assert.equal(report.readyForPromotionGate, false);
  assert.ok(report.reasons.includes('DASHBOARD_KILL_SWITCH_NOT_OFF'));
  assert.ok(report.reasons.includes('DASHBOARD_ROLLOUT_ALREADY_ACTIVE'));
  assert.ok(report.reasons.includes('DASHBOARD_TREATMENT_ASSIGNMENTS_ALREADY_PRESENT'));
});

test('stage 2 keeps recall, false-positive withholding, and review-reduction floors explicit', () => {
  const stage1 = passingStage1();
  stage1.metrics.genuineCreatorRecall.rate = 0.94;
  stage1.metrics.falsePositiveWithhold.rate = 0;
  stage1.metrics.projectedReviewReduction.rate = 0;
  const report = evaluateStage2DashboardCanaryReadiness(stage1, dormantRuntime());
  assert.equal(report.readyForPromotionGate, false);
  assert.ok(report.reasons.includes('GENUINE_CREATOR_RECALL'));
  assert.ok(report.reasons.includes('FALSE_POSITIVE_WITHHOLD_NOT_DEMONSTRATED'));
  assert.ok(report.reasons.includes('REVIEW_REDUCTION_NOT_DEMONSTRATED'));
});
