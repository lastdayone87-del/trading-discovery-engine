export const STAGE0_PROMOTION_READINESS_VERSION = 'stage0-promotion-readiness-1';

export const STAGE0_GUARDRAILS = {
  minimumIndependentWindows: 2,
  minimumHistoricalEvidenceEligibility: 0.9,
  minimumEffectiveSampleSize: 30,
  minimumGenuineCreatorRecall: 0.95
} as const;

type MetricRate = { rate: number | null };
type MetricEss = MetricRate & { effectiveSampleSize: number };

export interface Stage0SealedMetrics {
  historicalEvidenceEligibility: MetricRate;
  falsePositiveReduction: MetricEss;
  genuineCreatorRecall: MetricEss;
  projectedReviewWorkloadReduction: MetricRate;
}

export interface Stage0PromotionEvidence {
  evidenceKey: string;
  cutoffAt: string;
  servingAuthority: boolean;
  automaticPromotion: boolean;
  hypothesisOutcome: 'SUPPORTED' | 'NOT_SUPPORTED' | 'INSUFFICIENT_EVIDENCE' | null;
  metrics: Stage0SealedMetrics | null;
  inputChecksum?: string | null;
  outputChecksum?: string | null;
}

export interface Stage0PromotionReadinessResult {
  version: string;
  recommendation: 'READY_FOR_STAGE1_DESIGN' | 'HOLD_STAGE0';
  servingAuthority: false;
  automaticPromotion: false;
  guardrails: typeof STAGE0_GUARDRAILS;
  independentWindows: number;
  reasonCodes: string[];
  windows: Array<{
    evidenceKey: string;
    cutoffAt: string;
    passed: boolean;
    reasonCodes: string[];
  }>;
}

const finiteRate = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value);

function evaluateWindow(evidence: Stage0PromotionEvidence): string[] {
  const reasons: string[] = [];
  if (evidence.servingAuthority !== false) reasons.push('SERVING_AUTHORITY_MUST_REMAIN_FALSE');
  if (evidence.automaticPromotion !== false) reasons.push('AUTOMATIC_PROMOTION_MUST_REMAIN_FALSE');
  if (evidence.hypothesisOutcome !== 'SUPPORTED') reasons.push('OFFLINE_HYPOTHESIS_NOT_SUPPORTED');
  if (!evidence.metrics) {
    reasons.push('SEALED_METRICS_MISSING');
    return reasons;
  }

  const metrics = evidence.metrics;
  if (!finiteRate(metrics.historicalEvidenceEligibility.rate) ||
      metrics.historicalEvidenceEligibility.rate < STAGE0_GUARDRAILS.minimumHistoricalEvidenceEligibility) {
    reasons.push('HISTORICAL_EVIDENCE_ELIGIBILITY_BELOW_FLOOR');
  }
  if (metrics.falsePositiveReduction.effectiveSampleSize < STAGE0_GUARDRAILS.minimumEffectiveSampleSize) {
    reasons.push('NON_TRADING_EFFECTIVE_SAMPLE_SIZE_INSUFFICIENT');
  }
  if (metrics.genuineCreatorRecall.effectiveSampleSize < STAGE0_GUARDRAILS.minimumEffectiveSampleSize) {
    reasons.push('GENUINE_CREATOR_EFFECTIVE_SAMPLE_SIZE_INSUFFICIENT');
  }
  if (!finiteRate(metrics.genuineCreatorRecall.rate) ||
      metrics.genuineCreatorRecall.rate < STAGE0_GUARDRAILS.minimumGenuineCreatorRecall) {
    reasons.push('GENUINE_CREATOR_RECALL_BELOW_FLOOR');
  }
  if (!finiteRate(metrics.falsePositiveReduction.rate) || metrics.falsePositiveReduction.rate <= 0) {
    reasons.push('NO_FALSE_POSITIVE_WITHHOLD_REDUCTION');
  }
  if (!finiteRate(metrics.projectedReviewWorkloadReduction.rate) || metrics.projectedReviewWorkloadReduction.rate <= 0) {
    reasons.push('NO_PROJECTED_REVIEW_WORKLOAD_REDUCTION');
  }
  return reasons;
}

/**
 * Stage 0 exit gate only. It never changes serving state and never promotes a
 * policy automatically. "Stability" is intentionally defined without a new
 * statistical tolerance: the existing safety guardrails must hold in at least
 * two distinct immutable evaluation windows. A single snapshot cannot establish
 * temporal stability.
 */
export function evaluateStage0PromotionReadiness(
  evidence: Stage0PromotionEvidence[]
): Stage0PromotionReadinessResult {
  const uniqueWindows = new Map<string, Stage0PromotionEvidence>();
  for (const item of evidence) {
    const key = `${item.evidenceKey}::${item.cutoffAt}`;
    if (!uniqueWindows.has(key)) uniqueWindows.set(key, item);
  }

  const windows = [...uniqueWindows.values()]
    .sort((a, b) => `${a.cutoffAt}:${a.evidenceKey}`.localeCompare(`${b.cutoffAt}:${b.evidenceKey}`))
    .map(item => {
      const reasonCodes = evaluateWindow(item);
      return { evidenceKey: item.evidenceKey, cutoffAt: item.cutoffAt, passed: reasonCodes.length === 0, reasonCodes };
    });

  const reasonCodes: string[] = [];
  if (windows.length < STAGE0_GUARDRAILS.minimumIndependentWindows) {
    reasonCodes.push('TEMPORAL_STABILITY_EVIDENCE_INSUFFICIENT');
  }
  if (windows.some(window => !window.passed)) {
    reasonCodes.push('ONE_OR_MORE_STAGE0_WINDOWS_FAILED_GUARDRAILS');
  }

  return {
    version: STAGE0_PROMOTION_READINESS_VERSION,
    recommendation: reasonCodes.length === 0 ? 'READY_FOR_STAGE1_DESIGN' : 'HOLD_STAGE0',
    servingAuthority: false,
    automaticPromotion: false,
    guardrails: STAGE0_GUARDRAILS,
    independentWindows: windows.length,
    reasonCodes,
    windows
  };
}

/** Normalize either the canonical Offline V2 report or the Stage 0 wrappers. */
export function promotionEvidenceFromReport(report: any, fallbackKey: string): Stage0PromotionEvidence {
  const labeled = report?.labeledOfflineReport;
  const metrics = report?.metrics || report?.labeledMetrics || labeled?.metrics || null;
  const hypothesis = report?.hypothesisAssessment || labeled?.hypothesisAssessment || null;
  const dataset = report?.dataset || {};
  return {
    evidenceKey: String(dataset.key || report?.reportType || report?.reportVersion || fallbackKey),
    cutoffAt: String(dataset.cutoffAt || report?.generatedAt || report?.cutoffAt || ''),
    servingAuthority: report?.servingAuthority === true,
    automaticPromotion: report?.automaticPromotion === true,
    hypothesisOutcome: hypothesis?.outcome || null,
    metrics,
    inputChecksum: report?.inputChecksum || null,
    outputChecksum: report?.outputChecksum || null
  };
}
