export const OUTCOME_FEEDBACK_POLICY_VERSION = 'outcome-feedback-v1-shadow-1' as const;

export type DiscoveryOutcome =
  | 'ADMITTED'
  | 'WITHHELD'
  | 'HUMAN_ACCEPTED'
  | 'HUMAN_REJECTED'
  | 'UNRESOLVED';

export interface DiscoveryAllocationObservation {
  queryId?: number | null;
  query: string;
  lane: string;
  channelId: string;
  outcome: DiscoveryOutcome;
  allocationProbability?: number | null;
  randomized: boolean;
}

export interface OutcomeFeedbackProjection {
  policyVersion: typeof OUTCOME_FEEDBACK_POLICY_VERSION;
  servingAuthority: false;
  eligibleForPolicyLearning: boolean;
  reward: number;
  reason: string;
  observation: DiscoveryAllocationObservation;
}

const REWARD: Record<DiscoveryOutcome, number> = {
  HUMAN_ACCEPTED: 1,
  ADMITTED: 0.6,
  UNRESOLVED: 0,
  WITHHELD: -0.35,
  HUMAN_REJECTED: -1,
};

/**
 * Records the counterfactual-learning contract only. No result from this
 * function may change query allocation while servingAuthority is false.
 *
 * Outcome feedback is only learning-eligible when allocation was randomized
 * or a valid propensity was recorded. This prevents biased historical outcomes
 * from silently becoming discovery authority.
 */
export function projectOutcomeFeedback(
  observation: DiscoveryAllocationObservation,
): OutcomeFeedbackProjection {
  const propensity = observation.allocationProbability;
  const hasRecordedPropensity =
    Number.isFinite(propensity) && Number(propensity) > 0 && Number(propensity) <= 1;
  const eligibleForPolicyLearning = observation.randomized || hasRecordedPropensity;

  return {
    policyVersion: OUTCOME_FEEDBACK_POLICY_VERSION,
    servingAuthority: false,
    eligibleForPolicyLearning,
    reward: REWARD[observation.outcome],
    reason: eligibleForPolicyLearning
      ? observation.randomized
        ? 'RANDOMIZED_ALLOCATION'
        : 'PROPENSITY_RECORDED'
      : 'OBSERVATIONAL_ONLY',
    observation,
  };
}
