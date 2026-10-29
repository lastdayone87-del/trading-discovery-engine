import { createHash } from 'node:crypto';
import {
  computePosterior,
  MAX_SELECTION_INDEX,
  MIN_SELECTION_SAMPLE,
  PORTFOLIO_RATIO,
  SELECTOR_C,
  SELECTOR_POLICY_VERSION,
  QUERY_POSTERIOR_VERSION,
  type HierarchyCounts,
} from './posterior';
import type {
  ArmPosterior,
  DecayedArmCounts,
  SelectorCandidate,
  SelectorContext,
  SelectorDecision,
} from './types';

export const QUERY_PORTFOLIO_VERSION = 'query-portfolio-v1';

export interface CandidateScore {
  candidate: SelectorCandidate;
  posterior: ArmPosterior;
  index: number;
  coverageCell: string;
}

const emptyCounts = (): DecayedArmCounts => ({ confirmed: 0, quality: 0, quotaUnits: 0, runs: 0 });

function addCounts(target: DecayedArmCounts, source: DecayedArmCounts): void {
  target.confirmed += source.confirmed;
  target.quality += source.quality;
  target.quotaUnits += source.quotaUnits;
  target.runs += source.runs;
}

export function coverageCellFor(candidate: SelectorCandidate): string {
  return [candidate.country, candidate.language, candidate.market, candidate.compositionFamily].join('|');
}

export function buildHierarchy(candidates: SelectorCandidate[]): {
  total: DecayedArmCounts;
  family: Record<string, DecayedArmCounts>;
  country: Record<string, DecayedArmCounts>;
  market: Record<string, DecayedArmCounts>;
  language: Record<string, DecayedArmCounts>;
} {
  const total = emptyCounts();
  const family: Record<string, DecayedArmCounts> = {};
  const country: Record<string, DecayedArmCounts> = {};
  const market: Record<string, DecayedArmCounts> = {};
  const language: Record<string, DecayedArmCounts> = {};
  const ensure = (target: Record<string, DecayedArmCounts>, key: string) => (target[key] ||= emptyCounts());
  for (const candidate of candidates) {
    addCounts(total, candidate.counts);
    addCounts(ensure(family, candidate.compositionFamily), candidate.counts);
    addCounts(ensure(country, candidate.country), candidate.counts);
    addCounts(ensure(market, candidate.market), candidate.counts);
    addCounts(ensure(language, candidate.language), candidate.counts);
  }
  return { total, family, country, market, language };
}

function hierarchyFor(candidate: SelectorCandidate, hierarchy: ReturnType<typeof buildHierarchy>): HierarchyCounts {
  return {
    total: hierarchy.total,
    family: hierarchy.family[candidate.compositionFamily],
    country: hierarchy.country[candidate.country],
    market: hierarchy.market[candidate.market],
    language: hierarchy.language[candidate.language],
  };
}

export function candidateSetHash(candidates: SelectorCandidate[]): string {
  const payload = candidates
    .map(candidate => `${candidate.queryId}:${candidate.query}:${candidate.counts.runs}`)
    .sort()
    .join('|');
  return createHash('sha256').update(payload).digest('hex').slice(0, 24);
}

function shareOf(share: Record<string, number>, key: string): number {
  return share[key] || 0;
}

function capReason(candidate: SelectorCandidate, context: SelectorContext): string | null {
  if (shareOf(context.familyShare, candidate.compositionFamily) >= context.familyCap) return 'FAMILY_SHARE_CAP';
  if (shareOf(context.countryShare, candidate.country) >= context.countryCap) return 'COUNTRY_SHARE_CAP';
  // Source share is keyed by the source recorded in admission; direct
  // candidates without admission are treated as the conservative "UNKNOWN".
  const source = candidate.admission?.source || 'UNKNOWN';
  if (shareOf(context.sourceShare, source) >= context.sourceCap) return 'SOURCE_SHARE_CAP';
  return null;
}

