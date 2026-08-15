import type { ScanStatus, TradingStatus } from '../src/types';
import type { ReviewEligibilityDecision } from './reviewEligibility/policy';

export interface UncertainLifecycleState {
  scanStatus: ScanStatus;
  tradingStatus: TradingStatus;
  shouldEnqueue: boolean;
}

/**
 * NEEDS_REVIEW is reserved for an explicit evidence-complete serving decision.
 * Legacy callers that have not supplied eligibility remain machine-owned; the
 * authoritative eligibility recorder can materialize a genuine pending review
 * after the channel write, but absence of eligibility can never create review.
 */
export function resolveUncertainLifecycle(wantsHumanReview: boolean, eligibility?: ReviewEligibilityDecision): UncertainLifecycleState {
  if (!wantsHumanReview) return { scanStatus: 'ENRICHMENT_PENDING', tradingStatus: 'UNCERTAIN', shouldEnqueue: true };
  if (eligibility?.servingAuthority && eligibility.status === 'ELIGIBLE' && eligibility.reasonFamily === 'HUMAN_AMBIGUITY') {
    return { scanStatus: 'NEEDS_REVIEW', tradingStatus: 'NEEDS_REVIEW', shouldEnqueue: false };
  }
  return { scanStatus: 'COMPLETED', tradingStatus: 'UNCERTAIN', shouldEnqueue: false };
}
