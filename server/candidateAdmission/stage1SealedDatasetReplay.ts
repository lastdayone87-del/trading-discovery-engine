import { createHash } from 'node:crypto';
import { evaluateSealedDatasetOfflineV2 } from './offlineV2Store';
import { STAGE1_ADMISSION_POLICY_VERSION } from './offlineStage1';

type Decision = 'ADMIT_CONFIRMED' | 'ADMIT_REVIEW' | 'WITHHOLD' | 'DEFER_INVESTIGATION';

const GATE_FAILURE_REASONS = new Set([
  'EVIDENCE_COVERAGE_INCOMPLETE',
  'LANGUAGE_CAPABILITY_REQUIRED',
  'TEMPORAL_EVIDENCE_REQUIRED',
  'INDEPENDENT_SOURCE_FAMILIES_REQUIRED'
]);

const checksum = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rate = (n: number, d: number) => d > 0 ? n / d : null;

export function applyStage1ToSealedResult(result: any): { decision: Decision; reasonCodes: string[] } {
  const baselineDecision = result.decision as Decision;
  const baselineReasons = Array.isArray(result.reasonCodes) ? result.reasonCodes as string[] : [];
  const tradingMass = Number(result.creatorFocus?.tradingMass || 0);
  const alternativeMass = Number(result.creatorFocus?.alternativeMass || 0);
  const capabilityReady = !baselineReasons.some(reason => GATE_FAILURE_REASONS.has(reason));
  const dominantAlternative = capabilityReady && alternativeMass >= 0.8 && tradingMass < 0.2 && alternativeMass >= tradingMass * 4;
  const plausibleTrading = capabilityReady && tradingMass >= 0.35 && tradingMass > alternativeMass;

  if (dominantAlternative) {
    return { decision: 'WITHHOLD', reasonCodes: ['DOMINANT_ALTERNATIVE_CREATOR_FOCUS', 'AFFIRMATIVE_NON_TRADING_EVIDENCE'] };
  }
  if (baselineDecision === 'ADMIT_REVIEW' && !plausibleTrading) {
    return { decision: 'DEFER_INVESTIGATION', reasonCodes: ['TRADING_HYPOTHESIS_NOT_YET_PLAUSIBLE', 'ALTERNATIVE_FOCUS_NOT_EXCLUDED'] };
  }
  return { decision: baselineDecision, reasonCodes: baselineReasons };
}

export async function evaluateStage1SealedDatasetReplay(datasetId: string): Promise<Record<string, unknown>> {
  const baseline = await evaluateSealedDatasetOfflineV2(datasetId);
  const rows = baseline.results.map(result => {
    const stage1 = applyStage1ToSealedResult(result);
    return { ...result, stage1Decision: stage1.decision, stage1ReasonCodes: stage1.reasonCodes };
  });
  const decisionCounts: Record<Decision, number> = { ADMIT_CONFIRMED: 0, ADMIT_REVIEW: 0, WITHHOLD: 0, DEFER_INVESTIGATION: 0 };
  for (const row of rows) decisionCounts[row.stage1Decision as Decision]++;

  const genuine = rows.filter(row => row.groundTruth === 'TRADING_CONFIRMED');
  const nonTrading = rows.filter(row => row.groundTruth === 'NON_TRADING');
  const retainedGenuine = genuine.filter(row => row.stage1Decision !== 'WITHHOLD');
  const withheldNonTrading = nonTrading.filter(row => row.stage1Decision === 'WITHHOLD');
  const baselineReview = rows.filter(row => ['UNCERTAIN', 'NEEDS_REVIEW'].includes(String(row.production?.status || '')));
  const proposedReview = baselineReview.filter(row => row.stage1Decision === 'ADMIT_REVIEW');
  const sealedExamples = rows.length + baseline.excludedExamples.length;

  return {
    reportType: 'STAGE1_SEALED_LABELED_COHORT_REPLAY',
    policyVersion: STAGE1_ADMISSION_POLICY_VERSION,
    dataset: baseline.dataset,
    generatedFromImmutableHistory: true,
    persisted: false,
    readOnly: true,
    servingAuthority: false,
    automaticPromotion: false,
    totals: { sealedExamples, evaluated: rows.length, excluded: baseline.excludedExamples.length, decisionCounts },
    metrics: {
      historicalEvidenceEligibility: { sealedExamples, evaluated: rows.length, excluded: baseline.excludedExamples.length, rate: rate(rows.length, sealedExamples) },
      falsePositiveWithhold: { nonTradingCreators: nonTrading.length, withheldNonTrading: withheldNonTrading.length, rate: rate(withheldNonTrading.length, nonTrading.length), effectiveSampleSize: nonTrading.length },
      genuineCreatorRecall: { genuineCreators: genuine.length, retainedCreators: retainedGenuine.length, rate: rate(retainedGenuine.length, genuine.length), effectiveSampleSize: genuine.length },
      projectedReviewReduction: { baselineEligible: baselineReview.length, proposedReview: proposedReview.length, avoided: baselineReview.length - proposedReview.length, rate: rate(baselineReview.length - proposedReview.length, baselineReview.length) }
    },
    excludedExamples: baseline.excludedExamples,
    rows,
    inputChecksum: baseline.inputChecksum,
    outputChecksum: checksum(rows.map(row => ({ exampleKey: row.exampleKey, stage1Decision: row.stage1Decision, stage1ReasonCodes: row.stage1ReasonCodes })))
  };
}
