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
 * Genuine Beta-distributed draw via the posterior inverse CDF applied to a
 * deterministic uniform derived from the inputs (replay-safe, no Math.random).
 * Same inputs always yield the same draw; distinct salts yield distinct draws.
 * Prior alpha0/beta0 are E (pilot); selection among arms uses max sample.
 */
export function thompsonSample(successes: number, failures: number, salt: string, alpha0 = 1, beta0 = 1): number {
  if (successes < 0 || failures < 0 || !Number.isFinite(successes) || !Number.isFinite(failures)) {
    throw new Error('INVALID_ARM_COUNTS');
  }
  if (alpha0 <= 0 || beta0 <= 0 || !Number.isFinite(alpha0) || !Number.isFinite(beta0)) throw new Error('INVALID_PRIOR');
  if (!salt.trim()) throw new Error('SALT_REQUIRED');
  const alpha = alpha0 + successes;
  const beta = beta0 + failures;
  const u = deterministicUniform(`${ALLOCATION_CHALLENGER_VERSION}:thompson:${salt}:${successes}:${failures}:${alpha0}:${beta0}`);
  return betaQuantile(u, alpha, beta);
}

/** Lanczos log-gamma for positive arguments (reflection for z < 0.5). Pure. */
function logGamma(z: number): number {
  const lanczos = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  z -= 1;
  let x = lanczos[0];
  for (let i = 1; i < 9; i++) x += lanczos[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/** Continued fraction for the incomplete beta function (Numerical Recipes betacf). Pure. */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const maxIterations = 200;
  const epsilon = 3e-12;
  const fpmin = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < fpmin) d = fpmin;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= maxIterations; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpmin) d = fpmin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpmin) c = fpmin;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpmin) d = fpmin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpmin) c = fpmin;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < epsilon) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b) for a, b > 0. Pure. */
function regularizedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const logBeta = logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  const front = Math.exp(logBeta);
  if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(a, b, x)) / a;
  return 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

/**
 * Inverse regularized incomplete beta (Beta quantile) by bisection.
 * Deterministic to ~1e-9; monotone in p for fixed shape.
 */
function betaQuantile(p: number, a: number, b: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (regularizedBeta(mid, a, b) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Select best arm index by Thompson sample. Pure.
 * The prior defaults to alpha0=1/beta0=1 (uniform); callers with an explicit
 * experimental prior pass it through so selection and persisted provenance
 * describe the exact same computation. The sampling algorithm itself is
 * unchanged regardless of prior.
 */
export function selectThompsonArm(
  arms: Array<{ successes: number; failures: number }>,
  opportunityKey: string,
  prior: { alpha0?: number; beta0?: number } = {}
): number {
  if (!arms.length) throw new Error('NO_ARMS');
  if (!opportunityKey.trim()) throw new Error('OPPORTUNITY_KEY_REQUIRED');
  const alpha0 = prior.alpha0 ?? 1;
  const beta0 = prior.beta0 ?? 1;
  let best = 0;
  let bestScore = -Infinity;
  arms.forEach((arm, index) => {
    const score = thompsonSample(arm.successes, arm.failures, `${opportunityKey}:${index}`, alpha0, beta0);
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
