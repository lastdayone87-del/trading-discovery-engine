import {
  computePosterior,
  empiricalPrior,
  mulberry32,
  SELECTOR_C,
  thompsonSample,
  type HierarchyCounts,
} from './posterior';
import type { DecayedArmCounts, HierarchicalPrior } from './types';

/**
 * Deterministic offline selector comparison. This is an evaluation harness,
 * not a serving path: no production data, no network, no shadow arm. It keeps
 * the corrected Gamma–Poisson Thompson sampler available as a falsifiable
 * comparator while hierarchical UCB remains the serving authority.
 */
export const SELECTOR_SIMULATION_VERSION = 'query-selector-simulation-v1';

export type SimulationScenario =
  | 'sparse'
  | 'medium'
  | 'rich'
  | 'cold_start'
  | 'cold_countries'
  | 'non_stationary'
  | 'depletion'
  | 'many_arms';

export type SimulatedSelector = 'current_ucb1' | 'hierarchical_ucb_c1' | 'hierarchical_ucb_c2' | 'independent_ts' | 'hierarchical_ts';

export interface SimulationConfig {
  scenario: SimulationScenario;
  seeds: number;
  pulls: number;
  countries?: number;
  portfolioRatio?: number;
  c?: number;
}

interface SimArm {
  id: number;
  country: number;
  family: number;
  market: number;
  language: number;
  lambda: number;
  /** Optional post-regime rate; null keeps the stationary rate. */
  shiftRate: number | null;
  poolRemaining: number;
  confirmed: number;
  quotaUnits: number;
  pulls: number;
  lastRate: number;
}

interface CountrySimState {
  arms: SimArm[];
  cursor: number;
  /**
   * Finite, shared creator pool. A creator surfaced by one arm is no longer
   * globally new for another arm, so exploring low-yield arms burns the same
   * pool as concentrating on the best arm. Without this overlap the harness
   * rewards indiscriminate exploration and cannot reproduce the depletion
   * stress the plan asks about.
   */
  poolRemaining: number;
}

export interface SimulationMetrics {
  selector: SimulatedSelector;
  scenario: SimulationScenario;
  yields: number[];
  meanYield: number;
  coverage: number;
  zeroYieldShare: number;
  distinctArms: number;
  top10Share: number;
  maxFamilyShare: number;
  maxCountryShare: number;
}

const MAX_COUNTRIES = 16;
/** Tested family concentration cap, applied equally to every selector. */
const SIM_FAMILY_SHARE_CAP = 0.15;

function scenarioParameters(scenario: SimulationScenario) {
  // Composition families are global, not per-country, and the hierarchy is
  // only meaningful when the true rates actually share family/country effects.
  // These parameters mirror the preregistered scenario set: 15 families (24 in
  // the many-arm stress) with one or two surfaces per family/country.
  switch (scenario) {
    case 'sparse': return { armsPerCountry: 20, families: 15, baseRate: 0.35, familySd: 0.75, countrySd: 0.40, armSd: 0.55, zeroFraction: 0.20, pool: 40, stationary: true, depletion: false };
    case 'medium': return { armsPerCountry: 20, families: 15, baseRate: 0.75, familySd: 0.65, countrySd: 0.30, armSd: 0.45, zeroFraction: 0.10, pool: 60, stationary: true, depletion: false };
    case 'rich': return { armsPerCountry: 20, families: 15, baseRate: 1.50, familySd: 0.55, countrySd: 0.25, armSd: 0.40, zeroFraction: 0.05, pool: 100, stationary: true, depletion: false };
    case 'cold_start': return { armsPerCountry: 20, families: 15, baseRate: 0.75, familySd: 0.65, countrySd: 0.45, armSd: 0.45, zeroFraction: 0.10, pool: 60, stationary: true, depletion: false };
    case 'cold_countries': return { armsPerCountry: 20, families: 15, baseRate: 0.75, familySd: 0.55, countrySd: 0.80, armSd: 0.45, zeroFraction: 0.15, pool: 60, stationary: true, depletion: false };
    case 'non_stationary': return { armsPerCountry: 20, families: 15, baseRate: 0.75, familySd: 0.65, countrySd: 0.30, armSd: 0.45, zeroFraction: 0.10, pool: 80, stationary: false, depletion: false };
    case 'depletion': return { armsPerCountry: 20, families: 15, baseRate: 0.75, familySd: 0.65, countrySd: 0.30, armSd: 0.45, zeroFraction: 0.10, pool: 10, stationary: true, depletion: true };
    case 'many_arms': return { armsPerCountry: 30, families: 24, baseRate: 0.75, familySd: 0.65, countrySd: 0.30, armSd: 0.45, zeroFraction: 0.10, pool: 60, stationary: true, depletion: false };
  }
}

