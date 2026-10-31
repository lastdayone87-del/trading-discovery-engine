import type { ArmPosterior, DecayedArmCounts, HierarchicalPrior } from './types';

export const QUERY_POSTERIOR_VERSION = 'gamma-poisson-hierarchy-v1';
export const SELECTOR_POLICY_VERSION = 'hierarchical-ucb-v1';
export const SELECTOR_C = 2.0;
export const PORTFOLIO_RATIO = 0.15;
export const DECAY_HALF_LIFE_DAYS = 30;
export const MIN_SELECTION_SAMPLE = 2;
export const MAX_SELECTION_INDEX = 4.0;

/** Partial-pooling weights (documented prior, not tuned live). */
export const HIERARCHY_WEIGHTS = {
  global: 0.20,
  family: 0.35,
  country: 0.20,
  market: 0.15,
  language: 0.10,
} as const;

/** Empirical-Bayes smoothing applied to each stratum rate. */
const HIERARCHY_SMOOTHING = 2.0;

const EPSILON = 1e-9;

export function decayWeight(ageDays: number, halfLifeDays = DECAY_HALF_LIFE_DAYS): number {
  return Math.pow(0.5, Math.max(0, ageDays) / Math.max(1, halfLifeDays));
}

export function decayArmCounts(
  rows: Array<{ confirmed: number; quality: number; quotaUnits: number; ageDays: number }>,
  halfLifeDays = DECAY_HALF_LIFE_DAYS,
): DecayedArmCounts {
  let confirmed = 0, quality = 0, quotaUnits = 0, runs = 0;
  for (const row of rows) {
    const weight = decayWeight(row.ageDays, halfLifeDays);
    confirmed += Math.max(0, row.confirmed) * weight;
    quality += Math.max(0, row.quality) * weight;
    quotaUnits += Math.max(0, row.quotaUnits) * weight;
    runs += 1;
  }
  return { confirmed, quality, quotaUnits, runs };
}

function otherCounts(stratum: DecayedArmCounts | undefined, own: DecayedArmCounts): DecayedArmCounts {
  return {
    confirmed: Math.max(0, (stratum?.confirmed || 0) - own.confirmed),
    quality: Math.max(0, (stratum?.quality || 0) - own.quality),
    quotaUnits: Math.max(0, (stratum?.quotaUnits || 0) - own.quotaUnits),
    runs: Math.max(0, (stratum?.runs || 0) - own.runs),
  };
}

export interface HierarchyCounts {
  /** Portfolio-wide totals; the global stratum of the partial pooling. */
  total?: DecayedArmCounts;
  family?: DecayedArmCounts;
  country?: DecayedArmCounts;
  market?: DecayedArmCounts;
  language?: DecayedArmCounts;
}

export function empiricalPrior(arms: DecayedArmCounts[], fallbackMean = 0.05, strength = 2): HierarchicalPrior {
  const totalConfirmed = arms.reduce((sum, arm) => sum + Math.max(0, arm.confirmed), 0);
  const totalQuota = arms.reduce((sum, arm) => sum + Math.max(0, arm.quotaUnits), 0);
  const mean = totalQuota > 0 ? totalConfirmed / totalQuota : fallbackMean;
  return { mean: Math.max(0, mean), strength: Math.max(0.5, strength) };
}

function lnGamma(value: number): number {
  const coefficients = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let x = value;
  let y = value;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const coefficient of coefficients) ser += coefficient / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

function regularizedGammaP(shape: number, x: number): number {
  if (x <= 0) return 0;
  if (shape <= 0) return 1;
  if (x < shape + 1) {
    let sum = 1 / shape;
    let term = sum;
    let n = shape;
    for (let iteration = 0; iteration < 300; iteration++) {
      n += 1;
      term *= x / n;
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-14) break;
    }
    return sum * Math.exp(-x + shape * Math.log(x) - lnGamma(shape));
  }
  // Continued fraction for Q, then P = 1 - Q.
  let b = x + 1 - shape;
  let c = 1 / 1e-300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= 300; i++) {
    const an = -i * (i - shape);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-14) break;
  }
  const q = Math.exp(-x + shape * Math.log(x) - lnGamma(shape)) * h;
  return Math.max(0, Math.min(1, 1 - q));
}

