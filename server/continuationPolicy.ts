export type ContinuationReasonCode =
  | 'CONTINUE_PRODUCTIVE' | 'CONTINUE_EXPLORATION' | 'NO_NEXT_PAGE'
  | 'PAGE_CEILING' | 'CREATOR_CEILING' | 'CONSECUTIVE_LOW_YIELD'
  | 'ZERO_CONFIRMED_VALUE' | 'DUPLICATE_HEAVY' | 'WRONG_COUNTRY';

export interface ContinuationPolicyInput {
  pageNumber: number; maxPages: number; hasNextPage: boolean;
  distinctCreators: number; cumulativeDistinctCreators: number; maxDistinctCreators?: number;
  newCreators: number; confirmedCreators: number; qualityConfirmedCreators: number;
  countryPrecision: number; communityDiversity: number; duplicateRatio: number;
  consecutiveLowYieldPages: number; maxConsecutiveLowYieldPages: number;
}

export interface ContinuationDecision {
  shouldContinue: boolean; lowYield: boolean; marginalUtility: number;
  primaryReason: ContinuationReasonCode; reasonCodes: ContinuationReasonCode[];
}

const clamp = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));

/** Pure, deterministic policy shared by human-directed and autonomous discovery. */
export function evaluateContinuation(input: ContinuationPolicyInput): ContinuationDecision {
  const distinct = Math.max(0, input.distinctCreators);
  const novelty = distinct ? clamp(input.newCreators / distinct) : 0;
  const confirmedYield = distinct ? clamp(input.confirmedCreators / distinct) : 0;
  const qualityYield = distinct ? clamp(input.qualityConfirmedCreators / distinct) : 0;
  const marginalUtility = Number(clamp(
    0.30 * qualityYield + 0.25 * confirmedYield + 0.20 * novelty +
    0.15 * clamp(input.countryPrecision) + 0.10 * clamp(input.communityDiversity) -
    0.20 * clamp(input.duplicateRatio)
  ).toFixed(5));
  const reasons: ContinuationReasonCode[] = [];
  if (!input.hasNextPage) reasons.push('NO_NEXT_PAGE');
  if (input.pageNumber >= input.maxPages) reasons.push('PAGE_CEILING');
  if (input.maxDistinctCreators && input.cumulativeDistinctCreators >= input.maxDistinctCreators) reasons.push('CREATOR_CEILING');
  if (input.confirmedCreators === 0) reasons.push('ZERO_CONFIRMED_VALUE');
  if (input.duplicateRatio >= 0.8) reasons.push('DUPLICATE_HEAVY');
  if (input.countryPrecision < 0.5) reasons.push('WRONG_COUNTRY');
  const lowYield = marginalUtility < 0.2 || input.confirmedCreators === 0 || input.duplicateRatio >= 0.8 || input.countryPrecision < 0.5;
  const lowYieldCount = lowYield ? input.consecutiveLowYieldPages + 1 : 0;
  if (lowYieldCount >= input.maxConsecutiveLowYieldPages) reasons.push('CONSECUTIVE_LOW_YIELD');
  const terminal = reasons.find(r => ['NO_NEXT_PAGE','PAGE_CEILING','CREATOR_CEILING','CONSECUTIVE_LOW_YIELD'].includes(r));
  const primaryReason = terminal || (lowYield ? (reasons[0] || 'CONTINUE_EXPLORATION') : 'CONTINUE_PRODUCTIVE');
  return { shouldContinue: !terminal, lowYield, marginalUtility, primaryReason, reasonCodes: reasons.length ? reasons : ['CONTINUE_PRODUCTIVE'] };
}
