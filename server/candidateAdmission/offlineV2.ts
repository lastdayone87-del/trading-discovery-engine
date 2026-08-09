import { createHash } from 'node:crypto';
import { ALTERNATIVE_FOCUS_HYPOTHESES, TRADING_FOCUS_HYPOTHESES, type CreatorFocusDistribution } from '../evidenceEngine/hypothesisTaxonomy';

export const OFFLINE_ADMISSION_V2_POLICY_VERSION = 'creator-admission-v2-offline-poc-1';
export const OFFLINE_ADMISSION_V2_REPORT_VERSION = 'creator-admission-v2-offline-report-1';

export type OfflineAdmissionV2Decision = 'ADMIT_CONFIRMED' | 'ADMIT_REVIEW' | 'WITHHOLD' | 'DEFER_INVESTIGATION';
export type OfflineAdmissionGroundTruth = 'TRADING_CONFIRMED' | 'NON_TRADING';

export interface OfflineAdmissionCoverage {
  snapshotId: string;
  disposition: 'MISSING' | 'INSUFFICIENT' | 'SUFFICIENT';
  observedDocumentCount: number;
  expectedDocumentCount: number;
  independentFamilyCount: number;
  languageCoverage: Record<string, unknown>;
  temporalCoverage: Record<string, unknown>;
  providerAvailability: unknown[];
  acquisitionFailures: unknown[];
  reasonCodes: string[];
  inputChecksum: string;
  policyVersion: string;
}

export interface OfflineAdmissionExample {
  exampleKey: string;
  channelId: string;
  split: 'TEST';
  groundTruth: OfflineAdmissionGroundTruth;
  inclusionProbability: number;
  productionStatus: string;
  productionScore: number;
  segment: Record<string, string>;
  creatorFocusSnapshotId: string;
  creatorFocusInputChecksum: string;
  creatorFocusDistribution: CreatorFocusDistribution;
  creatorFocusProposedStatus: 'TRADING_CONFIRMED' | 'NON_TRADING' | 'UNCERTAIN';
  creatorFocusProbability: number;
  creatorFocusLowerConfidenceBound: number;
  creatorFocusReasonCodes: string[];
  creatorFocusStageReport: Record<string, unknown>;
  creatorFocusPolicyVersion: string;
  coverage: OfflineAdmissionCoverage;
}

export interface OfflineAdmissionV2Result {
  exampleKey: string;
  channelId: string;
  decision: OfflineAdmissionV2Decision;
  reasonCodes: string[];
  reasoning: string[];
  creatorFocus: {
    tradingMass: number;
    alternativeMass: number;
    probability: number;
    lowerConfidenceBound: number;
    proposedStatus: OfflineAdmissionExample['creatorFocusProposedStatus'];
    independentFamilies: number;
    documentCount: number;
    supportedLanguage: boolean;
    recentEvidence: boolean;
  };
  evidenceCoverage: OfflineAdmissionCoverage;
  production: { status: string; score: number };
  groundTruth: OfflineAdmissionGroundTruth;
  segment: Record<string, string>;
  policyVersion: string;
  servingAuthority: false;
}