function portfolioBudgetRemaining(context: SelectorContext): number {
  const reserved = Math.max(0, context.totalDailyQuotaUnits * context.portfolioRatio);
  return Math.max(0, reserved - Math.max(0, context.portfolioUnitsUsed));
}

function portfolioNeeded(context: SelectorContext): boolean {
  // The portfolio is a bounded, reserved floor. Coverage debt may not spend
  // beyond that floor; when it is exhausted, explicit fail-closed replaces
  // further exploration.
  if (portfolioBudgetRemaining(context) <= 0) return false;
  const cells = context.coverageCells || [];
  const covered = new Set(context.coveredCells || []);
  const coverageDeficit = cells.some(cell => !covered.has(cell));
  return coverageDeficit || context.portfolioUnitsUsed < Math.max(0, context.totalDailyQuotaUnits * context.portfolioRatio);
}

function deterministicTieBreak(a: CandidateScore, b: CandidateScore, context: SelectorContext): number {
  if (b.index !== a.index) return b.index - a.index;
  const familyDifference = shareOf(context.familyShare, a.candidate.compositionFamily) - shareOf(context.familyShare, b.candidate.compositionFamily);
  if (familyDifference !== 0) return familyDifference;
  const key = (candidate: SelectorCandidate) => `${candidate.queryId}:${candidate.query}`;
  return key(a.candidate).localeCompare(key(b.candidate));
}

/**
 * Deterministic hierarchical, cost-aware UCB selection.
 *
 * - `selectionIndex = posterior mean + c * posterior SD`, capped.
 * - Cooldown/admission/caps are hard filters (callers pass the already
 *   selectable pool and current admissions).
 * - A bounded portfolio covers cold starts, unseen valid compositions and
 *   coverage deficits; it is a reserved floor, not a random branch.
 * - No Math.random, no least-executed-first, no unscored fallback.
 */
