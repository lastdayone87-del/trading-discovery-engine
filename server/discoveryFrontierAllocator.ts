import { createHash } from 'node:crypto';
import { getDb } from './db';
import { getYouTubeQuotaDay, getYouTubeQuotaDayStartAt } from './youtubeQuotaDay';
import {
  type DiscoveryNeighborhoodDimensions,
  createNeighborhoodKey,
  buildDiscoveryNeighborhood
} from './discoveryNeighborhood';
import type { NeighborhoodFrontierState } from './discoveryFrontierState';
import { effectiveProjectionProposalEvidence } from './discoveryProposalGenerators';
import { isOsintSnapshotFresh } from './externalOsint';

export const PERSISTENT_RESEARCH_PHASE8_VERSION = 'discovery-frontier-allocator-v1';

export type DecisionStatus = 'RESERVED' | 'COMMITTED' | 'RELEASED' | 'DEFERRED';

export interface NeighborhoodCandidate {
  neighborhoodKey: string;
  country: string;
  dimensions: DiscoveryNeighborhoodDimensions;
  frontierState: NeighborhoodFrontierState;
  expectedMarginalValue: number;
  uncertainty: number;
  coverageGain: number;
  knownCreatorRatio: number;
  resultSetOverlap: number;
  isSaturating: boolean;
  proposalId?: string;
  proposalFamily?: string;
  proposalEvidenceSnapshot?: Record<string, unknown> | null;
  lastAllocatedAt?: string | null;
  recentAllocationCount: number;
  expectedQuotaCost: number;
}

export interface EligibilityResult {
  eligible: boolean;
  rejectionReasons: string[];
}

export interface ScoringComponents {
  expectedValueScore: number;
  explorationScore: number;
  saturationPenalty: number;
  concentrationPenalty: number;
  costEfficiency: number;
  totalScore: number;
}

export interface AllocationDecision {
  id?: string;
  decisionId: string;
  opportunityKey: string;
  allocationOrigin: 'LEGACY' | 'FRONTIER_SHADOW' | 'FRONTIER_CANARY';
  decisionStatus: DecisionStatus;
  legacyTargetCountry: string;
  legacyTargetNeighborhoodKey?: string | null;
  selectedNeighborhoodKey: string;
  selectedCountry: string;
  frontierState: string;
  expectedMarginalValue: number;
  uncertainty: number;
  coverageGain: number;
  saturationEvidence: {
    isSaturating: boolean;
    resultSetOverlap: number;
    knownCreatorRatio: number;
  };
  proposalId?: string | null;
  proposalEvidenceSnapshot?: Record<string, unknown> | null;
  selectionScore: number;
  scoreComponents: ScoringComponents;
  candidateNeighborhoodCount: number;
  rejectionReasons: Record<string, string[]>;
  agreedWithLegacy: boolean;
  deferred: boolean;
  queryRunId?: string | null;
  quotaReserved: number;
  quotaConsumed: number;
  quotaDay: string;
  policyVersion: string;
  createdAt?: string;
}

/**
 * Deterministically evaluates candidate eligibility for frontier resource allocation.
 */
export function evaluateNeighborhoodEligibility(
  candidate: NeighborhoodCandidate,
  options: {
    cooldownMinutes?: number;
    now?: Date;
  } = {}
): EligibilityResult {
  const reasons: string[] = [];
  const nowMs = (options.now || new Date()).getTime();
  const cooldownMs = (options.cooldownMinutes ?? 360) * 60_000;

  // 1. HARMFUL Exclusion
  if (candidate.frontierState === 'HARMFUL') {
    reasons.push('HARMFUL_NEIGHBORHOOD_EXCLUDED');
  }

  // 2. SATURATED Exclusion (Unless explicit maintenance/proposal override exists)
  if (candidate.frontierState === 'SATURATED' && candidate.resultSetOverlap >= 0.85 && candidate.knownCreatorRatio >= 0.85) {
    reasons.push('SATURATED_NEIGHBORHOOD_EXCLUDED');
  }

  // 3. Neighborhood Cooldown
  if (candidate.lastAllocatedAt) {
    const elapsedMs = nowMs - new Date(candidate.lastAllocatedAt).getTime();
    if (elapsedMs < cooldownMs) {
      reasons.push('NEIGHBORHOOD_COOLDOWN_ACTIVE');
    }
  }

  // 4. Excessive Recent Concentration
  if (candidate.recentAllocationCount >= 5) {
    reasons.push('NEIGHBORHOOD_CONCENTRATION_LIMIT_REACHED');
  }

  return {
    eligible: reasons.length === 0,
    rejectionReasons: reasons
  };
}

/**
 * Scores an eligible candidate neighborhood deterministically.
 */
export function scoreNeighborhoodCandidate(
  candidate: NeighborhoodCandidate,
  options: {
    explorationFloorActive?: boolean;
    explorationCeilingActive?: boolean;
  } = {}
): ScoringComponents {
  const expectedValueScore = Math.min(1.0, Math.max(0, candidate.expectedMarginalValue / 100));
  const proposalBonus = candidate.proposalId ? 0.2 : 0.0;
  const rawExploration = (candidate.uncertainty * 0.4) + (candidate.coverageGain * 0.4) + proposalBonus;
  const explorationScore = Math.min(1.0, Math.max(0, rawExploration));

  const saturationPenalty = Math.min(1.0, Math.max(0, (candidate.resultSetOverlap * 0.6) + (candidate.knownCreatorRatio * 0.4)));
  const concentrationPenalty = Math.min(1.0, Math.max(0, candidate.recentAllocationCount * 0.2));

  const costEfficiency = candidate.expectedQuotaCost > 0
    ? Math.min(1.0, (candidate.expectedMarginalValue / candidate.expectedQuotaCost) * 10)
    : 0.5;

  let valueWeight = 0.40;
  let explorationWeight = 0.35;

  if (options.explorationFloorActive) {
    explorationWeight = 0.55;
    valueWeight = 0.25;
  } else if (options.explorationCeilingActive) {
    explorationWeight = 0.15;
    valueWeight = 0.60;
  }

  const netScore =
    (expectedValueScore * valueWeight) +
    (explorationScore * explorationWeight) +
    (costEfficiency * 0.10) -
    (saturationPenalty * 0.10) -
    (concentrationPenalty * 0.05);

  const totalScore = Math.round(Math.max(0, netScore) * 10000) / 10000;

  return {
    expectedValueScore: Math.round(expectedValueScore * 1000) / 1000,
    explorationScore: Math.round(explorationScore * 1000) / 1000,
    saturationPenalty: Math.round(saturationPenalty * 1000) / 1000,
    concentrationPenalty: Math.round(concentrationPenalty * 0.05 * 1000) / 1000,
    costEfficiency: Math.round(costEfficiency * 1000) / 1000,
    totalScore
  };
}

