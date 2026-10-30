export type ContinuationReasonCode =
  | 'CONTINUE_PRODUCTIVE' | 'CONTINUE_EXPLORATION' | 'NO_NEXT_PAGE'
  | 'PAGE_CEILING' | 'CREATOR_CEILING' | 'CONSECUTIVE_LOW_YIELD'
  | 'ZERO_CONFIRMED_VALUE' | 'DUPLICATE_HEAVY' | 'WRONG_COUNTRY'
  | 'DEFERRED_ONLY';

export interface ContinuationPolicyInput {
  pageNumber: number; maxPages: number; hasNextPage: boolean;
  distinctCreators: number; cumulativeDistinctCreators: number; maxDistinctCreators?: number;
  newCreators: number; confirmedCreators: number; qualityConfirmedCreators: number;
  delayedConfirmedCreators?: number; delayedNonTradingCreators?: number; delayedQualityCreators?: number;
  countryPrecision: number; communityDiversity: number; duplicateRatio: number;
  consecutiveLowYieldPages: number; maxConsecutiveLowYieldPages: number;
  /**
   * The page contained only deferred (not evaluated) provider results. It
   * carries no yield signal, so zero-value/duplicate/precision penalties must
   * not be attributed to it; page and creator ceilings still apply.
   */
  deferredOnly?: boolean;
}

export interface ContinuationDecision {
  shouldContinue: boolean; lowYield: boolean; marginalUtility: number;
  primaryReason: ContinuationReasonCode; reasonCodes: ContinuationReasonCode[];
}

const clamp = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));

/** Pure, deterministic policy shared by human-directed and autonomous discovery. */
export function evaluateContinuation(input: ContinuationPolicyInput): ContinuationDecision {
  if (input.deferredOnly) {
    const reasons: ContinuationReasonCode[] = ['DEFERRED_ONLY'];
    if (!input.hasNextPage) reasons.push('NO_NEXT_PAGE');
    if (input.pageNumber >= input.maxPages) reasons.push('PAGE_CEILING');
    if (input.maxDistinctCreators && input.cumulativeDistinctCreators >= input.maxDistinctCreators) reasons.push('CREATOR_CEILING');
    const terminal = reasons.find(r => ['NO_NEXT_PAGE','PAGE_CEILING','CREATOR_CEILING'].includes(r));
    return {
      shouldContinue: !terminal,
      lowYield: false,
      marginalUtility: 0,
      primaryReason: terminal || 'CONTINUE_EXPLORATION',
      reasonCodes: reasons,
    };
  }
  const cumulativeDistinct = Math.max(1, input.cumulativeDistinctCreators || input.distinctCreators);
  const effectiveConfirmed = Math.max(input.confirmedCreators, input.delayedConfirmedCreators || 0);
  const effectiveQuality = Math.max(input.qualityConfirmedCreators, input.delayedQualityCreators || 0);
  const distinct = Math.max(0, input.distinctCreators);
  const novelty = distinct ? clamp(input.newCreators / distinct) : 0;

  // Cohort-attributed yield: cumulative confirmed creators against cumulative distinct creator cohort
  const confirmedYield = clamp(effectiveConfirmed / cumulativeDistinct);
  const qualityYield = clamp(effectiveQuality / cumulativeDistinct);
  const nonTradingPenalty = clamp((input.delayedNonTradingCreators || 0) / cumulativeDistinct);

  const marginalUtility = Number(clamp(
    0.30 * qualityYield + 0.25 * confirmedYield + 0.20 * novelty +
    0.15 * clamp(input.countryPrecision) + 0.10 * clamp(input.communityDiversity) -
    0.20 * clamp(input.duplicateRatio) - 0.20 * nonTradingPenalty
  ).toFixed(5));

  const reasons: ContinuationReasonCode[] = [];
  if (!input.hasNextPage) reasons.push('NO_NEXT_PAGE');
  if (input.pageNumber >= input.maxPages) reasons.push('PAGE_CEILING');
  if (input.maxDistinctCreators && input.cumulativeDistinctCreators >= input.maxDistinctCreators) reasons.push('CREATOR_CEILING');
  if (effectiveConfirmed === 0 && input.newCreators === 0) reasons.push('ZERO_CONFIRMED_VALUE');
  if (input.duplicateRatio >= 0.8) reasons.push('DUPLICATE_HEAVY');
  if (input.countryPrecision < 0.5) reasons.push('WRONG_COUNTRY');
  const lowYield = marginalUtility < 0.2 || (effectiveConfirmed === 0 && input.newCreators === 0) || input.duplicateRatio >= 0.8 || input.countryPrecision < 0.5;
  const lowYieldCount = lowYield ? input.consecutiveLowYieldPages + 1 : 0;
  if (lowYieldCount >= input.maxConsecutiveLowYieldPages) reasons.push('CONSECUTIVE_LOW_YIELD');
  const terminal = reasons.find(r => ['NO_NEXT_PAGE','PAGE_CEILING','CREATOR_CEILING','CONSECUTIVE_LOW_YIELD'].includes(r));
  const primaryReason = terminal || (lowYield ? (reasons[0] || 'CONTINUE_EXPLORATION') : 'CONTINUE_PRODUCTIVE');
  return { shouldContinue: !terminal, lowYield, marginalUtility, primaryReason, reasonCodes: reasons.length ? reasons : ['CONTINUE_PRODUCTIVE'] };
}

