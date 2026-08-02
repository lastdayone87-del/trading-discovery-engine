import { researchChecksum, type ContextualChoice } from './persistentResearch';

export const PERSISTENT_RESEARCH_PHASE6_VERSION = 'persistent-research-phase6-v2';

export interface LoggedPolicyOutcome {
  actionId: string;
  assignmentId: string;
  behaviorPropensityBasisPoints: number;
  reward: number;
  providerCost: number;
  reviewCost: number;
}

export interface PolicySample {
  actionId: string;
  supported: boolean;
  targetSelected: boolean;
  targetPropensityBasisPoints: number;
  behaviorPropensityBasisPoints: number;
  reward: number;
  providerCost: number;
  reviewCost: number;
  overlapPenalty: number;
  country?: string;
  language?: string;
}

export function protectedExplorationBucket(actionId: string, policyKey: string, basisPoints: number) {
  if (basisPoints < 0 || basisPoints > 5000) throw new Error('INVALID_PROTECTED_EXPLORATION_RATE');
  const bucket = Number.parseInt(researchChecksum({ actionId, policyKey, version: PERSISTENT_RESEARCH_PHASE6_VERSION }).slice(0, 8), 16) % 10000;
  return { included: bucket < basisPoints, bucket, propensityBasisPoints: basisPoints };
}

function summarize(samples: PolicySample[]) {
  const unsupported = samples.filter(sample => sample.targetSelected && !sample.supported).length;
  const supported = samples.filter(sample => sample.supported && sample.behaviorPropensityBasisPoints > 0);
  const weighted = supported.map(sample => {
    const targetProbability = sample.targetSelected ? sample.targetPropensityBasisPoints / 10000 : 0;
    const behaviorProbability = sample.behaviorPropensityBasisPoints / 10000;
    const weight = targetProbability / behaviorProbability;
    const net = (sample.reward * (1 - sample.overlapPenalty)) / Math.max(1, sample.providerCost + sample.reviewCost);
    return { weight, value: net, segment: `${sample.country || 'Unknown'}\u001f${sample.language || 'und'}` };
  }).filter(item => item.weight > 0);
  const sumW = weighted.reduce((n, x) => n + x.weight, 0);
  const sumW2 = weighted.reduce((n, x) => n + x.weight * x.weight, 0);
  const mean = sumW ? weighted.reduce((n, x) => n + x.value * x.weight, 0) / sumW : 0;
  const variance = sumW ? weighted.reduce((n, x) => n + x.weight * Math.pow(x.value - mean, 2), 0) / sumW : 0;
  const effectiveSampleSize = sumW2 ? sumW * sumW / sumW2 : 0;
  const se = Math.sqrt(variance / Math.max(1, effectiveSampleSize));
  const segments = new Map<string, { n: number; weightedReward: number; weight: number }>();
  for (const item of weighted) {
    const current = segments.get(item.segment) || { n: 0, weightedReward: 0, weight: 0 };
    current.n++;
    current.weight += item.weight;
    current.weightedReward += item.value * item.weight;
    segments.set(item.segment, current);
  }
  return {
    assignments: samples.length,
    supportedAssignments: supported.length,
    unsupportedTargetActions: unsupported,
    effectiveSampleSize,
    mean,
    confidenceInterval: { lower: mean - 1.96 * se, upper: mean + 1.96 * se },
    segments: Object.fromEntries([...segments].sort().map(([key, value]) => [key, { sampleSize: value.n, mean: value.weightedReward / value.weight }]))
  };
}

export function evaluateCounterfactualPolicy(candidate: PolicySample[], baseline: PolicySample[], minimumEffectiveSampleSize = 30) {
  if (!Number.isInteger(minimumEffectiveSampleSize) || minimumEffectiveSampleSize < 1) throw new Error('INVALID_MINIMUM_ASSIGNMENTS');
  const c = summarize(candidate), b = summarize(baseline);
  const unsupported = c.unsupportedTargetActions > 0 || b.unsupportedTargetActions > 0;
  const segmentKeys = [...new Set([...Object.keys(c.segments), ...Object.keys(b.segments)])].sort();
  const segmentGuardrails = Object.fromEntries(segmentKeys.map(key => {
    const cs = c.segments[key], bs = b.segments[key], enough = !!cs && !!bs && cs.sampleSize >= 5 && bs.sampleSize >= 5;
    return [key, { pass: enough && cs.mean >= bs.mean * .8, reason: enough ? 'RELATIVE_YIELD_CHECK' : 'INSUFFICIENT_SEGMENT_EVIDENCE', candidate: cs || null, baseline: bs || null }];
  }));
  const segmentsPass = segmentKeys.length > 0 && Object.values(segmentGuardrails).every(item => item.pass);
  const enough = c.effectiveSampleSize >= minimumEffectiveSampleSize && b.effectiveSampleSize >= minimumEffectiveSampleSize;
  const improves = c.confidenceInterval.lower > b.confidenceInterval.upper;
  const decision: 'PASS' | 'FAIL' | 'ABSTAIN' = unsupported || !enough || !segmentKeys.length ? 'ABSTAIN' : improves && segmentsPass ? 'PASS' : 'FAIL';
  const reasonCodes = unsupported ? ['COUNTERFACTUAL_SUPPORT_REQUIRED'] : !enough ? ['INSUFFICIENT_EFFECTIVE_SAMPLE_SIZE'] : !segmentKeys.length ? ['SEGMENT_EVIDENCE_REQUIRED'] : decision === 'PASS' ? ['COUNTERFACTUAL_LOWER_BOUND_POSITIVE', 'SEGMENT_GUARDRAILS_PASS', 'LOGGED_BEHAVIOR_IPS'] : ['COUNTERFACTUAL_OR_SEGMENT_GATE_FAILED'];
  return { candidate: c, baseline: b, incrementalDifference: c.mean - b.mean, confidenceInterval: { lower: c.confidenceInterval.lower - b.confidenceInterval.upper, upper: c.confidenceInterval.upper - b.confidenceInterval.lower }, segmentGuardrails, decision, reasonCodes };
}

export function replayDecisionRows(choices: ContextualChoice[], logged: Map<string, LoggedPolicyOutcome>, arm: 'CANDIDATE' | 'BASELINE') {
  return choices.map(choice => {
    const observation = logged.get(choice.actionId);
    const supported = !!observation;
    return {
      decisionKey: researchChecksum({ actionId: choice.actionId, arm, policy: PERSISTENT_RESEARCH_PHASE6_VERSION }), arm,
      actionId: choice.actionId, assignmentId: observation?.assignmentId || null, supported,
      selected: choice.selected, targetPropensityBasisPoints: choice.selected ? choice.propensityBasisPoints : 0,
      behaviorPropensityBasisPoints: observation?.behaviorPropensityBasisPoints || 0,
      utility: choice.utility, reward: observation?.reward ?? null, providerCost: observation?.providerCost ?? choice.providerCost,
      reviewCost: observation?.reviewCost ?? choice.reviewCost, overlapCorrection: 1 - choice.overlapPenalty,
      coordinates: choice.coordinates, reasonCodes: [...choice.reasonCodes, supported ? 'LOGGED_BEHAVIOR_SUPPORT' : 'NO_LOGGED_BEHAVIOR_SUPPORT']
    };
  });
}
