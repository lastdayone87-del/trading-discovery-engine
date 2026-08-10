import { ALTERNATIVE_FOCUS_HYPOTHESES, TRADING_FOCUS_HYPOTHESES } from '../evidenceEngine/hypothesisTaxonomy';
import {
  evaluateOfflineAdmissionV2,
  type OfflineAdmissionExample,
  type OfflineAdmissionV2Result
} from './offlineV2';

export const STAGE1_ADMISSION_POLICY_VERSION = 'creator-admission-stage1-hypothesis-capable-1';

const mass = (example: OfflineAdmissionExample, hypotheses: readonly string[]): number =>
  hypotheses.reduce((total, hypothesis) => total + Number(
    example.creatorFocusDistribution[hypothesis as keyof typeof example.creatorFocusDistribution] || 0
  ), 0);

/**
 * Stage 1 counterfactual admission policy.
 *
 * This policy is deliberately non-serving. It strengthens the existing offline
 * Admission V2 policy in two ways:
 *  - ADMIT_REVIEW requires a creator-level trading hypothesis to be both
 *    plausible and stronger than the aggregate alternative-focus hypothesis.
 *  - WITHHOLD can be reached from dominant affirmative alternative-focus
 *    evidence without requiring the legacy proposedStatus to already be
 *    NON_TRADING. That legacy dependency made Stage 0 unable to measure
 *    withholding even when creator-level alternative evidence was decisive.
 *
 * Coverage, language, recency and source-family gates remain mandatory.
 */
export function evaluateStage1Admission(example: OfflineAdmissionExample): OfflineAdmissionV2Result {
  const baseline = evaluateOfflineAdmissionV2(example);
  const tradingMass = mass(example, TRADING_FOCUS_HYPOTHESES);
  const alternativeMass = mass(example, ALTERNATIVE_FOCUS_HYPOTHESES);

  const capabilityReady =
    example.coverage.disposition === 'SUFFICIENT' &&
    example.coverage.observedDocumentCount >= 2 &&
    example.coverage.independentFamilyCount >= 2 &&
    baseline.creatorFocus.supportedLanguage &&
    baseline.creatorFocus.recentEvidence;

  const dominantAlternative =
    capabilityReady &&
    alternativeMass >= 0.8 &&
    tradingMass < 0.2 &&
    alternativeMass >= tradingMass * 4;

  const plausibleTradingHypothesis =
    capabilityReady &&
    tradingMass >= 0.35 &&
    tradingMass > alternativeMass;

  if (dominantAlternative) {
    return {
      ...baseline,
      decision: 'WITHHOLD',
      reasonCodes: ['DOMINANT_ALTERNATIVE_CREATOR_FOCUS', 'AFFIRMATIVE_NON_TRADING_EVIDENCE'],
      reasoning: [
        ...baseline.reasoning.slice(0, -1),
        `Stage 1 counterfactual decision WITHHOLD: alternative creator focus ${alternativeMass.toFixed(4)} dominates trading focus ${tradingMass.toFixed(4)}.`
      ],
      policyVersion: STAGE1_ADMISSION_POLICY_VERSION,
      servingAuthority: false
    };
  }

  if (baseline.decision === 'ADMIT_REVIEW' && !plausibleTradingHypothesis) {
    return {
      ...baseline,
      decision: 'DEFER_INVESTIGATION',
      reasonCodes: ['TRADING_HYPOTHESIS_NOT_YET_PLAUSIBLE', 'ALTERNATIVE_FOCUS_NOT_EXCLUDED'],
      reasoning: [
        ...baseline.reasoning.slice(0, -1),
        `Stage 1 counterfactual decision DEFER_INVESTIGATION: trading focus ${tradingMass.toFixed(4)} is not stronger than alternative focus ${alternativeMass.toFixed(4)}.`
      ],
      policyVersion: STAGE1_ADMISSION_POLICY_VERSION,
      servingAuthority: false
    };
  }

  return { ...baseline, policyVersion: STAGE1_ADMISSION_POLICY_VERSION, servingAuthority: false };
}