/**
 * Rebuilds the trailing low-yield streak from persisted pages. Deferred-only
 * pages carry no yield signal, so they are transparent: they neither extend
 * nor reset the streak. Without this, a deferred page's placeholder
 * `marginalUtility` of 0 would look like a low-yield failure on the next page.
 */
export function countTrailingLowYieldPages(
  rows: Array<{ marginalUtility: number; reasonCodes: string[] }>,
): number {
  let consecutive = 0;
  for (const row of rows) {
    if (row.reasonCodes.includes('DEFERRED_ONLY')) continue;
    const low = Number(row.marginalUtility) < 0.2 ||
      row.reasonCodes.some(code => ['ZERO_CONFIRMED_VALUE','DUPLICATE_HEAVY','WRONG_COUNTRY'].includes(code));
    if (!low) break;
    consecutive++;
  }
  return consecutive;
}

// ---------------------------------------------------------------------------
// Continuation v2 (autonomous runs only; legacy evaluateContinuation above is
// unchanged for human-directed/manual search).
// ---------------------------------------------------------------------------

export type ContinuationReasonCodeV2 = ContinuationReasonCode
  | 'CONTINUE_GRACE' | 'PROVIDER_EXHAUSTED' | 'RUN_BUDGET_EXHAUSTED'
  | 'MARGINAL_VALUE_LOW' | 'QUOTA_DEFERRED' | 'TIME_BUDGET_EXHAUSTED'
  | 'RESUME_UNAVAILABLE';

export type ContinuationResumeMode = 'TOKEN' | 'REWALK' | 'OFFSET' | 'NONE';

export interface ContinuationV2Input {
  pageNumber: number;
  /** Minimum of safety ceiling, provider cap, and quota-derived budget. */
  effectiveMaxPages: number;
  /** Why effectiveMaxPages is binding, used to choose the terminal code. */
  ceilingBound?: 'SAFETY' | 'PROVIDER' | 'RUN_BUDGET' | 'TREATMENT' | 'TRIAL';
  hasNextPage: boolean;
  /** Provider cap/offset/cursor exhausted (distinct from a missing token). */
  providerExhausted?: boolean;
  distinctCreators: number;
  cumulativeDistinctCreators: number;
  maxDistinctCreators?: number;
  newCreators: number;
  /** Page-scoped, deduplicated, delayed outcomes attributed to this page. */
  pageConfirmedCreators: number;
  pageQualityCreators: number;
  pageNonTradingCreators: number;
  /** Literal candidate terms on this page not already in country vocabulary. */
  novelCandidateTerms: number;
  countryPrecision: number;
  communityDiversity: number;
  duplicateRatio: number;
  priorLowValueStreak: number;
  priorDuplicateHeavyStreak: number;
  priorWrongCountryStreak: number;
  maxLowValuePages: number;
  maxDuplicateHeavyPages: number;
  maxWrongCountryPages: number;
  explorationPagesRemaining: number;
  queryMode?: 'EXPLORATION' | 'EXPLOITATION' | 'COLD_START';
  /** Page contained only deferred (not evaluated) provider results. */
  deferredOnly?: boolean;
  /** The page deadline was hit; partial results were persisted. */
  timeBudgetExhausted?: boolean;
  /** Quota admission for the next page (true/undefined when admitted). */
  nextPageQuotaAdmitted?: boolean;
  /** The run's fair-share quota budget cannot fund another page. */
  runBudgetExhausted?: boolean;
}