/** Standard normal draw from the deterministic PRNG (Box–Muller). */
function normal(rng: () => number): number {
  const u1 = Math.max(Number.EPSILON, rng());
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function buildWorld(config: SimulationConfig, seed: number): CountrySimState[] {
  const params = scenarioParameters(config.scenario);
  const countries = Math.min(MAX_COUNTRIES, config.countries || MAX_COUNTRIES);
  const rng = mulberry32(seed * 7919 + 17);
  const familyEffects = Array.from({ length: params.families }, () => normal(rng) * params.familySd);
  const countryEffects = Array.from({ length: countries }, () => normal(rng) * params.countrySd);
  const arms = new Map<number, SimArm[]>();
  for (let country = 0; country < countries; country++) {
    const list: SimArm[] = [];
    for (let family = 0; family < params.families; family++) {
      // Exactly armsPerCountry arms: one or two surfaces per family, with the
      // remainder assigned to the first families (20/15 -> 5x2 + 10x1).
      const armCount = Math.floor(params.armsPerCountry / params.families)
        + (family < params.armsPerCountry % params.families ? 1 : 0);
      for (let index = 0; index < armCount; index++) {
        const id = country * 1000 + family * 10 + index;
        const armEffect = normal(rng) * params.armSd;
        const lambda = rng() < params.zeroFraction
          ? 0
          : Math.min(5, Math.max(0.01, params.baseRate * Math.exp(familyEffects[family] + countryEffects[country] + armEffect)));
        const shiftRoll = rng();
        const shiftRate = params.stationary || lambda <= 0
          ? null
          : shiftRoll < 0.15
            ? Math.max(0.01, lambda * (shiftRoll < 0.05 ? 0.25 : shiftRoll < 0.10 ? 0.35 : 2.2))
            : null;
        list.push({
          id,
          country,
          family,
          market: family % 3,
          language: country % 2,
          lambda,
          shiftRate,
          poolRemaining: Math.max(2, Math.round(params.pool * (0.5 + rng()))),
          confirmed: 0,
          quotaUnits: 0,
          pulls: 0,
          lastRate: 0,
        });
      }
    }
    arms.set(country, list);
  }
  return Array.from({ length: countries }, (_, country) => {
    const countryArms = arms.get(country) || [];
    // Each arm contributes its own realistic reachable pool, but the country
    // pool is the union of creator identities. Shared overlap is approximated
    // by consuming the same finite pool from every arm.
    return {
      arms: countryArms,
      cursor: 0,
      // Depletion is a single shared pool: creator identities exhaust fast and
      // indiscriminate exploration spends the same finite pool as the best arm.
      // Other scenarios keep each arm's reachable pool additive so 1500 pulls
      // do not trivially exhaust every country.
      poolRemaining: params.depletion
        ? params.pool
        : countryArms.reduce((sum, arm) => sum + arm.poolRemaining, 0),
    };
  });
}

function poisson(lambda: number, rng: () => number): number {
  if (lambda <= 0) return 0;
  if (lambda > 30) {
    // Normal approximation for large means.
    const u1 = Math.max(Number.EPSILON, rng());
    const u2 = rng();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * z));
  }
  const limit = Math.exp(-lambda);
  let p = 1;
  let k = 0;
  do {
    k++;
    p *= rng();
  } while (p > limit);
  return k - 1;
}

function armCounts(arm: SimArm): DecayedArmCounts {
  return { confirmed: arm.confirmed, quality: arm.confirmed * 0.8, quotaUnits: arm.quotaUnits, runs: arm.pulls };
}

/**
 * Incremental hierarchy totals. The original harness recomputed all strata for
 * every candidate on every pull, which made the 100-seed × 1500-pull matrix
 * quadratic. The totals are identical; they are just maintained as arms move.
 */
interface SimulationAggregates {
  family: Map<number, DecayedArmCounts>;
  country: Map<number, DecayedArmCounts>;
  market: Map<number, DecayedArmCounts>;
  language: Map<number, DecayedArmCounts>;
  total: DecayedArmCounts;
}

const zeroCounts = (): DecayedArmCounts => ({ confirmed: 0, quality: 0, quotaUnits: 0, runs: 0 });