/**
 * Calculates current Pacific quota day exploration status to enforce exploration floor & ceiling.
 */
export async function getPacificQuotaDayExplorationStatus(
  now = new Date(),
  client?: any
): Promise<{
  explorationRatio: number;
  explorationFloorActive: boolean;
  explorationCeilingActive: boolean;
}> {
  const db = client || (process.env.DATABASE_URL ? await getDb() : null);
  if (!db) {
    return { explorationRatio: 0, explorationFloorActive: false, explorationCeilingActive: false };
  }
  const quotaDay = getYouTubeQuotaDay(now);

  const [res, floorRes, ceilingRes] = await Promise.all([
    db.query(
      `SELECT
         COUNT(*)::int AS total_allocations,
         COUNT(*) FILTER (
           WHERE frontier_state IN ('UNEXPLORED', 'PROBING', 'UNKNOWN')
              OR uncertainty >= 0.5
         )::int AS exploration_allocations
       FROM frontier_allocation_decisions
       WHERE quota_day = $1 AND allocation_origin = 'FRONTIER_CANARY' AND decision_status IN ('RESERVED', 'COMMITTED')`,
      [quotaDay]
    ).catch(() => ({ rows: [{ total_allocations: 0, exploration_allocations: 0 }] })),
    db.query(
      `SELECT setting_value FROM app_settings WHERE setting_key = 'frontier_allocation_exploration_floor_ratio'`
    ).catch(() => ({ rows: [] })),
    db.query(
      `SELECT setting_value FROM app_settings WHERE setting_key = 'frontier_allocation_exploration_ceiling_ratio'`
    ).catch(() => ({ rows: [] }))
  ]);

  const total = Number(res.rows[0]?.total_allocations || 0);
  const exploration = Number(res.rows[0]?.exploration_allocations || 0);
  const ratio = total > 0 ? exploration / total : 0;

  const floorRatio = Number(floorRes.rows[0]?.setting_value ?? 0.20);
  const ceilingRatio = Number(ceilingRes.rows[0]?.setting_value ?? 0.30);

  return {
    explorationRatio: ratio,
    explorationFloorActive: total > 0 && ratio < floorRatio,
    explorationCeilingActive: total > 0 && ratio >= ceilingRatio
  };
}

/**
 * Fetches candidate neighborhoods from persistent store and proposals.
 * Only FRONTIER_CANARY allocations update production concentration and cooldown state.
 * FRONTIER_SHADOW recommendations have zero effect on production concentration.
 */
export async function getNeighborhoodCandidates(
  targetCountry?: string,
  now = new Date(),
  client?: any
): Promise<NeighborhoodCandidate[]> {
  const db = client || (process.env.DATABASE_URL ? await getDb() : null);
  if (!db) return [];
  const quotaDay = getYouTubeQuotaDay(now);

  const query = `
    SELECT
      n.neighborhood_key,
      n.country,
      n.dimensions,
      COALESCE(fs.state, 'UNEXPLORED') AS frontier_state,
      COALESCE(mv.expected_marginal_value, 0)::float AS expected_marginal_value,
      COALESCE((fs.evidence->>'uncertainty')::float, CASE WHEN fs.state = 'UNEXPLORED' THEN 1.0 ELSE 0.5 END) AS uncertainty,
      COALESCE((fs.evidence->>'coverageContribution')::float, 0.5) AS coverage_gain,
      COALESCE(obs.known_creator_ratio, 0)::float AS known_creator_ratio,
      COALESCE(obs.result_set_overlap, 0)::float AS result_set_overlap,
      COALESCE((fs.evidence->>'isSaturating')::boolean, false) AS is_saturating,
      p.proposal_id::text AS proposal_id,
      p.proposal_family,
      p.supporting_evidence AS proposal_supporting_evidence,
      p.source_provenance AS proposal_source_provenance,
      p.confidence AS proposal_confidence,
      recent.last_allocated_at,
      COALESCE(recent.alloc_count, 0)::int AS recent_allocation_count
    FROM discovery_neighborhoods n
    LEFT JOIN discovery_neighborhood_frontier_states fs ON fs.neighborhood_key = n.neighborhood_key
    LEFT JOIN LATERAL (
      SELECT expected_marginal_value
      FROM neighborhood_marginal_values
      WHERE neighborhood_key = n.neighborhood_key
      ORDER BY calculated_at DESC LIMIT 1
    ) mv ON true
    LEFT JOIN LATERAL (
      SELECT known_creator_ratio, result_set_overlap
      FROM neighborhood_observations
      WHERE neighborhood_key = n.neighborhood_key
      ORDER BY observed_at DESC LIMIT 1
    ) obs ON true
    LEFT JOIN LATERAL (
      SELECT proposal_id, proposal_family, supporting_evidence, source_provenance, confidence
      FROM frontier_discovery_proposals
      WHERE target_neighborhood_key = n.neighborhood_key
        AND trial_status = 'PENDING'
        AND (expires_at IS NULL OR expires_at > $1)
      ORDER BY created_at DESC LIMIT 1
    ) p ON true
    LEFT JOIN LATERAL (
      SELECT MAX(created_at)::text AS last_allocated_at, COUNT(*)::int AS alloc_count
      FROM frontier_allocation_decisions
      WHERE selected_neighborhood_key = n.neighborhood_key
        AND quota_day = $2
        AND allocation_origin = 'FRONTIER_CANARY'
        AND decision_status IN ('RESERVED', 'COMMITTED')
    ) recent ON true
    ${targetCountry ? 'WHERE LOWER(n.country) = LOWER($3)' : ''}
    ORDER BY n.updated_at DESC
    LIMIT 50
  `;

  const params = targetCountry ? [now.toISOString(), quotaDay, targetCountry] : [now.toISOString(), quotaDay];
  const res = await db.query(query, params);

  return res.rows.map((row: any) => {
    const rawDims = typeof row.dimensions === 'string' ? JSON.parse(row.dimensions) : (row.dimensions || {});
    const dimensions: DiscoveryNeighborhoodDimensions = {
      country: row.country || targetCountry || 'US',
      language: rawDims.language || null,
      queryIntent: rawDims.queryIntent || 'GENERAL',
      primaryTermFamily: rawDims.primaryTermFamily || 'trading',
      retrievalLane: rawDims.retrievalLane || 'KEYWORD_SEARCH',
      searchOrdering: rawDims.searchOrdering || 'RELEVANCE',
      instrumentOrTheme: rawDims.instrumentOrTheme || null,
      sourceFamily: rawDims.sourceFamily || 'automated_query'
    };

    return {
      neighborhoodKey: row.neighborhood_key,
      country: row.country,
      dimensions,
      frontierState: row.frontier_state as NeighborhoodFrontierState,
      expectedMarginalValue: Number(row.expected_marginal_value || 0),
      uncertainty: Number(row.uncertainty || 0.5),
      coverageGain: Number(row.coverage_gain || 0.5),
      knownCreatorRatio: Number(row.known_creator_ratio || 0),
      resultSetOverlap: Number(row.result_set_overlap || 0),
      isSaturating: Boolean(row.is_saturating),
      proposalId: row.proposal_id || undefined,
      proposalFamily: row.proposal_family || undefined,
      proposalEvidenceSnapshot: row.proposal_id ? {
        proposalFamily: row.proposal_family,
        sourceProvenance: row.proposal_source_provenance,
        confidence: Number(row.proposal_confidence),
        supportingEvidence: typeof row.proposal_supporting_evidence === 'string' ? JSON.parse(row.proposal_supporting_evidence) : row.proposal_supporting_evidence
      } : null,
      lastAllocatedAt: row.last_allocated_at || null,
      recentAllocationCount: Number(row.recent_allocation_count || 0),
      expectedQuotaCost: 100
    };
  });
}

