export type ProspectiveCandidateHint = 'LIKELY_TRADING' | 'LIKELY_NON_TRADING';

export interface ProspectiveReviewCandidate {
  channel_id: string;
  channel_name?: string | null;
  youtube_url?: string | null;
  readiness: string;
  adjudication_readiness?: string | null;
  creator_focus_proposed_status?: string | null;
  creator_focus_probability?: number | string | null;
  creator_focus_lower_confidence_bound?: number | string | null;
  pending_since?: string | null;
  assigned_at?: string | null;
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

export interface BalancedAdjudicationQueue {
  likelyTrading: ProspectiveReviewCandidate[];
  likelyNonTrading: ProspectiveReviewCandidate[];
  requestedPerClass: number;
  methodology: {
    humanDecisionRequired: true;
    hintsAreGroundTruth: false;
    operationalStatusIsGroundTruth: false;
    servingAuthority: false;
    queueMutation: false;
    tradingOrdering: string;
    nonTradingOrdering: string;
    distinctAcrossHintLanes: true;
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

const candidateTime = (row: ProspectiveReviewCandidate): number => {
  const raw = row.pending_since || row.assigned_at;
  const value = raw ? new Date(raw).getTime() : Number.POSITIVE_INFINITY;
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
};

const proposedRank = (row: ProspectiveReviewCandidate, target: 'TRADING_CONFIRMED' | 'NON_TRADING'): number =>
  row.creator_focus_proposed_status === target ? 0 : row.creator_focus_proposed_status === 'UNCERTAIN' ? 1 : 2;

const tradingOrdering = (a: ProspectiveReviewCandidate, b: ProspectiveReviewCandidate): number =>
  proposedRank(a, 'TRADING_CONFIRMED') - proposedRank(b, 'TRADING_CONFIRMED') ||
  probability(b) - probability(a) ||
  lowerBound(b) - lowerBound(a) ||
  candidateTime(a) - candidateTime(b) ||
  String(a.channel_id).localeCompare(String(b.channel_id));

const nonTradingOrdering = (a: ProspectiveReviewCandidate, b: ProspectiveReviewCandidate): number =>
  proposedRank(a, 'NON_TRADING') - proposedRank(b, 'NON_TRADING') ||
  probability(a) - probability(b) ||
  lowerBound(a) - lowerBound(b) ||
  candidateTime(a) - candidateTime(b) ||
  String(a.channel_id).localeCompare(String(b.channel_id));

/**
 * Human-review acceleration only. The hints returned here are deliberately not
 * labels and must never be persisted as ground truth or serving authority.
 */
export function selectBalancedProspectiveCandidates(
  candidates: ProspectiveReviewCandidate[],
): BalancedProspectiveCandidateRecommendations {
  const ready = candidates.filter(row => row.readiness === 'READY_FOR_PROSPECTIVE_HUMAN_REVIEW');

  const trading = [...ready].sort(tradingOrdering);
  const nonTrading = [...ready].sort(nonTradingOrdering);

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
      tradingOrdering: 'proposed TRADING_CONFIRMED, then probability desc, lower bound desc, oldest pending/assigned',
      nonTradingOrdering: 'proposed NON_TRADING, then probability asc, lower bound asc, oldest pending/assigned',
    },
  };
}

/**
 * Produces a finite, read-only worklist for independent human adjudication.
 * The two lanes are ranking hints only; the reviewer must independently inspect
 * every creator and may choose either label regardless of the lane.
 */
export function selectBalancedAdjudicationQueue(
  candidates: ProspectiveReviewCandidate[],
  requestedPerClass = 10,
): BalancedAdjudicationQueue {
  const limit = Math.max(1, Math.min(50, Math.trunc(requestedPerClass) || 10));
  const ready = candidates.filter(row => row.adjudication_readiness === 'READY_FOR_INDEPENDENT_ADJUDICATION');

  const likelyTrading = [...ready].sort(tradingOrdering).slice(0, limit);
  const tradingIds = new Set(likelyTrading.map(row => row.channel_id));
  const likelyNonTrading = [...ready]
    .filter(row => !tradingIds.has(row.channel_id))
    .sort(nonTradingOrdering)
    .slice(0, limit);

  return {
    likelyTrading,
    likelyNonTrading,
    requestedPerClass: limit,
    methodology: {
      humanDecisionRequired: true,
      hintsAreGroundTruth: false,
      operationalStatusIsGroundTruth: false,
      servingAuthority: false,
      queueMutation: false,
      tradingOrdering: 'proposed TRADING_CONFIRMED, then probability desc, lower bound desc, oldest pending/assigned',
      nonTradingOrdering: 'proposed NON_TRADING, then probability asc, lower bound asc, oldest pending/assigned',
      distinctAcrossHintLanes: true,
    },
  };
}
