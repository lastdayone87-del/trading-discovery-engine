import { createHash } from 'node:crypto';
import { evaluateOperatorVisibleAssertionReplay } from './stage0OperatorVisibleAssertionReplay';
import { STAGE1_ADMISSION_POLICY_VERSION } from './offlineStage1';

type Decision = 'ADMIT_CONFIRMED' | 'ADMIT_REVIEW' | 'WITHHOLD' | 'DEFER_INVESTIGATION';

type ReplayRow = {
  channelId: string;
  channelName?: string;
  tradingStatus?: string;
  tradingMass?: number;
  alternativeMass?: number;
  decision?: Decision;
  reasonCodes?: string[];
  groundTruth?: 'TRADING_CONFIRMED' | 'NON_TRADING' | null;
  exclusionReason?: string | null;
  [key: string]: unknown;
};

const GATE_FAILURE_REASONS = new Set([
  'EVIDENCE_COVERAGE_INCOMPLETE',
  'LANGUAGE_CAPABILITY_REQUIRED',
  'TEMPORAL_EVIDENCE_REQUIRED',
  'INDEPENDENT_SOURCE_FAMILIES_REQUIRED'
]);

const checksum = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * Replays the Stage 1 hypothesis-capable policy over the already read-only Stage 0
 * assertion replay. This intentionally derives Stage 1 capability readiness from
 * the canonical Stage 0 Admission result: any capability-gate failure is already
 * encoded in its reason codes. No production state is mutated and no serving
 * authority is granted.
 */
export function applyStage1Decision(row: ReplayRow): { decision: Decision; reasonCodes: string[] } {
  const baselineDecision = row.decision || 'DEFER_INVESTIGATION';
  const baselineReasons = row.reasonCodes || [];
  const tradingMass = Number(row.tradingMass || 0);
  const alternativeMass = Number(row.alternativeMass || 0);
  const capabilityReady = !baselineReasons.some(reason => GATE_FAILURE_REASONS.has(reason));

  const dominantAlternative = capabilityReady && alternativeMass >= 0.8 && tradingMass < 0.2 && alternativeMass >= tradingMass * 4;
  const plausibleTradingHypothesis = capabilityReady && tradingMass >= 0.35 && tradingMass > alternativeMass;

  if (dominantAlternative) {
    return { decision: 'WITHHOLD', reasonCodes: ['DOMINANT_ALTERNATIVE_CREATOR_FOCUS', 'AFFIRMATIVE_NON_TRADING_EVIDENCE'] };
  }
  if (baselineDecision === 'ADMIT_REVIEW' && !plausibleTradingHypothesis) {
    return { decision: 'DEFER_INVESTIGATION', reasonCodes: ['TRADING_HYPOTHESIS_NOT_YET_PLAUSIBLE', 'ALTERNATIVE_FOCUS_NOT_EXCLUDED'] };
  }
  return { decision: baselineDecision, reasonCodes: baselineReasons };
}

const rate = (numerator: number, denominator: number) => denominator > 0 ? numerator / denominator : null;

export async function evaluateStage1OperatorVisibleReplay(): Promise<Record<string, unknown>> {
  const stage0 = await evaluateOperatorVisibleAssertionReplay() as any;
  const baselineRows = (stage0.rows || []) as ReplayRow[];
  const rows = baselineRows.map(row => {
    if (row.exclusionReason) return { ...row, stage1Decision: null, stage1ReasonCodes: ['REPLAY_INPUT_INCOMPLETE'] };
    const result = applyStage1Decision(row);
    return { ...row, stage1Decision: result.decision, stage1ReasonCodes: result.reasonCodes };
  });

  const evaluable = rows.filter((row: any) => !row.exclusionReason && row.stage1Decision);
  const decisionCounts: Record<Decision, number> = { ADMIT_CONFIRMED: 0, ADMIT_REVIEW: 0, WITHHOLD: 0, DEFER_INVESTIGATION: 0 };
  for (const row of evaluable) decisionCounts[row.stage1Decision as Decision]++;

  const labeled = evaluable.filter((row: any) => row.groundTruth === 'TRADING_CONFIRMED' || row.groundTruth === 'NON_TRADING');
  const genuine = labeled.filter((row: any) => row.groundTruth === 'TRADING_CONFIRMED');
  const nonTrading = labeled.filter((row: any) => row.groundTruth === 'NON_TRADING');
  const retainedGenuine = genuine.filter((row: any) => row.stage1Decision !== 'WITHHOLD');
  const withheldNonTrading = nonTrading.filter((row: any) => row.stage1Decision === 'WITHHOLD');
  const baselineReview = labeled.filter((row: any) => ['UNCERTAIN', 'NEEDS_REVIEW'].includes(String(row.tradingStatus || '')));
  const proposedReview = baselineReview.filter((row: any) => row.stage1Decision === 'ADMIT_REVIEW');

  const metrics = {
    historicalEvidenceEligibility: {
      operatorVisibleChannels: baselineRows.length,
      evaluated: evaluable.length,
      rate: rate(evaluable.length, baselineRows.length)
    },
    falsePositiveWithhold: {
      nonTradingCreators: nonTrading.length,
      withheldNonTrading: withheldNonTrading.length,
      rate: rate(withheldNonTrading.length, nonTrading.length),
      effectiveSampleSize: nonTrading.length
    },
    genuineCreatorRecall: {
      genuineCreators: genuine.length,
      retainedCreators: retainedGenuine.length,
      rate: rate(retainedGenuine.length, genuine.length),
      effectiveSampleSize: genuine.length
    },
    projectedReviewReduction: {
      baselineEligible: baselineReview.length,
      proposedReview: proposedReview.length,
      avoided: baselineReview.length - proposedReview.length,
      rate: rate(baselineReview.length - proposedReview.length, baselineReview.length)
    }
  };

  return {
    reportType: 'STAGE1_OPERATOR_VISIBLE_HYPOTHESIS_REPLAY',
    policyVersion: STAGE1_ADMISSION_POLICY_VERSION,
    sourceReportType: stage0.reportType,
    historicalReplay: true,
    persisted: false,
    readOnly: true,
    servingAuthority: false,
    automaticPromotion: false,
    totals: {
      operatorVisibleChannels: baselineRows.length,
      evaluated: evaluable.length,
      excluded: baselineRows.length - evaluable.length,
      decisionCounts,
      projectedDashboardVisible: decisionCounts.ADMIT_CONFIRMED + decisionCounts.ADMIT_REVIEW
    },
    metrics,
    stage0Totals: stage0.totals,
    rows,
    inputChecksum: checksum(baselineRows.map(row => ({ channelId: row.channelId, decision: row.decision, tradingMass: row.tradingMass, alternativeMass: row.alternativeMass }))),
    outputChecksum: checksum(rows.map((row: any) => ({ channelId: row.channelId, decision: row.stage1Decision, reasons: row.stage1ReasonCodes })))
  };
}