function addAggregate(target: DecayedArmCounts, delta: DecayedArmCounts): void {
  target.confirmed += delta.confirmed;
  target.quality += delta.quality;
  target.quotaUnits += delta.quotaUnits;
  target.runs += delta.runs;
}

function buildAggregates(world: CountrySimState[]): SimulationAggregates {
  const aggregates: SimulationAggregates = {
    family: new Map(),
    country: new Map(),
    market: new Map(),
    language: new Map(),
    total: zeroCounts(),
  };
  for (const country of world) {
    for (const arm of country.arms) {
      const counts = armCounts(arm);
      for (const [map, key] of [
        [aggregates.family, arm.family],
        [aggregates.country, arm.country],
        [aggregates.market, arm.market],
        [aggregates.language, arm.language],
      ] as Array<[Map<number, DecayedArmCounts>, number]>) {
        const target = map.get(key) || zeroCounts();
        addAggregate(target, counts);
        map.set(key, target);
      }
      addAggregate(aggregates.total, counts);
    }
  }
  return aggregates;
}

function recordAggregateDelta(aggregates: SimulationAggregates, arm: SimArm, delta: DecayedArmCounts): void {
  for (const [map, key] of [
    [aggregates.family, arm.family],
    [aggregates.country, arm.country],
    [aggregates.market, arm.market],
    [aggregates.language, arm.language],
  ] as Array<[Map<number, DecayedArmCounts>, number]>) {
    const target = map.get(key) || zeroCounts();
    addAggregate(target, delta);
    map.set(key, target);
  }
  addAggregate(aggregates.total, delta);
}

function hierarchyFor(arm: SimArm, aggregates: SimulationAggregates): HierarchyCounts {
  return {
    total: aggregates.total,
    family: aggregates.family.get(arm.family),
    country: aggregates.country.get(arm.country),
    market: aggregates.market.get(arm.market),
    language: aggregates.language.get(arm.language),
  };
}

function priorFor(aggregates: SimulationAggregates): HierarchicalPrior {
  return empiricalPrior([aggregates.total], 0.05, 2);
}

function chooseArm(
  selector: SimulatedSelector,
  arms: SimArm[],
  aggregates: SimulationAggregates,
  prior: HierarchicalPrior,
  rng: () => number,
  portfolio: boolean,
  c: number,
): SimArm {
  const scored = arms.map(arm => ({
    arm,
    posterior: computePosterior(
      armCounts(arm),
      prior,
      // `independent_ts` is the no-pooling comparator: every arm is estimated
      // against the shared prior alone, not the family/country hierarchy.
      selector === 'independent_ts' ? { total: zeroCounts() } : hierarchyFor(arm, aggregates),
      c,
    ),
  }));
  if (portfolio) {
    return [...scored].sort((a, b) => {
      const aPriority = a.posterior.sd * (1 + 1 / (1 + a.posterior.mean));
      const bPriority = b.posterior.sd * (1 + 1 / (1 + b.posterior.mean));
      return bPriority - aPriority || a.arm.id - b.arm.id;
    })[0].arm;
  }
  if (selector === 'current_ucb1') {
    return [...scored].sort((a, b) => {
      const aIndex = a.arm.lastRate + 0.8 * Math.sqrt(Math.log(a.arm.pulls + 2) / (a.arm.pulls + 1));
      const bIndex = b.arm.lastRate + 0.8 * Math.sqrt(Math.log(b.arm.pulls + 2) / (b.arm.pulls + 1));
      return bIndex - aIndex || a.arm.id - b.arm.id;
    })[0].arm;
  }
  if (selector === 'independent_ts' || selector === 'hierarchical_ts') {
    // Draw exactly one Thompson sample per arm, then sort the fixed draws.
    // Sampling inside the comparator makes the result depend on comparison
    // order and gives an arm no stable score within a decision.
    const sampled = scored.map(item => ({
      item,
      sample: thompsonSample(item.posterior, rng),
    }));
    return sampled
      .sort((a, b) => b.sample - a.sample || a.item.arm.id - b.item.arm.id)[0]
      .item.arm;
  }
  return [...scored].sort((a, b) => b.posterior.ucb - a.posterior.ucb || a.arm.id - b.arm.id)[0].arm;
}