export function selectHierarchicalUcb(candidates: SelectorCandidate[], context: SelectorContext): SelectorDecision {
  const c = Number.isFinite(context.c) ? context.c : SELECTOR_C;
  const eligible = candidates.filter(candidate =>
    (!candidate.admission || candidate.admission.eligible)
    && candidate.collection !== 'REJECTED'
    && capReason(candidate, context) === null
  );
  const base: Omit<SelectorDecision, 'strategy' | 'reason' | 'queryId' | 'query' | 'index' | 'posterior' | 'tier' | 'compositionFamily' | 'reasonCodes'> = {
    version: SELECTOR_POLICY_VERSION,
    country: context.country,
    c,
    candidateSetHash: candidateSetHash(eligible),
    policyVersions: {
      selector: SELECTOR_POLICY_VERSION,
      posterior: QUERY_POSTERIOR_VERSION,
      portfolio: QUERY_PORTFOLIO_VERSION,
      composition: 'query-composition-v1',
      admission: 'query-admission-v1',
      terminology: 'terminology-searchability-v1',
    },
  };
  if (eligible.length === 0) {
    return {
      ...base,
      strategy: 'NO_ELIGIBLE_QUERY',
      reason: 'No eligible query after admission, cooldown, diversity and share-cap filters. Generate a portfolio candidate through the planner.',
      queryId: null,
      query: null,
      index: null,
      posterior: null,
      tier: null,
      compositionFamily: null,
      reasonCodes: ['NO_ELIGIBLE_QUERY'],
    };
  }

  const hierarchy = buildHierarchy(eligible);
  const scored: CandidateScore[] = eligible.map(candidate => {
    const posterior = computePosterior(candidate.counts, context.prior, hierarchyFor(candidate, hierarchy), c, context.maxIndex ?? MAX_SELECTION_INDEX);
    return { candidate, posterior, index: Math.min(context.maxIndex ?? MAX_SELECTION_INDEX, posterior.ucb), coverageCell: coverageCellFor(candidate) };
  });

  const mature = scored.filter(item => item.candidate.counts.runs >= (context.minSample ?? MIN_SELECTION_SAMPLE));
  const portfolioPool = scored.filter(item =>
    item.candidate.tier !== 'ATTESTED_EXACT'
    || item.candidate.counts.runs < (context.minSample ?? MIN_SELECTION_SAMPLE)
    || (context.coverageCells || []).includes(item.coverageCell) && !(context.coveredCells || []).includes(item.coverageCell)
  );

  let chosen: CandidateScore;
  let strategy: SelectorDecision['strategy'];
  let reasonCodes: string[];

  if (portfolioNeeded(context) && portfolioPool.length > 0) {
    // Prioritise high posterior uncertainty and low observed confirmed yield,
    // then deterministic index/tie-break. This is not a random exploration arm.
    chosen = [...portfolioPool].sort((a, b) => {
      const aPriority = a.posterior.sd * (1 + 1 / (1 + a.posterior.mean));
      const bPriority = b.posterior.sd * (1 + 1 / (1 + b.posterior.mean));
      if (bPriority !== aPriority) return bPriority - aPriority;
      return deterministicTieBreak(a, b, context);
    })[0];
    strategy = 'UCB_PORTFOLIO';
    reasonCodes = ['PORTFOLIO_BUDGET_RESERVED', 'COVERAGE_OR_UNSEEN_COMPOSITION'];
  } else if (mature.length > 0) {
    chosen = [...mature].sort((a, b) => deterministicTieBreak(a, b, context))[0];
    strategy = 'UCB_EXPLOITATION';
    reasonCodes = ['POSTERIOR_MEAN_PLUS_C_SD', 'MATURE_SAMPLE'];
  } else if (portfolioBudgetRemaining(context) > 0) {
    chosen = [...scored].sort((a, b) => deterministicTieBreak(a, b, context))[0];
    strategy = 'UCB_PORTFOLIO';
    reasonCodes = ['COLD_START_PRIOR', 'MINIMUM_SAMPLE_NOT_MET'];
  } else {
    // No mature candidate and no reserved exploration budget left. Refuse to
    // spend quota on an unproven arm rather than inventing an unbounded
    // exploration branch; the caller may generate a new governed candidate.
    return {
      ...base,
      strategy: 'NO_ELIGIBLE_QUERY',
      reason: 'The bounded portfolio budget is exhausted and no candidate has reached the minimum sample.',
      queryId: null,
      query: null,
      index: null,
      posterior: null,
      tier: null,
      compositionFamily: null,
      reasonCodes: ['PORTFOLIO_BUDGET_EXHAUSTED', 'FAIL_CLOSED'],
    };
  }

  const cap = capReason(chosen.candidate, context);
  if (cap) {
    // Should be unreachable after filtering; fail closed with an audit code.
    return {
      ...base,
      strategy: 'NO_ELIGIBLE_QUERY',
      reason: `Selected candidate violated ${cap}; refusing to spend quota.`,
      queryId: null,
      query: null,
      index: null,
      posterior: null,
      tier: null,
      compositionFamily: null,
      reasonCodes: [cap, 'FAIL_CLOSED'],
    };
  }

  return {
    ...base,
    strategy,
    reason: `${strategy === 'UCB_PORTFOLIO' ? 'Bounded portfolio selected an uncertain/coverage candidate' : 'Exploitation selected the highest deterministic optimistic index'}: ${chosen.candidate.query} (mean ${chosen.posterior.mean.toFixed(4)}, SD ${chosen.posterior.sd.toFixed(4)}, c ${c.toFixed(1)}, index ${chosen.index.toFixed(4)}).`,
    queryId: chosen.candidate.queryId,
    query: chosen.candidate.query,
    index: chosen.index,
    posterior: chosen.posterior,
    tier: chosen.candidate.tier,
    compositionFamily: chosen.candidate.compositionFamily,
    reasonCodes,
  };
}

export function portfolioBudget(totalDailyQuotaUnits: number, ratio = PORTFOLIO_RATIO): { units: number; ratio: number } {
  const bounded = Math.min(0.20, Math.max(0.10, ratio));
  return { units: Math.max(0, totalDailyQuotaUnits) * bounded, ratio: bounded };
}