export interface OfflineAdmissionV2Report {
  reportVersion: string;
  policyVersion: string;
  dataset: { id: string; key: string; version: number; cutoffAt: string; checksum: string };
  generatedFromImmutableHistory: true;
  servingAuthority: false;
  automaticPromotion: false;
  hypothesisAssessment: { outcome: 'SUPPORTED' | 'NOT_SUPPORTED' | 'INSUFFICIENT_EVIDENCE'; reasonCodes: string[]; minimumEffectiveSampleSize: number; minimumGenuineCreatorRecall: number; minimumHistoricalEvidenceEligibility: number };
  methodology: {
    propensityWeighted: true;
    falsePositiveBaseline: string;
    enrichmentBaseline: string;
    reviewBaseline: string;
    retentionDefinition: string;
  };
  evaluatedExamples: number;
  excludedExamples: Array<{ exampleKey: string; channelId: string; reasonCode: string }>;
  decisionCounts: Record<OfflineAdmissionV2Decision, number>;
  metrics: {
    historicalEvidenceEligibility: { sealedExamples: number; evaluatedExamples: number; excludedExamples: number; rate: number | null };
    falsePositiveReduction: { baselineFalsePositiveBurden: number; withheldNonTrading: number; rate: number | null; effectiveSampleSize: number };
    genuineCreatorRecall: { genuineCreators: number; retainedCreators: number; rate: number | null; confirmedCreators: number; confirmedRate: number | null; effectiveSampleSize: number };
    projectedEnrichmentReduction: { baselineEligible: number; avoided: number; rate: number | null };
    projectedReviewWorkloadReduction: { baselineEligible: number; proposedReview: number; avoided: number; rate: number | null };
  };
  segments: Record<string, {
    examples: number;
    genuineCreators: number;
    retainedGenuineCreators: number;
    nonTradingCreators: number;
    withheldNonTradingCreators: number;
  }>;
  results: OfflineAdmissionV2Result[];
  inputChecksum: string;
  outputChecksum: string;
}

const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
  : item);

export const offlineAdmissionChecksum = (value: unknown): string => createHash('sha256').update(stable(value)).digest('hex');

const sum = (distribution: CreatorFocusDistribution, keys: string[]): number => keys.reduce((total, key) => total + Number(distribution[key as keyof CreatorFocusDistribution] || 0), 0);
const ratio = (numerator: number, denominator: number): number | null => denominator > 0 ? numerator / denominator : null;
const weight = (example: Pick<OfflineAdmissionExample, 'inclusionProbability'>): number => {
  if (!(example.inclusionProbability > 0 && example.inclusionProbability <= 1)) throw new Error('Inclusion probability must be within (0,1].');
  return 1 / example.inclusionProbability;
};
const weightedTotal = (results: OfflineAdmissionV2Result[], examples: Map<string, OfflineAdmissionExample>): number => results.reduce((total, result) => total + weight(examples.get(result.exampleKey)!), 0);
const effectiveSampleSize = (results: OfflineAdmissionV2Result[], examples: Map<string, OfflineAdmissionExample>): number => {
  const weights = results.map(result => weight(examples.get(result.exampleKey)!));
  const total = weights.reduce((sum, item) => sum + item, 0), squares = weights.reduce((sum, item) => sum + item * item, 0);
  return squares > 0 ? total * total / squares : 0;
};
const stages = (report: Record<string, unknown>): Array<Record<string, unknown>> => Array.isArray(report.stages) ? report.stages as Array<Record<string, unknown>> : [];
const stage = (report: Record<string, unknown>, name: string): Record<string, unknown> | undefined => stages(report).find(item => item.stage === name);

/**
 * Pure counterfactual policy. It can only withhold when immutable creator-level
 * evidence affirmatively establishes a dominant alternative focus. Missing,
 * unsupported, stale, or dependent evidence always defers.
 */