/** Inverse regularized lower incomplete gamma via deterministic bisection. */
export function inverseRegularizedGammaP(shape: number, p: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return Number.POSITIVE_INFINITY;
  if (shape <= 0) return 0;
  let low = 0;
  let high = Math.max(1, shape);
  while (regularizedGammaP(shape, high) < p && high < 1e9) high *= 2;
  for (let iteration = 0; iteration < 80; iteration++) {
    const mid = (low + high) / 2;
    if (regularizedGammaP(shape, mid) < p) low = mid;
    else high = mid;
    if (high - low < Math.max(1e-10, high * 1e-12)) break;
  }
  return (low + high) / 2;
}

/** Quantile of Gamma(shape=alpha, rate=beta) in creators per 100 quota. */
export function gammaQuantile(alpha: number, beta: number, probability: number): number {
  if (alpha <= 0 || beta <= 0) return 0;
  return inverseRegularizedGammaP(alpha, probability) / beta;
}

export function computePosterior(
  counts: DecayedArmCounts,
  prior: HierarchicalPrior,
  hierarchy: HierarchyCounts = {},
  c = SELECTOR_C,
  maxIndex = MAX_SELECTION_INDEX,
): ArmPosterior {
  const total = otherCounts(hierarchy.total, counts);
  const family = otherCounts(hierarchy.family, counts);
  const country = otherCounts(hierarchy.country, counts);
  const market = otherCounts(hierarchy.market, counts);
  const language = otherCounts(hierarchy.language, counts);

  // Empirical-Bayes partial pooling in rate space. Pooling counts additively
  // lets a globally strong family dominate every country (rich-get-richer);
  // averaging the log stratum rates keeps transfer informative without
  // letting one family crowd out the portfolio. Each stratum is smoothed
  // toward the global rate, then the global/family/country/market/language
  // log-rates are combined by the documented weights.
  const globalRate = (total.confirmed + prior.mean * prior.strength) / Math.max(EPSILON, total.quotaUnits + prior.strength);
  const rateOf = (stratum: DecayedArmCounts): number =>
    (stratum.confirmed + HIERARCHY_SMOOTHING * globalRate) / Math.max(EPSILON, stratum.quotaUnits + HIERARCHY_SMOOTHING);
  const weights = HIERARCHY_WEIGHTS;
  const weightTotal = weights.global + weights.family + weights.country + weights.market + weights.language;
  const logPrior = (
    weights.global * Math.log(Math.max(EPSILON, globalRate))
    + weights.family * Math.log(Math.max(EPSILON, rateOf(family)))
    + weights.country * Math.log(Math.max(EPSILON, rateOf(country)))
    + weights.market * Math.log(Math.max(EPSILON, rateOf(market)))
    + weights.language * Math.log(Math.max(EPSILON, rateOf(language)))
  ) / weightTotal;
  const priorMean = Math.exp(logPrior);

  const alpha = Math.max(EPSILON, priorMean * prior.strength + counts.confirmed);
  const beta = Math.max(EPSILON, prior.strength + counts.quotaUnits);

  const mean = alpha / beta;
  const sd = Math.sqrt(alpha) / beta;
  return {
    alpha,
    beta,
    mean,
    sd,
    lcb: gammaQuantile(alpha, beta, 0.05),
    ucb: Math.min(maxIndex, mean + c * sd),
    sample: counts.runs,
  };
}

/** Quality/promotion score: lower confidence bound, not the optimistic index. */
export function promotionQualityScore(posterior: ArmPosterior): number {
  return posterior.lcb;
}

/** Deterministic RNG for the offline TS comparator only (no serving RNG). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Marsaglia–Tsang Gamma sampler. Offline evaluation comparator only. */
export function sampleGamma(shape: number, rate: number, rng: () => number): number {
  if (shape <= 0 || rate <= 0) return 0;
  if (shape < 1) {
    const u = Math.max(Number.EPSILON, rng());
    return sampleGamma(shape + 1, rate, rng) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let attempt = 0; attempt < 100; attempt++) {
    let x = 0, v = 0;
    do {
      const u1 = Math.max(Number.EPSILON, rng());
      const u2 = rng();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return (d * v) / rate;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return (d * v) / rate;
  }
  return shape / rate;
}

export function thompsonSample(posterior: ArmPosterior, rng: () => number): number {
  return sampleGamma(posterior.alpha, posterior.beta, rng);
}