export interface ContinuationStreaks {
  lowValue: number;
  duplicateHeavy: number;
  wrongCountry: number;
}

export interface ContinuationDecisionV2 {
  shouldContinue: boolean;
  /** Run must be resumed later rather than enqueuing the next page now. */
  defer: boolean;
  deferReason: 'QUOTA' | 'TIME' | null;
  lowValue: boolean;
  duplicateHeavy: boolean;
  wrongCountry: boolean;
  productive: boolean;
  marginalUtility: number;
  primaryReason: ContinuationReasonCodeV2;
  reasonCodes: ContinuationReasonCodeV2[];
  streaks: ContinuationStreaks;
  explorationPagesRemaining: number;
  effectiveMaxPages: number;
}

const TRANSPARENT_V2_CODES = new Set<string>([
  'DEFERRED_ONLY',
  'TIME_BUDGET_EXHAUSTED',
]);

const PRODUCTIVE_V2_CODES = new Set<string>([
  // Exploration itself is a continuation reason, not evidence of a productive
  // page. Counting it as productive made an all-zero exploration page reset
  // the low-value streak and bypass the safety stop.
  'CONTINUE_PRODUCTIVE',
]);

/**
 * Productive-signal continuation policy. A page continues when it produced at
 * least one new creator, confirmed/quality creator, or novel candidate term,
 * regardless of its utility score. Low utility is recorded for ranking only;
 * it never abandons a productive page. Two consecutive pages with no
 * productive signal (the first gets one grace continuation) stop the run.
 */