export function evaluateOfflineAdmissionV2(example: OfflineAdmissionExample): OfflineAdmissionV2Result {
  const distribution = example.creatorFocusDistribution;
  const tradingMass = sum(distribution, TRADING_FOCUS_HYPOTHESES);
  const alternativeMass = sum(distribution, ALTERNATIVE_FOCUS_HYPOTHESES);
  const languageStage = stage(example.creatorFocusStageReport, 'LANGUAGE_CAPABILITY');
  const temporalStage = stage(example.creatorFocusStageReport, 'TEMPORAL_RELEVANCE');
  const supportedLanguage = languageStage?.disposition === 'PASS';
  const recentEvidence = temporalStage?.disposition === 'PASS';
  const coverageSufficient = example.coverage.disposition === 'SUFFICIENT' && example.coverage.observedDocumentCount >= 2;
  const independent = example.coverage.independentFamilyCount >= 2;
  const reasonCodes: string[] = [];
  let decision: OfflineAdmissionV2Decision;

  if (!coverageSufficient) {
    decision = 'DEFER_INVESTIGATION'; reasonCodes.push('EVIDENCE_COVERAGE_INCOMPLETE');
  } else if (!supportedLanguage) {
    decision = 'DEFER_INVESTIGATION'; reasonCodes.push('LANGUAGE_CAPABILITY_REQUIRED');
  } else if (!recentEvidence) {
    decision = 'DEFER_INVESTIGATION'; reasonCodes.push('TEMPORAL_EVIDENCE_REQUIRED');
  } else if (!independent) {
    decision = 'DEFER_INVESTIGATION'; reasonCodes.push('INDEPENDENT_SOURCE_FAMILIES_REQUIRED');
  } else if (alternativeMass >= .8 && tradingMass < .2 && example.creatorFocusProposedStatus === 'NON_TRADING') {
    decision = 'WITHHOLD'; reasonCodes.push('DOMINANT_ALTERNATIVE_CREATOR_FOCUS', 'AFFIRMATIVE_NON_TRADING_EVIDENCE');
  } else if (example.creatorFocusLowerConfidenceBound >= .7 && tradingMass >= .7 && alternativeMass < .6 && example.creatorFocusProposedStatus === 'TRADING_CONFIRMED') {
    decision = 'ADMIT_CONFIRMED'; reasonCodes.push('DOMINANT_TRADING_CREATOR_FOCUS', 'INDEPENDENT_RECENT_EVIDENCE_SUFFICIENT');
  } else if (tradingMass >= .35) {
    decision = 'ADMIT_REVIEW'; reasonCodes.push('PLAUSIBLE_TRADING_CREATOR_HYPOTHESIS', 'RESIDUAL_CREATOR_FOCUS_AMBIGUITY');
  } else {
    decision = 'DEFER_INVESTIGATION'; reasonCodes.push('NO_TERMINAL_DECISION', 'TRADING_HYPOTHESIS_NOT_YET_PLAUSIBLE');
  }

  const reasoning = [
    `Creator focus: trading mass ${tradingMass.toFixed(4)}, alternative mass ${alternativeMass.toFixed(4)}, lower confidence bound ${example.creatorFocusLowerConfidenceBound.toFixed(4)}.`,
    `Evidence coverage: ${example.coverage.disposition}; ${example.coverage.observedDocumentCount}/${example.coverage.expectedDocumentCount} documents; ${example.coverage.independentFamilyCount} independent source families.`,
    `Capability gates: language ${supportedLanguage ? 'supported' : 'not supported'}; temporal evidence ${recentEvidence ? 'present' : 'not established'}.`,
    `Counterfactual decision ${decision}: ${reasonCodes.join(', ')}.`
  ];

  return {
    exampleKey: example.exampleKey,
    channelId: example.channelId,
    decision,
    reasonCodes,
    reasoning,
    creatorFocus: {
      tradingMass, alternativeMass, probability: example.creatorFocusProbability,
      lowerConfidenceBound: example.creatorFocusLowerConfidenceBound,
      proposedStatus: example.creatorFocusProposedStatus,
      independentFamilies: example.coverage.independentFamilyCount,
      documentCount: example.coverage.observedDocumentCount,
      supportedLanguage, recentEvidence
    },
    evidenceCoverage: example.coverage,
    production: { status: example.productionStatus, score: example.productionScore },
    groundTruth: example.groundTruth,
    segment: example.segment,
    policyVersion: OFFLINE_ADMISSION_V2_POLICY_VERSION,
    servingAuthority: false
  };
}

const baselineConsumesEnrichment = (status: string): boolean => ['UNCERTAIN', 'NEEDS_REVIEW'].includes(status);
const baselineConsumesReview = (status: string): boolean => ['UNCERTAIN', 'NEEDS_REVIEW'].includes(status);
const baselineFalsePositiveBurden = (status: string): boolean => !['NON_TRADING', 'HUMAN_REJECTED'].includes(status);

