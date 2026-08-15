import type { ScanStatus, TradingStatus } from '../src/types';
import type { ReviewEligibilityDecision } from './reviewEligibility/policy';

export interface UncertainLifecycleState {
  scanStatus: ScanStatus;
  tradingStatus: TradingStatus;
  shouldEnqueue: boolean;
}

/** NEEDS_REVIEW is reserved for evidence-complete human ambiguity once a serving decision is supplied. */
export function resolveUncertainLifecycle(wantsHumanReview: boolean, eligibility?: ReviewEligibilityDecision): UncertainLifecycleState {
  if (!wantsHumanReview) return { scanStatus: 'ENRICHMENT_PENDING', tradingStatus: 'UNCERTAIN', shouldEnqueue: true };
  if (!eligibility) return { scanStatus: 'NEEDS_REVIEW', tradingStatus: 'NEEDS_REVIEW', shouldEnqueue: false };
  if (eligibility.servingAuthority && eligibility.status === 'ELIGIBLE' && eligibility.reasonFamily === 'HUMAN_AMBIGUITY') {
    return { scanStatus: 'NEEDS_REVIEW', tradingStatus: 'NEEDS_REVIEW', shouldEnqueue: false };
  }
  return { scanStatus: 'COMPLETED', tradingStatus: 'UNCERTAIN', shouldEnqueue: false };
}