export function evaluateContinuationV2(input: ContinuationV2Input): ContinuationDecisionV2 {
  const effectiveMaxPages = Math.max(1, Math.trunc(input.effectiveMaxPages) || 1);
  const priorStreaks: ContinuationStreaks = {
    lowValue: Math.max(0, Math.trunc(input.priorLowValueStreak) || 0),
    duplicateHeavy: Math.max(0, Math.trunc(input.priorDuplicateHeavyStreak) || 0),
    wrongCountry: Math.max(0, Math.trunc(input.priorWrongCountryStreak) || 0),
  };
  const transparent = input.deferredOnly === true || input.timeBudgetExhausted === true;
  const distinct = Math.max(0, input.distinctCreators);
  const cumulativeDistinct = Math.max(0, input.cumulativeDistinctCreators || input.distinctCreators);
  const pageConfirmed = Math.max(0, input.pageConfirmedCreators);
  const pageQuality = Math.max(0, input.pageQualityCreators);
  const pageNonTrading = Math.max(0, input.pageNonTradingCreators);
  const novelCandidateTerms = Math.max(0, input.novelCandidateTerms);

  const novelty = distinct ? clamp(input.newCreators / distinct) : 0;
  const confirmedYield = distinct ? clamp(pageConfirmed / distinct) : 0;
  const qualityYield = distinct ? clamp(pageQuality / distinct) : 0;
  const nonTradingPenalty = distinct ? clamp(pageNonTrading / distinct) : 0;
  const marginalUtility = Number(clamp(
    0.30 * qualityYield
    + 0.25 * confirmedYield
    + 0.20 * novelty
    + 0.15 * clamp(input.countryPrecision)
    + 0.10 * clamp(input.communityDiversity)
    - 0.20 * clamp(input.duplicateRatio)
    - 0.20 * nonTradingPenalty
  ).toFixed(5));

  const lowValue = input.newCreators === 0
    && pageConfirmed === 0
    && pageQuality === 0
    && novelCandidateTerms === 0;
  const duplicateHeavy = clamp(input.duplicateRatio) >= 0.9
    && input.newCreators === 0
    && pageConfirmed === 0
    && pageQuality === 0
    && novelCandidateTerms === 0;
  const wrongCountry = clamp(input.countryPrecision) < 0.5
    && input.newCreators === 0
    && pageConfirmed === 0
    && pageQuality === 0
    && novelCandidateTerms === 0;
  const productive = input.newCreators >= 1
    || pageConfirmed >= 1
    || pageQuality >= 1
    || novelCandidateTerms >= 1;

  const streaks: ContinuationStreaks = transparent ? { ...priorStreaks } : {
    lowValue: lowValue ? priorStreaks.lowValue + 1 : 0,
    duplicateHeavy: duplicateHeavy ? priorStreaks.duplicateHeavy + 1 : 0,
    wrongCountry: wrongCountry ? priorStreaks.wrongCountry + 1 : 0,
  };

  const reasonCodes: ContinuationReasonCodeV2[] = [];
  const finish = (
    shouldContinue: boolean,
    primaryReason: ContinuationReasonCodeV2,
    extras: { defer?: boolean; deferReason?: 'QUOTA' | 'TIME' | null; explorationPagesRemaining?: number } = {},
  ): ContinuationDecisionV2 => ({
    shouldContinue,
    defer: extras.defer === true,
    deferReason: extras.deferReason || null,
    lowValue,
    duplicateHeavy,
    wrongCountry,
    productive,
    marginalUtility,
    primaryReason,
    reasonCodes: reasonCodes.length ? reasonCodes : [primaryReason],
    streaks,
    explorationPagesRemaining: extras.explorationPagesRemaining ?? Math.max(0, input.explorationPagesRemaining),
    effectiveMaxPages,
  });

  if (input.providerExhausted) {
    reasonCodes.push('PROVIDER_EXHAUSTED');
    return finish(false, 'PROVIDER_EXHAUSTED');
  }
  if (!input.hasNextPage) {
    reasonCodes.push('NO_NEXT_PAGE');
    return finish(false, 'NO_NEXT_PAGE');
  }
  if (input.pageNumber >= effectiveMaxPages) {
    const ceilingReason: ContinuationReasonCodeV2 = input.ceilingBound === 'RUN_BUDGET'
      ? 'RUN_BUDGET_EXHAUSTED'
      : 'PAGE_CEILING';
    reasonCodes.push(ceilingReason);
    if (input.ceilingBound === 'PROVIDER' && !reasonCodes.includes('PROVIDER_EXHAUSTED')) {
      reasonCodes.push('PROVIDER_EXHAUSTED');
    }
    return finish(false, ceilingReason);
  }
  if (input.maxDistinctCreators && cumulativeDistinct >= input.maxDistinctCreators) {
    reasonCodes.push('CREATOR_CEILING');
    return finish(false, 'CREATOR_CEILING');
  }

  // A timed-out or deferred-only page carries an incomplete/absent yield
  // signal. It neither extends nor resets a streak; the run resumes later.
  if (input.timeBudgetExhausted) {
    reasonCodes.push('TIME_BUDGET_EXHAUSTED');
    return finish(true, 'TIME_BUDGET_EXHAUSTED', { defer: true, deferReason: 'TIME' });
  }
  if (input.deferredOnly) {
    reasonCodes.push('DEFERRED_ONLY');
    if (input.nextPageQuotaAdmitted === false || input.runBudgetExhausted) {
      reasonCodes.push('QUOTA_DEFERRED');
      return finish(true, 'QUOTA_DEFERRED', { defer: true, deferReason: 'QUOTA' });
    }
    return finish(true, 'DEFERRED_ONLY');
  }

  if (lowValue) reasonCodes.push('ZERO_CONFIRMED_VALUE');
  if (duplicateHeavy) reasonCodes.push('DUPLICATE_HEAVY');
  if (wrongCountry) reasonCodes.push('WRONG_COUNTRY');

  // A page with no productive signal can match several stop conditions at once
  // (e.g. duplicate-heavy also has zero confirmed value). The most specific
  // actionable reason must win so operators see why the run stopped: duplicate
  // and wrong-country stops take precedence over the generic low-value stop.
  if (streaks.duplicateHeavy >= Math.max(1, input.maxDuplicateHeavyPages)) {
    reasonCodes.push('DUPLICATE_HEAVY');
    return finish(false, 'DUPLICATE_HEAVY');
  }
  if (streaks.wrongCountry >= Math.max(1, input.maxWrongCountryPages)) {
    reasonCodes.push('WRONG_COUNTRY');
    return finish(false, 'WRONG_COUNTRY');
  }
  if (streaks.lowValue >= Math.max(1, input.maxLowValuePages)) {
    reasonCodes.push('MARGINAL_VALUE_LOW');
    reasonCodes.push('CONSECUTIVE_LOW_YIELD');
    return finish(false, 'MARGINAL_VALUE_LOW');
  }

  if (input.runBudgetExhausted || input.nextPageQuotaAdmitted === false) {
    reasonCodes.push('QUOTA_DEFERRED');
    return finish(true, 'QUOTA_DEFERRED', { defer: true, deferReason: 'QUOTA' });
  }

  if (productive) {
    reasonCodes.push('CONTINUE_PRODUCTIVE');
    return finish(true, 'CONTINUE_PRODUCTIVE');
  }

  const explorationEligible = input.explorationPagesRemaining > 0
    && (input.queryMode === 'EXPLORATION' || input.queryMode === 'COLD_START');
  if (explorationEligible) {
    reasonCodes.push('CONTINUE_EXPLORATION');
    return finish(true, 'CONTINUE_EXPLORATION', {
      explorationPagesRemaining: Math.max(0, input.explorationPagesRemaining - 1),
    });
  }

  // First low-value page below the consecutive limit: one grace page. The
  // low-value streak check above stops the run on the second consecutive page.
  reasonCodes.push('CONTINUE_GRACE');
  return finish(true, 'CONTINUE_GRACE');
}

