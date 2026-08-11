export type ProspectiveCandidateHint = 'LIKELY_TRADING' | 'LIKELY_NON_TRADING';

export interface ProspectiveReviewCandidate {
  channel_id: string;
  readiness: string;
  creator_focus_proposed_status?: string | null;
  creator_focus_probability?: number | string | null;
  creator_focus_lower_confidence_bound?: number | string | null;
  pending_since?: string | null;
  [key: string]: unknown;
}

export interface BalancedProspectiveCandidateRecommendations {
  likelyTrading: ProspectiveReviewCandidate | null;
  likelyNonTrading: ProspectiveReviewCandidate | null;
  methodology: {
    humanDecisionRequired: true;
    hintsAreGroundTruth: false;
    servingAuthority: false;
    tradingOrdering: string;
    nonTradingOrdering: string;
  };
}

const probability = (row: ProspectiveReviewCandidate): number => {
  const value = Number(row.creator_focus_probability);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.5;
};

const lowerBound = (row: ProspectiveReviewCandidate): number => {
  const value = Number(row.creator_focus_lower_confidence_bound);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
};

const pendingTime = (row: ProspectiveReviewCandidate): number => {
  const value = row.pending_since ? new Date(row.pending_since).getTime() : Number.POSITIVE_INFINITY;
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
};

const proposedRank = (row: ProspectiveReviewCandidate, target: 'TRADING_CONFIRMED' | 'NON_TRADING'): number =>
  row.creator_focus_proposed_status === target ? 0 : row.creator_focus_proposed_status === 'UNCERTAIN' ? 1 : 2;

/**
 * Human-review acceleration only. The hints returned here are deliberately not
 * labels and must never be persisted as ground truth or serving authority.
 */
export function selectBalancedProspectiveCandidates(
  candidates: ProspectiveReviewCandidate[],
): BalancedProspectiveCandidateRecommendations {
  const ready = candidates.filter(row => row.readiness === 'READY_FOR_PROSPECTIVE_HUMAN_REVIEW');

  const trading = [...ready].sort((a, b) =>
    proposedRank(a, 'TRADING_CONFIRMED') - proposedRank(b, 'TRADING_CONFIRMED') ||
    probability(b) - probability(a) ||
    lowerBound(b) - lowerBound(a) ||
    pendingTime(a) - pendingTime(b) ||
    String(a.channel_id).localeCompare(String(b.channel_id))
  );

  const nonTrading = [...ready].sort((a, b) =>
    proposedRank(a, 'NON_TRADING') - proposedRank(b, 'NON_TRADING') ||
    probability(a) - probability(b) ||
    lowerBound(a) - lowerBound(b) ||
    pendingTime(a) - pendingTime(b) ||
    String(a.channel_id).localeCompare(String(b.channel_id))
  );

  const likelyTrading = trading[0] || null;
  let likelyNonTrading = nonTrading[0] || null;
  if (likelyTrading && likelyNonTrading?.channel_id === likelyTrading.channel_id) {
    likelyNonTrading = nonTrading.find(row => row.channel_id !== likelyTrading.channel_id) || null;
  }

  return {
    likelyTrading,
    likelyNonTrading,
    methodology: {
      humanDecisionRequired: true,
      hintsAreGroundTruth: false,
      servingAuthority: false,
      tradingOrdering: 'proposed TRADING_CONFIRMED, then probability desc, lower bound desc, oldest pending',
      nonTradingOrdering: 'proposed NON_TRADING, then probability asc, lower bound asc, oldest pending',
    },
  };
}