/**
 * Evaluates a shadow frontier allocation decision for an assignment opportunity.
 * Zero scheduling authority: calculates and logs decision details without altering scheduling.
 */
export async function evaluateShadowFrontierAllocation(input: {
  opportunityKey: string;
  legacyCountry: string;
  legacyNeighborhoodKey?: string | null;
  candidates?: NeighborhoodCandidate[];
  now?: Date;
  client?: any;
}): Promise<AllocationDecision> {
  const now = input.now || new Date();
  const quotaDay = getYouTubeQuotaDay(now);
  const candidates = input.candidates || await getNeighborhoodCandidates(input.legacyCountry, now, input.client);
  const expStatus = await getPacificQuotaDayExplorationStatus(now, input.client).catch(() => ({
    explorationRatio: 0,
    explorationFloorActive: false,
    explorationCeilingActive: false
  }));

  const rejectionReasons: Record<string, string[]> = {};
  const eligibleCandidates: { candidate: NeighborhoodCandidate; score: ScoringComponents }[] = [];

  for (const cand of candidates) {
    const elig = evaluateNeighborhoodEligibility(cand, { now });
    if (!elig.eligible) {
      rejectionReasons[cand.neighborhoodKey] = elig.rejectionReasons;
      continue;
    }
    const score = scoreNeighborhoodCandidate(cand, expStatus);
    eligibleCandidates.push({ candidate: cand, score });
  }

  eligibleCandidates.sort((a, b) =>
    b.score.totalScore - a.score.totalScore ||
    a.candidate.neighborhoodKey.localeCompare(b.candidate.neighborhoodKey)
  );

  let selectedCandidate: NeighborhoodCandidate;
  let selectedScoreComponents: ScoringComponents;

  if (eligibleCandidates.length > 0) {
    selectedCandidate = eligibleCandidates[0].candidate;
    selectedScoreComponents = eligibleCandidates[0].score;
  } else if (candidates.length > 0) {
    selectedCandidate = candidates[0];
    selectedScoreComponents = scoreNeighborhoodCandidate(selectedCandidate, expStatus);
  } else {
    const dimensions: DiscoveryNeighborhoodDimensions = {
      country: input.legacyCountry,
      language: null,
      queryIntent: 'GENERAL',
      primaryTermFamily: 'trading',
      retrievalLane: 'KEYWORD_SEARCH',
      searchOrdering: 'RELEVANCE',
      instrumentOrTheme: null,
      sourceFamily: 'automated_query'
    };
    const key = createNeighborhoodKey(dimensions);
    selectedCandidate = {
      neighborhoodKey: key,
      country: input.legacyCountry,
      dimensions,
      frontierState: 'UNEXPLORED',
      expectedMarginalValue: 0,
      uncertainty: 1.0,
      coverageGain: 1.0,
      knownCreatorRatio: 0,
      resultSetOverlap: 0,
      isSaturating: false,
      recentAllocationCount: 0,
      expectedQuotaCost: 100
    };
    selectedScoreComponents = scoreNeighborhoodCandidate(selectedCandidate, expStatus);
  }

  const decisionId = createHash('sha256')
    .update(`${input.opportunityKey}:${selectedCandidate.neighborhoodKey}:${PERSISTENT_RESEARCH_PHASE8_VERSION}`)
    .digest('hex')
    .slice(0, 32);

  const agreedWithLegacy = input.legacyNeighborhoodKey
    ? input.legacyNeighborhoodKey === selectedCandidate.neighborhoodKey
    : input.legacyCountry.toLowerCase() === selectedCandidate.country.toLowerCase();

  const decision: AllocationDecision = {
    decisionId,
    opportunityKey: input.opportunityKey,
    allocationOrigin: 'FRONTIER_SHADOW',
    decisionStatus: 'COMMITTED',
    legacyTargetCountry: input.legacyCountry,
    legacyTargetNeighborhoodKey: input.legacyNeighborhoodKey || null,
    selectedNeighborhoodKey: selectedCandidate.neighborhoodKey,
    selectedCountry: selectedCandidate.country,
    frontierState: selectedCandidate.frontierState,
    expectedMarginalValue: selectedCandidate.expectedMarginalValue,
    uncertainty: selectedCandidate.uncertainty,
    coverageGain: selectedCandidate.coverageGain,
    saturationEvidence: {
      isSaturating: selectedCandidate.isSaturating,
      resultSetOverlap: selectedCandidate.resultSetOverlap,
      knownCreatorRatio: selectedCandidate.knownCreatorRatio
    },
    proposalId: selectedCandidate.proposalId || null,
    proposalEvidenceSnapshot: selectedCandidate.proposalEvidenceSnapshot || null,
    selectionScore: selectedScoreComponents.totalScore,
    scoreComponents: selectedScoreComponents,
    candidateNeighborhoodCount: candidates.length,
    rejectionReasons,
    agreedWithLegacy,
    deferred: false,
    quotaReserved: selectedCandidate.expectedQuotaCost,
    quotaConsumed: 0,
    quotaDay,
    policyVersion: PERSISTENT_RESEARCH_PHASE8_VERSION,
    createdAt: now.toISOString()
  };

  if (input.client || process.env.DATABASE_URL) {
    const db = input.client || await getDb();
    await db.query(
      `INSERT INTO frontier_allocation_decisions(
         decision_id, opportunity_key, allocation_origin, decision_status, legacy_target_country,
         legacy_target_neighborhood_key, selected_neighborhood_key, selected_country,
         frontier_state, expected_marginal_value, uncertainty, coverage_gain,
         saturation_evidence, proposal_id, selection_score, score_components,
         candidate_neighborhood_count, rejection_reasons, agreed_with_legacy,
         deferred, quota_reserved, quota_consumed, quota_day, policy_version,
         proposal_evidence_snapshot, proposal_evidence_checksum
       )
       VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)
       ON CONFLICT(decision_id) DO NOTHING`,
      [
        decision.decisionId,
        decision.opportunityKey,
        decision.allocationOrigin,
        decision.decisionStatus,
        decision.legacyTargetCountry,
        decision.legacyTargetNeighborhoodKey || null,
        decision.selectedNeighborhoodKey,
        decision.selectedCountry,
        decision.frontierState,
        decision.expectedMarginalValue,
        decision.uncertainty,
        decision.coverageGain,
        JSON.stringify(decision.saturationEvidence),
        decision.proposalId || null,
        decision.selectionScore,
        JSON.stringify(decision.scoreComponents),
        decision.candidateNeighborhoodCount,
        JSON.stringify(decision.rejectionReasons),
        decision.agreedWithLegacy,
        decision.deferred,
        decision.quotaReserved,
        decision.quotaConsumed,
        decision.quotaDay,
        decision.policyVersion,
        JSON.stringify(decision.proposalEvidenceSnapshot),
        decision.proposalEvidenceSnapshot ? createHash('sha256').update(JSON.stringify(decision.proposalEvidenceSnapshot)).digest('hex') : null
      ]
    ).catch((error: unknown) => console.warn('[FrontierAllocator] Failed to persist shadow decision:', error));
  }

  return decision;
}