/**
 * V2 streak reconstruction from persisted page rows (newest first). Deferred
 * pages are transparent. A page is low-value only when it has no productive
 * reason and carries a grace/low-value/zero-value signal; utility alone never
 * marks a page low-value.
 */
export function countTrailingContinuationStreaks(
  rows: Array<{ marginalUtility?: number; reasonCodes: string[]; continuationDecisionV2?: unknown }>,
): ContinuationStreaks {
  let lowValue = 0;
  let duplicateHeavy = 0;
  let wrongCountry = 0;
  let lowActive = true;
  let duplicateActive = true;
  let wrongActive = true;
  for (const row of rows) {
    // A pre-v2 row carries `{}` (the migration default) rather than a v2
    // decision. Its v1 reason codes were not evaluated with v2 streak
    // semantics, so stop at the first such row instead of inventing a v2
    // low-value/duplicate/wrong-country streak from them. Rows without the
    // field (older callers/tests) keep the reason-code reconstruction path.
    if (row.continuationDecisionV2 !== undefined && !parseContinuationDecisionV2(row.continuationDecisionV2)) break;
    const codes = new Set(Array.isArray(row.reasonCodes) ? row.reasonCodes : []);
    if ([...codes].some(code => TRANSPARENT_V2_CODES.has(code))) continue;
    const productive = [...codes].some(code => PRODUCTIVE_V2_CODES.has(code));
    const lowMatch = !productive && (
      codes.has('CONTINUE_GRACE')
      || codes.has('MARGINAL_VALUE_LOW')
      || codes.has('CONSECUTIVE_LOW_YIELD')
      || codes.has('ZERO_CONFIRMED_VALUE')
    );
    if (lowActive && lowMatch) lowValue++; else lowActive = false;
    if (duplicateActive && codes.has('DUPLICATE_HEAVY')) duplicateHeavy++; else duplicateActive = false;
    if (wrongActive && codes.has('WRONG_COUNTRY')) wrongCountry++; else wrongActive = false;
    if (!lowActive && !duplicateActive && !wrongActive) break;
  }
  return { lowValue, duplicateHeavy, wrongCountry };
}

/** Read the persisted v2 decision JSON when present (reconciler fast path). */
export function parseContinuationDecisionV2(value: unknown): ContinuationDecisionV2 | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<ContinuationDecisionV2>;
  if (typeof candidate.shouldContinue !== 'boolean') return null;
  if (!candidate.streaks || typeof candidate.streaks.lowValue !== 'number') return null;
  return candidate as ContinuationDecisionV2;
}

