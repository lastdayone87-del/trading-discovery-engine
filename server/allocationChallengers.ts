/**
 * P4 allocation challengers (EXPERIMENTAL testability, shadow-only).
 * Pure, deterministic, DB-free. Thompson Sampling (Beta-Bernoulli) and a
 * minimal contextual linear scorer sit BESIDE the UCB1 control in
 * queryIntelligence.ts:363-376 — that control is UNCHANGED. No serving
 * writes, no propensity mutation here; callers log arm + propensity to
 * existing JSONB metadata (allocationProbability-compatible) for IPW.
 * Classification: harness = CORE-adjacent testability; priors/weights = E;
 * assignment ratios/margins = B/D (experiment metadata, never production).
 */
import { createHash } from 'node:crypto';

export const ALLOCATION_CHALLENGER_VERSION = 'allocation-challenger-v1';

function deterministicUniform(key: string): number {
  const digest = createHash('sha256').update(key).digest('hex');
  return Number.parseInt(digest.slice(0, 8), 16) / 0xffffffff;
}

/**
 * Thompson sample for a Bernoulli arm with Beta(alpha0+s, beta0+f) posterior.
 * Deterministic via hashed uniform -> inverse-CDF-free quantile transform
 * approximated by sorted-hash sampling (replay-safe, no Math.random).
 * Prior alpha0/beta0 are E (pilot); selection among arms uses max sample.
 */
export function thompsonSample(successes: number, failures: number, salt: string, alpha0 = 1, beta0 = 1): number {
  if (successes < 0 || failures < 0 || !Number.isFinite(successes) || !Number.isFinite(failures)) {
    throw new Error('INVALID_ARM_COUNTS');
  }
  if (alpha0 <= 0 || beta0 <= 0) throw new Error('INVALID_PRIOR');
  // Deterministic pseudo-posterior draw: mean + spread-scaled hashed deviate.
  // Exact Beta quantile is unnecessary for challenger ranking tests; the
  // live experiment uses the same deterministic draw for replay.
  const alpha = alpha0 + successes;
  const beta = beta0 + failures;
  const mean = alpha / (alpha + beta);
  const variance = (alpha * beta) / ((alpha + beta) * (alpha + beta) * (alpha + beta + 1));
  const u = deterministicUniform(`${ALLOCATION_CHALLENGER_VERSION}:thompson:${salt}:${successes}:${failures}:${alpha0}:${beta0}`);
  const deviate = (u - 0.5) * 2; // [-1,1]
  return mean + deviate * Math.sqrt(variance);
}

/** Select best arm index by Thompson sample. Pure. */
export function selectThompsonArm(arms: Array<{ successes: number; failures: number }>, opportunityKey: string): number {
  if (!arms.length) throw new Error('NO_ARMS');
  if (!opportunityKey.trim()) throw new Error('OPPORTUNITY_KEY_REQUIRED');
  let best = 0;
  let bestScore = -Infinity;
  arms.forEach((arm, index) => {
    const score = thompsonSample(arm.successes, arm.failures, `${opportunityKey}:${index}`);
    if (score > bestScore) {
      bestScore = score;
      best = index;
    }
  });
  return best;
}

export interface ContextualArmFeatures {
  expectedValue: number;
  uncertainty: number;
  coverageGap: number;
  cost: number;
}

/**
 * Minimal contextual score: value + uncertainty/coverage bonus - cost penalty.
 * Weights are E (pilot, determined by experiment), NOT architecture.
 * Exists to test whether cell context beats non-contextual UCB1/Thompson.
 */
export function contextualArmScore(
  features: ContextualArmFeatures,
  weights: { value?: number; exploration?: number; cost?: number } = {},
): number {
  const w = { value: weights.value ?? 0.5, exploration: weights.exploration ?? 0.35, cost: weights.cost ?? 0.1 };
  if (!Number.isFinite(features.expectedValue) || !Number.isFinite(features.uncertainty) || !Number.isFinite(features.coverageGap) || !Number.isFinite(features.cost)) {
    throw new Error('INVALID_ARM_FEATURES');
  }
  return features.expectedValue * w.value + (features.uncertainty + features.coverageGap) * w.exploration - features.cost * w.cost;
}