/**
 * Evaluates production canary frontier authority and reserves capacity.
 * Status is set to 'RESERVED'. Must be committed via commitAllocationQueryRun or released via releaseAllocationDecision.
 */
export async function evaluateFrontierCanaryAllocation(input: {
  opportunityKey: string;
  legacyCountry: string;
  legacyNeighborhoodKey?: string | null;
  allowedCountries?: string[];
  estimatedQuotaUnits?: number;
  availableAutonomousCapacity?: number;
  now?: Date;
  client?: any;
}): Promise<{
  authorized: boolean;
  allocationOrigin: 'FRONTIER_CANARY' | 'LEGACY';
  country: string;
  targetNeighborhoodDimensions?: DiscoveryNeighborhoodDimensions;
  decision?: AllocationDecision;
  reason: string;
}> {
  const now = input.now || new Date();
  const quotaDay = getYouTubeQuotaDay(now);
  const estimatedQuota = input.estimatedQuotaUnits ?? 100;

  // 1. Subordination Guard: Verify remaining autonomous capacity is available
  if (input.availableAutonomousCapacity !== undefined && input.availableAutonomousCapacity <= 0) {
    return {
      authorized: false,
      allocationOrigin: 'LEGACY',
      country: input.legacyCountry,
      reason: 'AUTONOMOUS_CAPACITY_EXHAUSTED'
    };
  }

  if (!input.client && !process.env.DATABASE_URL) {
    return {
      authorized: false,
      allocationOrigin: 'LEGACY',
      country: input.legacyCountry,
      reason: 'FRONTIER_ALLOCATION_DISABLED'
    };
  }

  const db = input.client || await getDb();

  // 2. Check Global Authority Setting (Fail Closed)
  try {
    const settingRes = await db.query(
      `SELECT setting_value FROM app_settings WHERE setting_key = 'frontier_allocation_enabled'`
    );
    const enabled = settingRes.rows[0]?.setting_value === 'true';
    if (!enabled) {
      return {
        authorized: false,
        allocationOrigin: 'LEGACY',
        country: input.legacyCountry,
        reason: 'FRONTIER_ALLOCATION_DISABLED'
      };
    }
  } catch (error) {
    return {
      authorized: false,
      allocationOrigin: 'LEGACY',
      country: input.legacyCountry,
      reason: `FAILED_TO_VERIFY_SETTING: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  // 3. Concurrency-Safe Capacity Check under Advisory Lock
  const client = input.client ? null : await (await getDb()).connect();
  const runner = input.client || client;

  try {
    if (client) await runner.query('BEGIN');

    // Acquire transaction advisory lock for allocation authority
    await runner.query('SELECT pg_advisory_xact_lock(741963286)');

    // A process can die after Phase 8 reserves but before the scheduling transaction.
    // Expire those orphaned reservations under the allocation authority lock.
    await runner.query(
      `UPDATE frontier_allocation_decisions
       SET decision_status='RELEASED',deferred=true,quota_reserved=0,
           rejection_reasons=jsonb_set(COALESCE(rejection_reasons,'{}'::jsonb),'{releaseReason}',to_jsonb('STALE_RESERVATION_RECOVERED'::text))
       WHERE allocation_origin='FRONTIER_CANARY' AND decision_status='RESERVED'
         AND created_at < now()-interval '20 minutes'`
    );

    // Read Configurable Caps
    const [assignCapRes, quotaCapRes] = await Promise.all([
      runner.query(`SELECT setting_value FROM app_settings WHERE setting_key = 'frontier_allocation_daily_assignment_cap'`),
      runner.query(`SELECT setting_value FROM app_settings WHERE setting_key = 'frontier_allocation_daily_quota_cap'`)
    ]);

    const assignmentCap = Number(assignCapRes.rows[0]?.setting_value ?? 10);
    const quotaCap = Number(quotaCapRes.rows[0]?.setting_value ?? 1000);

    // Query active reserved + committed usage in active Pacific quota day
    const usageRes = await runner.query(
      `SELECT
         COUNT(*)::int AS daily_assignments,
         COALESCE(SUM(GREATEST(quota_reserved, quota_consumed)), 0)::int AS daily_quota_used
       FROM frontier_allocation_decisions
       WHERE quota_day = $1
         AND allocation_origin = 'FRONTIER_CANARY'
         AND decision_status IN ('RESERVED', 'COMMITTED')`,
      [quotaDay]
    );

    const dailyAssignments = Number(usageRes.rows[0]?.daily_assignments || 0);
    const dailyQuotaUsed = Number(usageRes.rows[0]?.daily_quota_used || 0);

    if (dailyAssignments >= assignmentCap || dailyQuotaUsed + estimatedQuota > quotaCap) {
      if (client) await runner.query('COMMIT');
      return {
        authorized: false,
        allocationOrigin: 'LEGACY',
        country: input.legacyCountry,
        reason: `FRONTIER_CANARY_DAILY_CAP_EXCEEDED (assignments: ${dailyAssignments}/${assignmentCap}, quota: ${dailyQuotaUsed + estimatedQuota}/${quotaCap})`
      };
    }

    // Fetch Candidates & Score
    const candidates = await getNeighborhoodCandidates(
      input.allowedCountries?.length === 1 ? input.allowedCountries[0] : undefined,
      now,
      runner
    );

    const expStatus = await getPacificQuotaDayExplorationStatus(now, runner);
    const rejectionReasons: Record<string, string[]> = {};
    const eligibleCandidates: { candidate: NeighborhoodCandidate; score: ScoringComponents }[] = [];

    for (const cand of candidates) {
      if (input.allowedCountries && input.allowedCountries.length > 0) {
        if (!input.allowedCountries.map(c => c.toLowerCase()).includes(cand.country.toLowerCase())) {
          rejectionReasons[cand.neighborhoodKey] = ['COUNTRY_NOT_ALLOWED'];
          continue;
        }
      }

      const elig = evaluateNeighborhoodEligibility(cand, { now });
      if (!isOsintSnapshotFresh(cand.proposalEvidenceSnapshot || {}, now)) {
        rejectionReasons[cand.neighborhoodKey] = ['STALE_OSINT_EVIDENCE'];
        continue;
      }
      if (!elig.eligible) {
        rejectionReasons[cand.neighborhoodKey] = elig.rejectionReasons;
        continue;
      }

      const score = scoreNeighborhoodCandidate(cand, expStatus);
      eligibleCandidates.push({ candidate: cand, score });
    }

    eligibleCandidates.sort((a, b) =>
      b.score.totalScore - a.score.totalScore ||
      a.candidate.neighborhoodKey.localeCompare(b.candidate.neighborhoodKey)
    );

    if (eligibleCandidates.length === 0) {
      if (client) await runner.query('COMMIT');
      return {
        authorized: false,
        allocationOrigin: 'LEGACY',
        country: input.legacyCountry,
        reason: 'NO_ELIGIBLE_FRONTIER_CANARY_CANDIDATE'
      };
    }

    const topCandidate = eligibleCandidates[0].candidate;
    const topScore = eligibleCandidates[0].score;
    let lockedProposalSnapshot = topCandidate.proposalEvidenceSnapshot || null;
    if (topCandidate.proposalId) {
      const selectedEvidence = (topCandidate.proposalEvidenceSnapshot?.supportingEvidence || {}) as Record<string, unknown>;
      const canonicalTermId = Number(selectedEvidence.canonicalTermId);
      if (Number.isSafeInteger(canonicalTermId) && canonicalTermId > 0) {
        await runner.query('SELECT id FROM canonical_trading_terms WHERE id=$1 FOR SHARE', [canonicalTermId]);
        const projection = await runner.query(
          `SELECT native_evidence_status,source_provenance_family,source_provenance_families,
                  bootstrap_seed_count,native_quality_creator_count,structured_entity_matched,
                  native_proposal_eligible,evidence_revision,updated_at
           FROM country_native_evidence_projections WHERE canonical_term_id=$1 FOR SHARE`,
          [canonicalTermId]
        );
        const row = projection.rows[0];
        const effective = row ? effectiveProjectionProposalEvidence(row) : null;
        if (!row?.native_proposal_eligible || !effective ||
            String(row.evidence_revision || '0') !== String(selectedEvidence.evidenceRevision || '0') ||
            new Date(row.updated_at).getTime() !== new Date(String(selectedEvidence.projectionRevision || 0)).getTime() ||
            effective.nativeEvidenceStatus !== selectedEvidence.nativeEvidenceStatus ||
            effective.sourceProvenanceFamily !== selectedEvidence.sourceProvenanceFamily) {
          if (client) await runner.query('COMMIT');
          return { authorized: false, allocationOrigin: 'LEGACY', country: input.legacyCountry, reason: 'STALE_FRONTIER_PROPOSAL_EVIDENCE' };
        }
      }
      const lockedProposal = await runner.query(
        `SELECT proposal_family,source_provenance,supporting_evidence,confidence,target_neighborhood_key,target_dimensions
         FROM frontier_discovery_proposals
         WHERE proposal_id=$1 AND trial_status='PENDING' AND (expires_at IS NULL OR expires_at>$2)
         FOR UPDATE`,
        [topCandidate.proposalId, now.toISOString()]
      );
      if (!lockedProposal.rowCount) {
        if (client) await runner.query('COMMIT');
        return { authorized: false, allocationOrigin: 'LEGACY', country: input.legacyCountry, reason: 'STALE_FRONTIER_PROPOSAL_STATE' };
      }
      const locked = lockedProposal.rows[0];
      const lockedEvidence = typeof locked.supporting_evidence === 'string' ? JSON.parse(locked.supporting_evidence) : locked.supporting_evidence || {};
      const lockedDimensions = typeof locked.target_dimensions === 'string' ? JSON.parse(locked.target_dimensions) : locked.target_dimensions;
      if (lockedEvidence.evidenceChecksum !== selectedEvidence.evidenceChecksum ||
          locked.source_provenance !== topCandidate.proposalEvidenceSnapshot?.sourceProvenance ||
          Number(locked.confidence) !== Number(topCandidate.proposalEvidenceSnapshot?.confidence) ||
          locked.target_neighborhood_key !== topCandidate.neighborhoodKey ||
          createNeighborhoodKey(lockedDimensions) !== topCandidate.neighborhoodKey) {
        if (client) await runner.query('COMMIT');
        return { authorized: false, allocationOrigin: 'LEGACY', country: input.legacyCountry, reason: 'STALE_FRONTIER_PROPOSAL_SNAPSHOT' };
      }
      lockedProposalSnapshot = {
        proposalFamily: locked.proposal_family,
        sourceProvenance: locked.source_provenance,
        confidence: Number(locked.confidence),
        targetNeighborhoodKey: locked.target_neighborhood_key,
        targetDimensions: lockedDimensions,
        supportingEvidence: lockedEvidence
      };
      if (!isOsintSnapshotFresh(lockedProposalSnapshot, now)) {
        if (client) await runner.query('COMMIT');
        return { authorized: false, allocationOrigin: 'LEGACY', country: input.legacyCountry, reason: 'STALE_OSINT_EVIDENCE' };
      }
    }

    const decisionId = createHash('sha256')
      .update(`${input.opportunityKey}:${topCandidate.neighborhoodKey}:canary:${PERSISTENT_RESEARCH_PHASE8_VERSION}`)
      .digest('hex')
      .slice(0, 32);

    const agreedWithLegacy = input.legacyNeighborhoodKey
      ? input.legacyNeighborhoodKey === topCandidate.neighborhoodKey
      : input.legacyCountry.toLowerCase() === topCandidate.country.toLowerCase();

    const decision: AllocationDecision = {
      decisionId,
      opportunityKey: input.opportunityKey,
      allocationOrigin: 'FRONTIER_CANARY',
      decisionStatus: 'RESERVED',
      legacyTargetCountry: input.legacyCountry,
      legacyTargetNeighborhoodKey: input.legacyNeighborhoodKey || null,
      selectedNeighborhoodKey: topCandidate.neighborhoodKey,
      selectedCountry: topCandidate.country,
      frontierState: topCandidate.frontierState,
      expectedMarginalValue: topCandidate.expectedMarginalValue,
      uncertainty: topCandidate.uncertainty,
      coverageGain: topCandidate.coverageGain,
      saturationEvidence: {
        isSaturating: topCandidate.isSaturating,
        resultSetOverlap: topCandidate.resultSetOverlap,
        knownCreatorRatio: topCandidate.knownCreatorRatio
      },
      proposalId: topCandidate.proposalId || null,
      proposalEvidenceSnapshot: lockedProposalSnapshot,
      selectionScore: topScore.totalScore,
      scoreComponents: topScore,
      candidateNeighborhoodCount: candidates.length,
      rejectionReasons,
      agreedWithLegacy,
      deferred: false,
      quotaReserved: estimatedQuota,
      quotaConsumed: 0,
      quotaDay,
      policyVersion: PERSISTENT_RESEARCH_PHASE8_VERSION,
      createdAt: now.toISOString()
    };

    await runner.query(
      `INSERT INTO frontier_allocation_decisions(
         decision_id, opportunity_key, allocation_origin, decision_status, legacy_target_country,
         legacy_target_neighborhood_key, selected_neighborhood_key, selected_country,
         frontier_state, expected_marginal_value, uncertainty, coverage_gain,
         saturation_evidence, proposal_id, selection_score, score_components,
         candidate_neighborhood_count, rejection_reasons, agreed_with_legacy,
         deferred, quota_reserved, quota_consumed, quota_day, policy_version,
         proposal_evidence_snapshot, proposal_evidence_checksum
       )
       VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)
       ON CONFLICT(decision_id) DO NOTHING`,
      [
        decision.decisionId,
        decision.opportunityKey,
        decision.allocationOrigin,
        decision.decisionStatus,
        decision.legacyTargetCountry,
        decision.legacyTargetNeighborhoodKey || null,
        decision.selectedNeighborhoodKey,
        decision.selectedCountry,
        decision.frontierState,
        decision.expectedMarginalValue,
        decision.uncertainty,
        decision.coverageGain,
        JSON.stringify(decision.saturationEvidence),
        decision.proposalId || null,
        decision.selectionScore,
        JSON.stringify(decision.scoreComponents),
        decision.candidateNeighborhoodCount,
        JSON.stringify(decision.rejectionReasons),
        decision.agreedWithLegacy,
        decision.deferred,
        decision.quotaReserved,
        decision.quotaConsumed,
        decision.quotaDay,
        decision.policyVersion,
        JSON.stringify(decision.proposalEvidenceSnapshot),
        decision.proposalEvidenceSnapshot ? createHash('sha256').update(JSON.stringify(decision.proposalEvidenceSnapshot)).digest('hex') : null
      ]
    );

    if (client) await runner.query('COMMIT');

    return {
      authorized: true,
      allocationOrigin: 'FRONTIER_CANARY',
      country: topCandidate.country,
      targetNeighborhoodDimensions: topCandidate.dimensions,
      decision,
      reason: 'FRONTIER_CANARY_AUTHORIZED'
    };
  } catch (error) {
    if (client) await runner.query('ROLLBACK').catch(() => undefined);
    return {
      authorized: false,
      allocationOrigin: 'LEGACY',
      country: input.legacyCountry,
      reason: `FRONTIER_CANARY_EVALUATION_ERROR: ${error instanceof Error ? error.message : String(error)}`
    };
  } finally {
    if (client) client.release();
  }
}

/**
 * Releases a reserved allocation decision via an atomic RESERVED -> RELEASED transition.
 * Requires allocation_origin = 'FRONTIER_CANARY' and decision_status = 'RESERVED'.
 * Fails closed and returns false if decision was COMMITTED, RELEASED, DEFERRED, or unknown.
 */
export async function releaseAllocationDecision(
  decisionId: string,
  reason: string,
  clientOverride?: any
): Promise<boolean> {
  const runner = clientOverride || (process.env.DATABASE_URL ? await getDb() : null);
  if (!runner) return false;

  const res = await runner.query(
    `UPDATE frontier_allocation_decisions
     SET decision_status = 'RELEASED',
         deferred = true,
         quota_reserved = 0,
         rejection_reasons = jsonb_set(
           COALESCE(rejection_reasons, '{}'::jsonb),
           '{releaseReason}',
           to_jsonb($2::text)
         )
     WHERE decision_id = $1
       AND allocation_origin = 'FRONTIER_CANARY'
       AND decision_status = 'RESERVED'`,
    [decisionId, reason]
  ).catch((error: unknown) => {
    console.warn('[FrontierAllocator] Failed to release allocation decision:', error);
    return { rowCount: 0 };
  });

  return (res?.rowCount ?? 0) > 0;
}

/**
 * Marks a frontier allocation decision as deferred when Query Intelligence cannot construct an action.
 */
export async function markAllocationDecisionDeferred(
  decisionId: string,
  reason: string,
  clientOverride?: any
): Promise<boolean> {
  return releaseAllocationDecision(decisionId, reason, clientOverride);
}

/**
 * Atomically releases an unexecutable reservation and terminally quarantines only its
 * still-pending proposal. Executability is part of proposal identity, so evidence refresh
 * must never resurrect it; a materially different proposal receives a different dedup key.
 */
export async function quarantineUnexecutableAllocation(
  decisionId: string,
  reason: string,
  clientOverride?: any
): Promise<boolean> {
  const db = clientOverride || await getDb();
  const client = clientOverride ? null : await db.connect();
  const runner = clientOverride || client;
  try {
    if (client) await runner.query('BEGIN');
    const decision = await runner.query(
      `UPDATE frontier_allocation_decisions
       SET decision_status='DEFERRED', deferred=true, quota_reserved=0,
           rejection_reasons=jsonb_set(COALESCE(rejection_reasons,'{}'::jsonb),'{releaseReason}',to_jsonb($2::text))
       WHERE decision_id=$1 AND allocation_origin='FRONTIER_CANARY' AND decision_status='RESERVED'
       RETURNING proposal_id`, [decisionId, reason]
    );
    if (decision.rowCount && decision.rows[0].proposal_id) {
      await runner.query(
        `UPDATE frontier_discovery_proposals SET trial_status='EXPIRED'
         WHERE proposal_id=$1 AND trial_status='PENDING'`, [decision.rows[0].proposal_id]
      );
    }
    if (client) await runner.query('COMMIT');
    return Boolean(decision.rowCount);
  } catch (error) {
    if (client) await runner.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    if (client) client.release();
  }
}

/**
 * Commits a reserved allocation decision via a guarded atomic state transition (RESERVED -> COMMITTED).
 * Requires allocation_origin = 'FRONTIER_CANARY' and decision_status = 'RESERVED'.
 * Fails closed and returns false if decision was RELEASED, DEFERRED, COMMITTED, or unknown.
 */
export async function commitAllocationQueryRun(
  decisionId: string,
  queryRunId: string,
  clientOverride?: any
): Promise<boolean> {
  const runner = clientOverride || (process.env.DATABASE_URL ? await getDb() : null);
  if (!runner) return false;

  const client = clientOverride ? null : await (await getDb()).connect();
  const activeRunner = clientOverride || client;

  try {
    if (client) await activeRunner.query('BEGIN');

    const res = await activeRunner.query(
      `UPDATE frontier_allocation_decisions
       SET decision_status = 'COMMITTED',
           query_run_id = $2
       WHERE decision_id = $1
         AND allocation_origin = 'FRONTIER_CANARY'
         AND decision_status = 'RESERVED'
         AND (query_run_id IS NULL OR query_run_id = $2)
       RETURNING id, allocation_origin`,
      [decisionId, queryRunId]
    );

    if (!res.rowCount) {
      if (client) await activeRunner.query('ROLLBACK');
      console.warn(`[FrontierAllocator] Commit rejected: decision ${decisionId} is not an active RESERVED canary decision.`);
      return false;
    }

    await activeRunner.query(
      `UPDATE query_runs
       SET allocation_origin = 'FRONTIER_CANARY'
       WHERE id = $1`,
      [queryRunId]
    );

    if (client) await activeRunner.query('COMMIT');
    return true;
  } catch (error) {
    if (client) await activeRunner.query('ROLLBACK').catch(() => undefined);
    console.warn('[FrontierAllocator] Failed to commit query run:', error);
    return false;
  } finally {
    if (client) client.release();
  }
}

/**
 * Binds a query run ID to a frontier allocation decision (alias for commit).
 */
export async function bindAllocationQueryRun(
  decisionId: string,
  queryRunId: string,
  clientOverride?: any
): Promise<boolean> {
  return commitAllocationQueryRun(decisionId, queryRunId, clientOverride);
}

/**
 * Retrieves comprehensive operational diagnostics for Phase 8 allocation authority.
 */
export async function getFrontierAllocationDiagnostics(): Promise<Record<string, unknown>> {
  if (!process.env.DATABASE_URL) return {};
  const db = await getDb();

  const [
    countsByOrigin,
    quotaByOrigin,
    selectedNeighborhoods,
    stateDistribution,
    rejectionBreakdown,
    explorationVsExploitation,
    deferredCount
  ] = await Promise.all([
    db.query(`SELECT allocation_origin, COUNT(*)::int AS count FROM frontier_allocation_decisions GROUP BY allocation_origin`),
    db.query(`SELECT allocation_origin, COALESCE(SUM(quota_reserved), 0)::int AS total_quota_reserved, COALESCE(SUM(quota_consumed), 0)::int AS total_quota_consumed FROM frontier_allocation_decisions GROUP BY allocation_origin`),
    db.query(`SELECT selected_neighborhood_key, selected_country, COUNT(*)::int AS allocation_count FROM frontier_allocation_decisions WHERE allocation_origin = 'FRONTIER_CANARY' AND decision_status = 'COMMITTED' GROUP BY selected_neighborhood_key, selected_country ORDER BY allocation_count DESC LIMIT 20`),
    db.query(`SELECT frontier_state, COUNT(*)::int AS count FROM frontier_allocation_decisions WHERE allocation_origin = 'FRONTIER_CANARY' AND decision_status = 'COMMITTED' GROUP BY frontier_state`),
    db.query(`SELECT jsonb_object_keys(rejection_reasons) AS rejection_reason, COUNT(*)::int AS count FROM frontier_allocation_decisions GROUP BY jsonb_object_keys(rejection_reasons)`).catch(() => ({ rows: [] })),
    db.query(`SELECT CASE WHEN frontier_state IN ('UNEXPLORED', 'PROBING', 'UNKNOWN') OR uncertainty >= 0.5 THEN 'EXPLORATION' ELSE 'EXPLOITATION' END AS allocation_type, COUNT(*)::int AS count FROM frontier_allocation_decisions WHERE allocation_origin = 'FRONTIER_CANARY' AND decision_status = 'COMMITTED' GROUP BY 1`),
    db.query(`SELECT COUNT(*)::int AS count FROM frontier_allocation_decisions WHERE deferred = true OR decision_status = 'RELEASED'`)
  ]);

  return {
    allocationsByOrigin: Object.fromEntries(countsByOrigin.rows.map(r => [r.allocation_origin, r.count])),
    quotaByOrigin: Object.fromEntries(quotaByOrigin.rows.map(r => [r.allocation_origin, { reserved: r.total_quota_reserved, consumed: r.total_quota_consumed }])),
    topSelectedNeighborhoods: selectedNeighborhoods.rows,
    canaryStateDistribution: Object.fromEntries(stateDistribution.rows.map(r => [r.frontier_state, r.count])),
    rejectionReasonCounts: Object.fromEntries(rejectionBreakdown.rows.map(r => [r.rejection_reason, r.count])),
    explorationVsExploitation: Object.fromEntries(explorationVsExploitation.rows.map(r => [r.allocation_type, r.count])),
    deferredCanarySelectionsCount: deferredCount.rows[0]?.count || 0
  };
}

/**
 * Compares legacy control vs frontier canary allocation outcomes.
 */
export async function getFrontierAllocationControlComparison(windowDays = 7): Promise<{
  legacyControl: Record<string, unknown>;
  frontierCanary: Record<string, unknown>;
}> {
  if (!process.env.DATABASE_URL) {
    return { legacyControl: {}, frontierCanary: {} };
  }
  const db = await getDb();

  const [legacyRes, canaryRes] = await Promise.all([
    db.query(
      `SELECT
         COUNT(*)::int AS run_count,
         COALESCE(SUM(quota_used), 0)::int AS total_quota,
         COALESCE(SUM(new_channels), 0)::int AS new_creators,
         COALESCE(SUM(trading_confirmed), 0)::int AS relevant_creators,
         COALESCE(SUM(quality_channels), 0)::int AS quality_creators,
         COUNT(DISTINCT country)::int AS distinct_countries
       FROM query_runs
       WHERE created_at >= now() - ($1 || ' days')::interval
         AND COALESCE(allocation_origin, 'LEGACY') = 'LEGACY'`,
      [windowDays]
    ),
    db.query(
      `SELECT
         COUNT(*)::int AS run_count,
         COALESCE(SUM(quota_used), 0)::int AS total_quota,
         COALESCE(SUM(new_channels), 0)::int AS new_creators,
         COALESCE(SUM(trading_confirmed), 0)::int AS relevant_creators,
         COALESCE(SUM(quality_channels), 0)::int AS quality_creators,
         COUNT(DISTINCT country)::int AS distinct_countries
       FROM query_runs
       WHERE created_at >= now() - ($1 || ' days')::interval
         AND allocation_origin = 'FRONTIER_CANARY'`,
      [windowDays]
    )
  ]);

  const lRow = legacyRes.rows[0] || {};
  const cRow = canaryRes.rows[0] || {};
  const lQuota = Math.max(1, lRow.total_quota || 0);
  const cQuota = Math.max(1, cRow.total_quota || 0);

  return {
    legacyControl: {
      runs: lRow.run_count || 0,
      totalQuota: lQuota,
      newCreators: lRow.new_creators || 0,
      relevantNewCreators: lRow.relevant_creators || 0,
      qualityNewCreators: lRow.quality_creators || 0,
      relevantYieldPer1000Quota: Math.round(((lRow.relevant_creators || 0) / lQuota) * 1000 * 100) / 100,
      qualityYieldPer1000Quota: Math.round(((lRow.quality_creators || 0) / lQuota) * 1000 * 100) / 100,
      distinctCountries: lRow.distinct_countries || 0
    },
    frontierCanary: {
      runs: cRow.run_count || 0,
      totalQuota: cQuota,
      newCreators: cRow.new_creators || 0,
      relevantNewCreators: cRow.relevant_creators || 0,
      qualityNewCreators: cRow.quality_creators || 0,
      relevantYieldPer1000Quota: Math.round(((cRow.relevant_creators || 0) / cQuota) * 1000 * 100) / 100,
      qualityYieldPer1000Quota: Math.round(((cRow.quality_creators || 0) / cQuota) * 1000 * 100) / 100,
      distinctCountries: cRow.distinct_countries || 0
    }
  };
}