export function buildOfflineAdmissionV2Report(input: {
  dataset: OfflineAdmissionV2Report['dataset'];
  examples: OfflineAdmissionExample[];
  excludedExamples?: OfflineAdmissionV2Report['excludedExamples'];
}): OfflineAdmissionV2Report {
  const examples = [...input.examples].sort((left, right) => left.exampleKey.localeCompare(right.exampleKey));
  const results = examples.map(evaluateOfflineAdmissionV2);
  const examplesByKey = new Map(examples.map(example => [example.exampleKey, example]));
  const counts: Record<OfflineAdmissionV2Decision, number> = { ADMIT_CONFIRMED: 0, ADMIT_REVIEW: 0, WITHHOLD: 0, DEFER_INVESTIGATION: 0 };
  for (const result of results) counts[result.decision]++;

  const nonTrading = results.filter(result => result.groundTruth === 'NON_TRADING');
  const genuine = results.filter(result => result.groundTruth === 'TRADING_CONFIRMED');
  const baselineFalsePositives = nonTrading.filter(result => baselineFalsePositiveBurden(result.production.status));
  const withheldNonTrading = baselineFalsePositives.filter(result => result.decision === 'WITHHOLD');
  const retainedGenuine = genuine.filter(result => result.decision !== 'WITHHOLD');
  const confirmedGenuine = genuine.filter(result => result.decision === 'ADMIT_CONFIRMED');
  const enrichmentBaseline = results.filter(result => baselineConsumesEnrichment(result.production.status));
  const enrichmentAvoided = enrichmentBaseline.filter(result => result.decision === 'WITHHOLD');
  const reviewBaseline = results.filter(result => baselineConsumesReview(result.production.status));
  const proposedReview = reviewBaseline.filter(result => result.decision === 'ADMIT_REVIEW');
  const baselineFalsePositiveWeight = weightedTotal(baselineFalsePositives, examplesByKey), withheldNonTradingWeight = weightedTotal(withheldNonTrading, examplesByKey);
  const genuineWeight = weightedTotal(genuine, examplesByKey), retainedGenuineWeight = weightedTotal(retainedGenuine, examplesByKey), confirmedGenuineWeight = weightedTotal(confirmedGenuine, examplesByKey);
  const enrichmentBaselineWeight = weightedTotal(enrichmentBaseline, examplesByKey), enrichmentAvoidedWeight = weightedTotal(enrichmentAvoided, examplesByKey);
  const reviewBaselineWeight = weightedTotal(reviewBaseline, examplesByKey), proposedReviewWeight = weightedTotal(proposedReview, examplesByKey);
  const segmentRows: OfflineAdmissionV2Report['segments'] = {};
  for (const result of results) {
    const key = stable(result.segment);
    const item = segmentRows[key] ||= { examples: 0, genuineCreators: 0, retainedGenuineCreators: 0, nonTradingCreators: 0, withheldNonTradingCreators: 0 };
    item.examples++;
    if (result.groundTruth === 'TRADING_CONFIRMED') {
      item.genuineCreators++;
      if (result.decision !== 'WITHHOLD') item.retainedGenuineCreators++;
    } else {
      item.nonTradingCreators++;
      if (result.decision === 'WITHHOLD') item.withheldNonTradingCreators++;
    }
  }

  const excludedExamples = [...(input.excludedExamples || [])].sort((left, right) => left.exampleKey.localeCompare(right.exampleKey));
  const minimumEffectiveSampleSize = 30, minimumGenuineCreatorRecall = .95, minimumHistoricalEvidenceEligibility = .9;
  const assessmentReasons: string[] = [];
  const sealedExampleCount = results.length + excludedExamples.length, historicalEvidenceEligibility = ratio(results.length, sealedExampleCount);
  if (historicalEvidenceEligibility === null || historicalEvidenceEligibility < minimumHistoricalEvidenceEligibility) assessmentReasons.push('HISTORICAL_CREATOR_EVIDENCE_COVERAGE_INSUFFICIENT');
  if (effectiveSampleSize(baselineFalsePositives, examplesByKey) < minimumEffectiveSampleSize) assessmentReasons.push('NON_TRADING_EFFECTIVE_SAMPLE_SIZE_INSUFFICIENT');
  if (effectiveSampleSize(genuine, examplesByKey) < minimumEffectiveSampleSize) assessmentReasons.push('GENUINE_CREATOR_EFFECTIVE_SAMPLE_SIZE_INSUFFICIENT');
  const genuineRecall = ratio(retainedGenuineWeight, genuineWeight), falsePositiveReduction = ratio(withheldNonTradingWeight, baselineFalsePositiveWeight);
  const assessmentOutcome = assessmentReasons.length ? 'INSUFFICIENT_EVIDENCE' as const
    : (genuineRecall !== null && genuineRecall >= minimumGenuineCreatorRecall && falsePositiveReduction !== null && falsePositiveReduction > 0 ? 'SUPPORTED' as const : 'NOT_SUPPORTED' as const);
  if (!assessmentReasons.length && (genuineRecall === null || genuineRecall < minimumGenuineCreatorRecall)) assessmentReasons.push('GENUINE_CREATOR_RECALL_BELOW_FLOOR');
  if (!assessmentReasons.length && (falsePositiveReduction === null || falsePositiveReduction <= 0)) assessmentReasons.push('NO_FALSE_POSITIVE_REDUCTION_OBSERVED');
  const inputChecksum = offlineAdmissionChecksum({ dataset: input.dataset, examples, excludedExamples, policyVersion: OFFLINE_ADMISSION_V2_POLICY_VERSION });
  const unsigned = {
    reportVersion: OFFLINE_ADMISSION_V2_REPORT_VERSION,
    policyVersion: OFFLINE_ADMISSION_V2_POLICY_VERSION,
    dataset: input.dataset,
    generatedFromImmutableHistory: true as const,
    servingAuthority: false as const,
    automaticPromotion: false as const,
    hypothesisAssessment: { outcome: assessmentOutcome, reasonCodes: assessmentReasons, minimumEffectiveSampleSize, minimumGenuineCreatorRecall, minimumHistoricalEvidenceEligibility },
    methodology: {
      propensityWeighted: true as const,
      falsePositiveBaseline: 'Ground-truth NON_TRADING examples whose legacy production status was not NON_TRADING or HUMAN_REJECTED.',
      enrichmentBaseline: 'Legacy production UNCERTAIN or NEEDS_REVIEW examples; this is a projected unresolved-work proxy, not observed job execution.',
      reviewBaseline: 'Legacy production UNCERTAIN or NEEDS_REVIEW examples; this is a projected review-work proxy, not observed review materialization.',
      retentionDefinition: 'A genuine creator is retained by ADMIT_CONFIRMED, ADMIT_REVIEW, or DEFER_INVESTIGATION; only WITHHOLD is a recall loss.'
    },
    evaluatedExamples: results.length,
    excludedExamples,
    decisionCounts: counts,
    metrics: {
      historicalEvidenceEligibility: { sealedExamples: sealedExampleCount, evaluatedExamples: results.length, excludedExamples: excludedExamples.length, rate: historicalEvidenceEligibility },
      falsePositiveReduction: { baselineFalsePositiveBurden: baselineFalsePositiveWeight, withheldNonTrading: withheldNonTradingWeight, rate: falsePositiveReduction, effectiveSampleSize: effectiveSampleSize(baselineFalsePositives, examplesByKey) },
      genuineCreatorRecall: { genuineCreators: genuineWeight, retainedCreators: retainedGenuineWeight, rate: genuineRecall, confirmedCreators: confirmedGenuineWeight, confirmedRate: ratio(confirmedGenuineWeight, genuineWeight), effectiveSampleSize: effectiveSampleSize(genuine, examplesByKey) },
      projectedEnrichmentReduction: { baselineEligible: enrichmentBaselineWeight, avoided: enrichmentAvoidedWeight, rate: ratio(enrichmentAvoidedWeight, enrichmentBaselineWeight) },
      projectedReviewWorkloadReduction: { baselineEligible: reviewBaselineWeight, proposedReview: proposedReviewWeight, avoided: reviewBaselineWeight - proposedReviewWeight, rate: ratio(reviewBaselineWeight - proposedReviewWeight, reviewBaselineWeight) }
    },
    segments: Object.fromEntries(Object.entries(segmentRows).sort(([left], [right]) => left.localeCompare(right))),
    results,
    inputChecksum
  };
  return { ...unsigned, outputChecksum: offlineAdmissionChecksum(unsigned) };
}