export function runSelectorSimulation(config: SimulationConfig, selector: SimulatedSelector): SimulationMetrics {
  const rng = mulberry32((config.seeds + 1) * 104729 + selector.length * 13);
  const world = buildWorld(config, config.seeds);
  const aggregates = buildAggregates(world);
  const portfolioRatio = Math.min(0.20, Math.max(0.10, config.portfolioRatio ?? 0.15));
  const c = config.c ?? SELECTOR_C;
  const pulls = Math.max(1, config.pulls);
  const quotas = [100, 200, 300];
  let totalConfirmed = 0;
  let totalQuota = 0;
  let zeroYield = 0;
  const selectedArms = new Map<number, number>();
  const familyPulls = new Map<number, number>();
  const countryPulls = new Map<number, number>();
  let portfolioPulls = 0;

  for (let step = 0; step < pulls; step++) {
    const countryIndex = step % world.length;
    const country = world[countryIndex];
    if (!country.arms.length) continue;
    const quotaUnits = quotas[Math.floor(rng() * quotas.length)] / 100;
    const portfolio = portfolioPulls < pulls * portfolioRatio;
    if (portfolio) portfolioPulls++;
    if (!config.portfolioRatio && country.cursor < country.arms.length) {
      // Cold-start coverage: each country gets its first arm before index play.
      country.cursor++;
    }
    // Family concentration is a common hard filter, matching the tested
    // portfolio cap. If every family is at the cap (a tiny-world edge case),
    // relax to the full country pool rather than skipping the slot.
    const uncapped = country.arms.filter(arm => (familyPulls.get(arm.family) || 0) / Math.max(1, step) < SIM_FAMILY_SHARE_CAP);
    const arm = chooseArm(selector, uncapped.length ? uncapped : country.arms, aggregates, priorFor(aggregates), rng, portfolio, c);
    const effectiveLambda = !scenarioParameters(config.scenario).stationary && step > pulls * 0.6 && arm.shiftRate != null
      ? arm.shiftRate
      : arm.lambda;
    let confirmed = Math.min(arm.poolRemaining, country.poolRemaining, poisson(effectiveLambda * quotaUnits, rng));
    if (scenarioParameters(config.scenario).depletion && (arm.poolRemaining <= 0 || country.poolRemaining <= 0)) confirmed = 0;
    arm.poolRemaining = Math.max(0, arm.poolRemaining - confirmed);
    country.poolRemaining = Math.max(0, country.poolRemaining - confirmed);
    arm.confirmed += confirmed;
    arm.quotaUnits += quotaUnits;
    arm.pulls += 1;
    arm.lastRate = quotaUnits > 0 ? confirmed / quotaUnits : 0;
    recordAggregateDelta(aggregates, arm, {
      confirmed,
      quality: confirmed * 0.8,
      quotaUnits,
      runs: 1,
    });
    totalConfirmed += confirmed;
    totalQuota += quotaUnits;
    if (confirmed === 0) zeroYield++;
    selectedArms.set(arm.id, (selectedArms.get(arm.id) || 0) + 1);
    familyPulls.set(arm.family, (familyPulls.get(arm.family) || 0) + 1);
    countryPulls.set(arm.country, (countryPulls.get(arm.country) || 0) + 1);
  }

  const sortedArmShares = [...selectedArms.values()].sort((a, b) => b - a);
  const top10 = sortedArmShares.slice(0, 10).reduce((sum, count) => sum + count, 0);
  const totalSelections = [...selectedArms.values()].reduce((sum, count) => sum + count, 0) || 1;
  return {
    selector,
    scenario: config.scenario,
    yields: [totalQuota > 0 ? totalConfirmed / totalQuota : 0],
    meanYield: totalQuota > 0 ? totalConfirmed / totalQuota : 0,
    coverage: new Set([...countryPulls.keys()]).size,
    zeroYieldShare: zeroYield / Math.max(1, pulls),
    distinctArms: selectedArms.size,
    top10Share: top10 / totalSelections,
    maxFamilyShare: Math.max(0, ...[...familyPulls.values()].map(count => count / totalSelections)),
    maxCountryShare: Math.max(0, ...[...countryPulls.values()].map(count => count / totalSelections)),
  };
}

export function compareSelectors(config: SimulationConfig): Record<SimulatedSelector, SimulationMetrics> {
  return {
    current_ucb1: runSelectorSimulation(config, 'current_ucb1'),
    hierarchical_ucb_c1: runSelectorSimulation({ ...config, c: 1.0 }, 'hierarchical_ucb_c1'),
    hierarchical_ucb_c2: runSelectorSimulation({ ...config, c: 2.0 }, 'hierarchical_ucb_c2'),
    independent_ts: runSelectorSimulation(config, 'independent_ts'),
    hierarchical_ts: runSelectorSimulation(config, 'hierarchical_ts'),
  };
}
