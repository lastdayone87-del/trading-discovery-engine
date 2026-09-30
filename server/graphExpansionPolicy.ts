/**
 * P3 graph depth-2 expansion policy (EXPERIMENTAL testability, no traversal).
 * Pure, deterministic, DB-free. Depth-1 workers are UNCHANGED (depth hardcoded
 * 1, fanout<=10, recursiveActionsCreated:0). This module only decides whether
 * a depth-2 proposal is eligible and builds capped, provenance-bound proposal
 * specs for frozen-replay evaluation. No auto-traversal, no serving writes.
 * Classification: depth<=1 invariant = A; fanout/depth caps = C;
 * eligibility thresholds = E (pilot, determined by experiment); assignment = B.
 */
import { createHash } from 'node:crypto';

export const GRAPH_EXPANSION_POLICY_VERSION = 'graph-expansion-v1';
export const GRAPH_MAX_DEPTH = 2;
export const GRAPH_MAX_FANOUT = 10;

export type GraphEdgeKind = 'FEATURED' | 'PLAYLIST_COHOST' | 'URL_COMENTION' | 'GUEST_MENTION';

export interface Depth2EligibilityInput {
  parentDepth: number;
  fanoutRequested: number;
  edgeKind: GraphEdgeKind;
  /** Independent evidence families supporting the edge (>=2 required). */
  independentFamilies: number;
  /** Neighborhood overlap 0..1 (saturation guard). */
  overlap?: number;
  /** Known-creator fraction 0..1 (saturation guard). */
  knownFraction?: number;
  /** Explicit canary enablement (adapter CANARY + authority + rollout). */
  canaryEnabled: boolean;
}

export interface Depth2Eligibility {
  eligible: boolean;
  reasonCode: string;
  cappedFanout: number;
  policyVersion: string;
}

/**
 * Fail-closed eligibility. Any missing enablement, excessive depth/fanout,
 * insufficient independence, or saturated neighborhood denies with reason.
 */
export function evaluateDepth2Eligibility(input: Depth2EligibilityInput): Depth2Eligibility {
  const base = { cappedFanout: 0, policyVersion: GRAPH_EXPANSION_POLICY_VERSION } as const;
  if (!input.canaryEnabled) return { ...base, eligible: false, reasonCode: 'GRAPH_CANARY_NOT_ENABLED' };
  if (input.parentDepth < 1 || input.parentDepth >= GRAPH_MAX_DEPTH) {
    return { ...base, eligible: false, reasonCode: 'GRAPH_DEPTH_EXCEEDED' };
  }
  if (!Number.isInteger(input.fanoutRequested) || input.fanoutRequested < 1) {
    return { ...base, eligible: false, reasonCode: 'GRAPH_FANOUT_INVALID' };
  }
  if (input.independentFamilies < 2) return { ...base, eligible: false, reasonCode: 'GRAPH_INSUFFICIENT_INDEPENDENCE' };
  const overlap = input.overlap ?? 0;
  const known = input.knownFraction ?? 0;
  if (overlap >= 0.85 && known >= 0.85) return { ...base, eligible: false, reasonCode: 'GRAPH_NEIGHBORHOOD_SATURATED' };
  return {
    eligible: true,
    reasonCode: 'GRAPH_DEPTH2_ELIGIBLE',
    cappedFanout: Math.min(input.fanoutRequested, GRAPH_MAX_FANOUT),
    policyVersion: GRAPH_EXPANSION_POLICY_VERSION,
  };
}

export interface Depth2Proposal {
  proposalKey: string;
  parentChannelId: string;
  edgeKind: GraphEdgeKind;
  depth: 2;
  fanout: number;
  provenance: string;
  policyVersion: string;
}

/** Build capped depth-2 proposal specs. Throws unless eligible (fail-closed). */
export function buildDepth2Proposals(
  parentChannelId: string,
  edgeKind: GraphEdgeKind,
  fanoutRequested: number,
  eligibility: Depth2Eligibility,
): Depth2Proposal[] {
  if (!eligibility.eligible) throw new Error(`GRAPH_DEPTH2_NOT_ELIGIBLE:${eligibility.reasonCode}`);
  if (!/^UC[A-Za-z0-9_-]{22}$/.test(parentChannelId)) throw new Error('GRAPH_INVALID_PARENT_CHANNEL');
  const out: Depth2Proposal[] = [];
  for (let i = 0; i < eligibility.cappedFanout; i++) {
    const key = createHash('sha256')
      .update(`${GRAPH_EXPANSION_POLICY_VERSION}:${parentChannelId}:${edgeKind}:2:${i}`)
      .digest('hex')
      .slice(0, 32);
    void fanoutRequested;
    out.push({
      proposalKey: key,
      parentChannelId,
      edgeKind,
      depth: 2,
      fanout: eligibility.cappedFanout,
      provenance: `depth2:${parentChannelId}:${edgeKind}:${eligibility.reasonCode}`,
      policyVersion: GRAPH_EXPANSION_POLICY_VERSION,
    });
  }
  return out;
}
