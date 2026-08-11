export const STAGE2_DASHBOARD_CANARY_READINESS_VERSION = 'stage2-dashboard-canary-readiness-v2';

export interface Stage1SealedReplaySummary {
  servingAuthority?: boolean;
  automaticPromotion?: boolean;
  dataset?: { id?: string; version?: number | string; cutoff_at?: string; cutoffAt?: string } | Record<string, unknown>;
  metrics?: {
    historicalEvidenceEligibility?: { rate?: number | null };
    falsePositiveWithhold?: { rate?: number | null; effectiveSampleSize?: number };
    genuineCreatorRecall?: { rate?: number | null; effectiveSampleSize?: number };
    projectedReviewReduction?: { rate?: number | null };
    decisiveDecisionRate?: { rate?: number | null; evaluated?: number; decisive?: number; deferred?: number };
  };
}

export interface Stage2RuntimeControlSnapshot {
  dashboardServingMode: string;
  rolloutMode?: string | null;
  rolloutGateDecision?: string | null;
  rolloutActivationId?: string | null;
  assignedTreatmentCount?: number;
}

export interface Stage2DashboardCanaryReadinessPolicy {
  minimumHistoricalEligibility: number;
  minimumNonTradingEffectiveSampleSize: number;
  minimumGenuineEffectiveSampleSize: number;
  minimumGenuineRecall: number;
  minimumFalsePositiveWithholdRate: number;
  minimumProjectedReviewReduction: number;
  minimumDecisiveDecisionRate: number;
}

export const DEFAULT_STAGE2_DASHBOARD_CANARY_READINESS_POLICY: Stage2DashboardCanaryReadinessPolicy = {
  minimumHistoricalEligibility: 0.9,
  minimumNonTradingEffectiveSampleSize: 30,
  minimumGenuineEffectiveSampleSize: 30,
  minimumGenuineRecall: 0.95,
  minimumFalsePositiveWithholdRate: Number.EPSILON,
  minimumProjectedReviewReduction: Number.EPSILON,
  minimumDecisiveDecisionRate: Number.EPSILON
};

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export function evaluateStage2DashboardCanaryReadiness(
  stage1: Stage1SealedReplaySummary,
  runtime: Stage2RuntimeControlSnapshot,
  policy: Stage2DashboardCanaryReadinessPolicy = DEFAULT_STAGE2_DASHBOARD_CANARY_READINESS_POLICY
) {
  const reasons: string[] = [];
  const metrics = stage1.metrics || {};
  const historicalEligibility = metrics.historicalEvidenceEligibility?.rate;
  const nonTradingEss = metrics.falsePositiveWithhold?.effectiveSampleSize;
  const falsePositiveWithhold = metrics.falsePositiveWithhold?.rate;
  const genuineEss = metrics.genuineCreatorRecall?.effectiveSampleSize;
  const genuineRecall = metrics.genuineCreatorRecall?.rate;
  const reviewReduction = metrics.projectedReviewReduction?.rate;
  const decisiveDecisionRate = metrics.decisiveDecisionRate?.rate;

  // Stage 2 is a first authority transfer. Its input must itself be a non-serving
  // Stage 1 measurement artifact; this prevents a serving report from grading
  // or authorizing its own rollout.
  if (stage1.servingAuthority !== false) reasons.push('STAGE1_REPORT_MUST_BE_NON_SERVING');
  if (stage1.automaticPromotion !== false) reasons.push('STAGE1_AUTOMATIC_PROMOTION_MUST_BE_DISABLED');

  if (!finite(historicalEligibility) || historicalEligibility < policy.minimumHistoricalEligibility) reasons.push('HISTORICAL_EVIDENCE_ELIGIBILITY');
  if (!finite(nonTradingEss) || nonTradingEss < policy.minimumNonTradingEffectiveSampleSize) reasons.push('NON_TRADING_EFFECTIVE_SAMPLE_SIZE');
  if (!finite(genuineEss) || genuineEss < policy.minimumGenuineEffectiveSampleSize) reasons.push('GENUINE_EFFECTIVE_SAMPLE_SIZE');
  if (!finite(genuineRecall) || genuineRecall < policy.minimumGenuineRecall) reasons.push('GENUINE_CREATOR_RECALL');
  if (!finite(falsePositiveWithhold) || falsePositiveWithhold < policy.minimumFalsePositiveWithholdRate) reasons.push('FALSE_POSITIVE_WITHHOLD_NOT_DEMONSTRATED');
  if (!finite(reviewReduction) || reviewReduction < policy.minimumProjectedReviewReduction) reasons.push('REVIEW_REDUCTION_NOT_DEMONSTRATED');
  if (!finite(decisiveDecisionRate) || decisiveDecisionRate < policy.minimumDecisiveDecisionRate) reasons.push('DECISIVE_STAGE1_DECISIONS_NOT_DEMONSTRATED');

  // Preparation is deliberately dormant. A readiness check must never be run
  // while dashboard serving is already enabled or while treatment assignments
  // are present for the current rollout.
  if (String(runtime.dashboardServingMode || 'OFF').toUpperCase() !== 'OFF') reasons.push('DASHBOARD_KILL_SWITCH_NOT_OFF');
  if (runtime.rolloutMode && String(runtime.rolloutMode).toUpperCase() !== 'OFF') reasons.push('DASHBOARD_ROLLOUT_ALREADY_ACTIVE');
  if ((runtime.assignedTreatmentCount || 0) > 0) reasons.push('DASHBOARD_TREATMENT_ASSIGNMENTS_ALREADY_PRESENT');

  const readyForPromotionGate = reasons.length === 0;
  return {
    reportType: 'STAGE2_DASHBOARD_CANARY_READINESS',
    policyVersion: STAGE2_DASHBOARD_CANARY_READINESS_VERSION,
    readyForPromotionGate,
    servingAuthority: false,
    automaticActivation: false,
    requestedServingMode: 'OFF',
    reasons,
    policy,
    observed: {
      dataset: stage1.dataset || null,
      historicalEligibility: finite(historicalEligibility) ? historicalEligibility : null,
      nonTradingEffectiveSampleSize: finite(nonTradingEss) ? nonTradingEss : null,
      genuineEffectiveSampleSize: finite(genuineEss) ? genuineEss : null,
      genuineRecall: finite(genuineRecall) ? genuineRecall : null,
      falsePositiveWithholdRate: finite(falsePositiveWithhold) ? falsePositiveWithhold : null,
      projectedReviewReduction: finite(reviewReduction) ? reviewReduction : null,
      decisiveDecisionRate: finite(decisiveDecisionRate) ? decisiveDecisionRate : null,
      runtime
    },
    nextAction: readyForPromotionGate
      ? 'CREATE_EXPLICIT_STAGE2_PROMOTION_GATE; DO_NOT_ACTIVATE SERVING AUTOMATICALLY'
      : 'HOLD_STAGE1_AND_REPAIR_REPLAY_EVIDENCE_BEFORE_STAGE2_PROMOTION'
  };
}