export interface EffectivePageBudgetInput {
  safetyMaxPages: number;
  providerMaxPages: number;
  /** Provider quota units per page: 0 for InnerTube, 100 for official YouTube. */
  pageCostUnits: number;
  remainingAutonomousQuota: number;
  /** Active countries with a new-query turn or a pending continuation. */
  pendingCountries: number;
  treatmentCapPages?: number | null;
  trialContinuationCap?: number | null;
}

export interface EffectivePageBudget {
  effectiveMaxPages: number;
  bindingBound: 'SAFETY' | 'PROVIDER' | 'RUN_BUDGET' | 'TREATMENT' | 'TRIAL';
  runQuotaBudgetUnits: number;
  quotaPages: number;
}

/**
 * Four independent bounds: hard safety ceiling, provider cap, fair-share quota
 * budget, and any treatment/trial reservation. The fair-share budget is fixed
 * at the run's first page and does not shrink when another country appears.
 * There is deliberately no per-run page minimum: a fair-share floor that let
 * one country take extra pages would starve the other pending countries.
 */
export function computeEffectivePageBudget(input: EffectivePageBudgetInput): EffectivePageBudget {
  const safety = Math.max(1, Math.trunc(input.safetyMaxPages) || 1);
  const provider = Math.max(1, Math.trunc(input.providerMaxPages) || 1);
  const pageCost = Math.max(0, Math.trunc(input.pageCostUnits) || 0);
  const remaining = Math.max(0, input.remainingAutonomousQuota);
  const pendingCountries = Math.max(1, Math.trunc(input.pendingCountries) || 1);
  const runQuotaBudgetUnits = pageCost > 0
    ? Math.min(remaining, Math.max(pageCost, Math.floor(remaining / pendingCountries)))
    : remaining;
  const quotaPages = pageCost > 0
    ? Math.floor(runQuotaBudgetUnits / pageCost)
    : safety;

  const bounds: Array<{ bound: EffectivePageBudget['bindingBound']; pages: number }> = [
    { bound: 'SAFETY', pages: safety },
    { bound: 'PROVIDER', pages: provider },
    { bound: 'RUN_BUDGET', pages: quotaPages },
  ];
  if (input.treatmentCapPages != null) {
    bounds.push({ bound: 'TREATMENT', pages: Math.max(1, Math.trunc(input.treatmentCapPages) || 1) });
  }
  if (input.trialContinuationCap != null) {
    bounds.push({ bound: 'TRIAL', pages: Math.max(1, Math.trunc(input.trialContinuationCap) || 1) });
  }
  let effective = bounds[0];
  for (const candidate of bounds.slice(1)) {
    // Treatment/trial caps win ties. Otherwise an equal safety/provider/quota
    // bound would leave bindingBound as SAFETY, and the segmenter would renew
    // the same allocation cap with a fresh run quota instead of ending.
    if (
      candidate.pages < effective.pages
      || (candidate.pages === effective.pages && (candidate.bound === 'TREATMENT' || candidate.bound === 'TRIAL'))
    ) {
      effective = candidate;
    }
  }
  return {
    effectiveMaxPages: Math.max(1, effective.pages),
    bindingBound: effective.bound,
    runQuotaBudgetUnits,
    quotaPages,
  };
}

/** Resumption capability per provider. InnerTube has no serializable token. */
export function resumeModeForProvider(providerKey: string | null | undefined): ContinuationResumeMode {
  switch (String(providerKey || '')) {
    case 'youtube-search': return 'TOKEN';
    case 'brave-search': return 'OFFSET';
    case 'youtube-innertube': return 'REWALK';
    default: return 'NONE';
  }
}

/**
 * The 50-page safety ceiling is a boundary, not a dead end. When the ceiling is
 * the binding bound and the provider still exposes a next page, the run must
 * preserve its cursor in a linked continuation segment. Provider, treatment,
 * and trial caps end their own allocation and never create a segment.
 */
export function shouldCreateContinuationSegment(args: {
  paginationEnabled: boolean;
  usingV2: boolean;
  primaryReason: string;
  bindingBound: string;
  hasNextPage: boolean;
}): boolean {
  return args.paginationEnabled === true
    && args.usingV2 === true
    && args.primaryReason === 'PAGE_CEILING'
    && args.bindingBound === 'SAFETY'
    && args.hasNextPage === true;
}
