import { createHash } from 'node:crypto';
import { runStage2RatePressureShadowEvaluation } from './stage2RatePressureShadowPolicy';

export const STAGE2_GUARDED_PROMOTION_GATE_VERSION = 'stage2-guarded-promotion-gate-v1';

export const STAGE2_GUARDED_PROMOTION_THRESHOLDS = Object.freeze({
  minimumExamplesPerClass: 30,
  minimumEvaluationCoverage: 1,
  minimumDecisiveDecisionRate: 0.70,
  minimumNonTradingWithholdRate: 0.65,
  minimumGenuineCreatorRecall: 1,
  maximumGenuineCreatorFalseWithholdRate: 0
});

const checksum = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function runStage2GuardedPromotionGate(requestedDatasetId?: string) {
  const shadow = await runStage2RatePressureShadowEvaluation(requestedDatasetId);
  const t = STAGE2_GUARDED_PROMOTION_THRESHOLDS;
  const m = shadow.metrics;
  const blockers: string[] = [];

  if (m.nonTradingWithhold.nonTradingCreators < t.minimumExamplesPerClass) blockers.push('NON_TRADING_SAMPLE_BELOW_MINIMUM');
  if (m.genuineCreatorRecall.genuineCreators < t.minimumExamplesPerClass) blockers.push('GENUINE_CREATOR_SAMPLE_BELOW_MINIMUM');
  if ((m.evaluationCoverage.rate ?? 0) < t.minimumEvaluationCoverage) blockers.push('EVALUATION_COVERAGE_BELOW_FLOOR');
  if ((m.decisiveDecisionRate.rate ?? 0) < t.minimumDecisiveDecisionRate) blockers.push('DECISIVE_DECISION_RATE_BELOW_FLOOR');
  if ((m.nonTradingWithhold.rate ?? 0) < t.minimumNonTradingWithholdRate) blockers.push('NON_TRADING_WITHHOLD_RATE_BELOW_FLOOR');
  if ((m.genuineCreatorRecall.rate ?? 0) < t.minimumGenuineCreatorRecall) blockers.push('GENUINE_CREATOR_RECALL_BELOW_FLOOR');
  if ((m.genuineCreatorFalseWithhold.rate ?? 1) > t.maximumGenuineCreatorFalseWithholdRate) blockers.push('GENUINE_CREATOR_FALSE_WITHHOLD_ABOVE_CEILING');

  const deferred = shadow.rows.filter((row: any) => row.decision === 'DEFER_INVESTIGATION').map((row: any) => ({
    exampleKey: row.exampleKey,
    channelId: row.channelId,
    groundTruth: row.groundTruth,
    tradingMass: row.creatorFocus?.tradingMass ?? null,
    alternativeMass: row.creatorFocus?.alternativeMass ?? null,
    observedDocumentCount: row.evidenceCoverage?.observedDocumentCount ?? 0,
    independentFamilyCount: row.evidenceCoverage?.independentFamilyCount ?? 0,
    reasonCodes: row.reasonCodes || []
  }));

  const fallbackWithheld = shadow.rows.filter((row: any) => row.ratePressureFallbackApplied).map((row: any) => ({
    exampleKey: row.exampleKey,
    channelId: row.channelId,
    groundTruth: row.groundTruth,
    tradingMass: row.creatorFocus?.tradingMass ?? null,
    observedDocumentCount: row.evidenceCoverage?.observedDocumentCount ?? 0,
    independentFamilyCount: row.evidenceCoverage?.independentFamilyCount ?? 0
  }));

  const gateStatus = blockers.length === 0 ? 'READY_FOR_LIMITED_CANARY_DESIGN' : 'NOT_READY';
  const report = {
    reportType: 'STAGE2_GUARDED_PROMOTION_GATE',
    version: STAGE2_GUARDED_PROMOTION_GATE_VERSION,
    datasetId: shadow.datasetId,
    sourceShadowVersion: shadow.version,
    gateStatus,
    servingAuthority: false,
    automaticPromotion: false,
    mutatesOperationalState: false,
    productionActivation: false,
    thresholds: t,
    observedMetrics: m,
    decisionCounts: shadow.totals.decisionCounts,
    fallbackApplied: shadow.totals.fallbackApplied,
    blockers,
    deferred,
    fallbackWithheld,
    providerDegradation: m.providerDegradation,
    nextAction: gateStatus === 'READY_FOR_LIMITED_CANARY_DESIGN'
      ? 'DESIGN_EXPLICIT_LIMITED_CANARY_WITH_KILL_SWITCH'
      : 'REPAIR_BLOCKERS_BEFORE_CANARY_DESIGN'
  };

  return { ...report, outputChecksum: checksum(report) };
}
