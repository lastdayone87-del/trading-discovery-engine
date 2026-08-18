import { getDb, getAppSetting } from './db';
import { getNeighborhoodFrontierState } from './discoveryFrontierState';
import type { DiscoveryFrontierProposal } from './discoveryProposalGenerators';

export type TrialStatus = 'INITIATED' | 'COMPLETED' | 'FAILED' | 'KILLED';
export type TrialOutcomeState = 'PRODUCTIVE' | 'PROMISING' | 'UNCERTAIN' | 'SATURATED' | 'NOISY' | 'HARMFUL';

export interface FrontierTrialMetrics {
  creatorsReturned: number;
  distinctCreators: number;
  newCreators: number;
  relevantNewCreators: number;
  qualityNewCreators: number;
  knownChannelOverlap: number;
  neighborhoodOverlap: number;
  quotaConsumed: number;
  marginalDiscoveryValue: number;
  coverageGain: number;
}

export interface FrontierCanaryTrial {
  trialId?: string;
  trialKey: string;
  proposalId: string;
  queryRunId?: string | null;
  country: string;
  neighborhoodKey?: string | null;
  quotaReserved: number;
  quotaConsumed: number;
  trialStatus: TrialStatus;
  outcomeState?: TrialOutcomeState | null;
  metrics?: FrontierTrialMetrics | null;
  retrievalConfig?: Record<string, unknown>;
  initiatedAt?: string;
  completedAt?: string | null;
}

export interface TrialGateResult {
  eligible: boolean;
  reason: string;
  proposal?: DiscoveryFrontierProposal;
}

/**
 * Classifies trial outcome state based on actual trial execution metrics.
 */
export function classifyTrialOutcomeState(metrics: FrontierTrialMetrics): TrialOutcomeState {
  if (metrics.distinctCreators === 0) return 'NOISY';

  if (metrics.relevantNewCreators > 0 && metrics.qualityNewCreators > 0) {
    return 'PRODUCTIVE';
  }

  if (metrics.relevantNewCreators > 0 || metrics.coverageGain >= 0.20) {
    return 'PROMISING';
  }

  if (metrics.knownChannelOverlap >= 0.80 || metrics.neighborhoodOverlap >= 0.80) {
    return 'SATURATED';
  }

  if (metrics.quotaConsumed >= 100 && metrics.relevantNewCreators === 0 && metrics.knownChannelOverlap < 0.10) {
    return 'HARMFUL';
  }

  return 'UNCERTAIN';
}

/**
 * Evaluates whether a proposal passes the strict trial gate for canary execution.
 */
export async function evaluateTrialGate(
  proposalId: string
): Promise<TrialGateResult> {
  const db = await getDb();

  // 1. Explicit Kill Switch Check
  const killSwitch = await getAppSetting('frontier_trials_enabled', 'true');
  if (killSwitch === 'false') {
    return { eligible: false, reason: 'Frontier trials are globally disabled by operator kill switch.' };
  }

  // 2. Proposal Fetch & Validation
  const propRes = await db.query(
    `SELECT proposal_id, dedup_key, proposal_family, country, language, concept,
            target_neighborhood_key, target_dimensions, source_provenance,
            supporting_evidence, confidence, novelty_rationale, trial_status, expires_at
     FROM frontier_discovery_proposals
     WHERE proposal_id = $1`,
    [proposalId]
  );

  if (!propRes.rows.length) {
    return { eligible: false, reason: 'Proposal ID not found.' };
  }

  const row = propRes.rows[0];
  if (row.trial_status !== 'PENDING') {
    return { eligible: false, reason: `Proposal trial_status is ${row.trial_status}, expected PENDING.` };
  }

  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
    return { eligible: false, reason: 'Proposal has expired.' };
  }

  // 3. Neighborhood Eligibility Check
  if (row.target_neighborhood_key) {
    const stateRecord = await getNeighborhoodFrontierState(row.target_neighborhood_key);
    if (stateRecord && stateRecord.state === 'HARMFUL') {
      return { eligible: false, reason: 'Target neighborhood is classified as HARMFUL.' };
    }
  }

  // 4. Cooldown & Active Trial Check
  const trialRes = await db.query(
    `SELECT trial_id, initiated_at
     FROM frontier_canary_trials
     WHERE proposal_id = $1 AND trial_status IN ('INITIATED', 'COMPLETED')
     LIMIT 1`,
    [proposalId]
  );

  if (trialRes.rows.length > 0) {
    return { eligible: false, reason: 'Trial already exists or active for this proposal.' };
  }

  // 5. Daily Canary Quota Safety Cap Check (Max 500 units/day for canary trials)
  const quotaRes = await db.query(
    `SELECT COALESCE(SUM(quota_consumed), 0)::int AS daily_quota
     FROM frontier_canary_trials
     WHERE initiated_at >= now() - interval '24 hours'`
  );

  const dailyQuotaUsed = quotaRes.rows[0]?.daily_quota || 0;
  if (dailyQuotaUsed >= 500) {
    return { eligible: false, reason: `Daily canary trial quota cap (500 units) reached (${dailyQuotaUsed} units used).` };
  }

  const proposal: DiscoveryFrontierProposal = {
    proposalId: row.proposal_id,
    dedupKey: row.dedup_key,
    proposalFamily: row.proposal_family,
    country: row.country,
    language: row.language,
    concept: row.concept,
    targetNeighborhoodKey: row.target_neighborhood_key,
    targetDimensions: typeof row.target_dimensions === 'string' ? JSON.parse(row.target_dimensions) : row.target_dimensions,
    sourceProvenance: row.source_provenance,
    supportingEvidence: typeof row.supporting_evidence === 'string' ? JSON.parse(row.supporting_evidence) : row.supporting_evidence,
    confidence: Number(row.confidence),
    noveltyRationale: row.novelty_rationale,
    trialStatus: row.trial_status,
    expiresAt: row.expires_at
  };

  return { eligible: true, reason: 'Passed all trial gate and safety boundary checks.', proposal };
}

/**
 * Initiates a canary trial for an eligible proposal under hard canary boundaries.
 */
export async function initiateCanaryTrial(
  proposalId: string,
  options: { maxQuota?: number; pageDepth?: number } = {}
): Promise<FrontierCanaryTrial> {
  const gate = await evaluateTrialGate(proposalId);
  if (!gate.eligible || !gate.proposal) {
    throw new Error(`Trial gate rejected proposal: ${gate.reason}`);
  }

  const proposal = gate.proposal;
  const db = await getDb();
  const trialKey = `trial:${proposal.proposalId}:${Date.now()}`;
  const quotaReserved = Math.min(100, options.maxQuota ?? 100); // Hard quota cap: 100 units

  const res = await db.query(
    `INSERT INTO frontier_canary_trials(
       trial_key, proposal_id, country, neighborhood_key, quota_reserved,
       trial_status, retrieval_config
     )
     VALUES($1, $2, $3, $4, $5, 'INITIATED', $6)
     RETURNING trial_id, trial_key, proposal_id, country, neighborhood_key,
               quota_reserved, quota_consumed, trial_status, initiated_at`,
    [
      trialKey,
      proposal.proposalId,
      proposal.country,
      proposal.targetNeighborhoodKey,
      quotaReserved,
      JSON.stringify({
        maxQuota: quotaReserved,
        pageDepthCap: Math.min(1, options.pageDepth ?? 1),
        proposalFamily: proposal.proposalFamily,
        concept: proposal.concept
      })
    ]
  );

  // Update proposal status to TRIED
  await db.query(
    `UPDATE frontier_discovery_proposals SET trial_status = 'TRIED' WHERE proposal_id = $1`,
    [proposalId]
  );

  const row = res.rows[0];
  return {
    trialId: row.trial_id,
    trialKey: row.trial_key,
    proposalId: row.proposal_id,
    country: row.country,
    neighborhoodKey: row.neighborhood_key,
    quotaReserved: row.quota_reserved,
    quotaConsumed: row.quota_consumed,
    trialStatus: row.trial_status,
    initiatedAt: row.initiated_at
  };
}

/**
 * Completes a canary trial, recording metrics, outcome classification, and updating evidence.
 */
export async function completeCanaryTrial(
  trialId: string,
  queryRunId: string,
  metrics: FrontierTrialMetrics
): Promise<FrontierCanaryTrial> {
  const outcomeState = classifyTrialOutcomeState(metrics);
  const db = await getDb();

  const res = await db.query(
    `UPDATE frontier_canary_trials
     SET query_run_id = $2,
         trial_status = 'COMPLETED',
         outcome_state = $3,
         creators_returned = $4,
         distinct_creators = $5,
         new_creators = $6,
         relevant_new_creators = $7,
         quality_new_creators = $8,
         known_channel_overlap = $9,
         neighborhood_overlap = $10,
         quota_consumed = $11,
         marginal_discovery_value = $12,
         coverage_gain = $13,
         metrics = $14,
         completed_at = now()
     WHERE trial_id = $1
     RETURNING *`,
    [
      trialId,
      queryRunId,
      outcomeState,
      metrics.creatorsReturned,
      metrics.distinctCreators,
      metrics.newCreators,
      metrics.relevantNewCreators,
      metrics.qualityNewCreators,
      metrics.knownChannelOverlap,
      metrics.neighborhoodOverlap,
      metrics.quotaConsumed,
      metrics.marginalDiscoveryValue,
      metrics.coverageGain,
      JSON.stringify(metrics)
    ]
  );

  if (!res.rows.length) {
    throw new Error(`Canary trial ${trialId} not found.`);
  }

  const row = res.rows[0];
  return {
    trialId: row.trial_id,
    trialKey: row.trial_key,
    proposalId: row.proposal_id,
    queryRunId: row.query_run_id,
    country: row.country,
    neighborhoodKey: row.neighborhood_key,
    quotaReserved: row.quota_reserved,
    quotaConsumed: row.quota_consumed,
    trialStatus: row.trial_status,
    outcomeState: row.outcome_state,
    metrics: typeof row.metrics === 'string' ? JSON.parse(row.metrics) : row.metrics,
    initiatedAt: row.initiated_at,
    completedAt: row.completed_at
  };
}

/**
 * Compares legacy autonomous discovery vs frontier canary discovery metrics.
 */
export async function getFrontierBaselineComparison(
  windowHours = 24
): Promise<{
  legacy: Record<string, unknown>;
  frontierCanary: Record<string, unknown>;
}> {
  const db = await getDb();

  // Legacy Autonomous Search Runs
  const legacyRes = await db.query(
    `SELECT
       COUNT(*)::int AS total_runs,
       COALESCE(SUM(quota_used), 0)::int AS total_quota,
       COALESCE(SUM(new_channels), 0)::int AS total_new,
       COALESCE(SUM(trading_confirmed), 0)::int AS total_relevant,
       COALESCE(SUM(quality_channels), 0)::int AS total_quality,
       COUNT(DISTINCT country)::int AS distinct_countries
     FROM query_runs
     WHERE completed_at >= now() - ($1 || ' hours')::interval
       AND (metadata->>'isFrontierTrial')::boolean IS NOT TRUE`,
    [windowHours]
  );

  // Frontier Canary Trials
  const canaryRes = await db.query(
    `SELECT
       COUNT(*)::int AS total_trials,
       COALESCE(SUM(quota_consumed), 0)::int AS total_quota,
       COALESCE(SUM(new_creators), 0)::int AS total_new,
       COALESCE(SUM(relevant_new_creators), 0)::int AS total_relevant,
       COALESCE(SUM(quality_new_creators), 0)::int AS total_quality,
       COUNT(DISTINCT country)::int AS distinct_countries,
       COALESCE(AVG(known_channel_overlap), 0)::float AS avg_overlap
     FROM frontier_canary_trials
     WHERE initiated_at >= now() - ($1 || ' hours')::interval
       AND trial_status = 'COMPLETED'`,
    [windowHours]
  );

  const lRow = legacyRes.rows[0];
  const cRow = canaryRes.rows[0];

  const lQuota = Math.max(1, lRow?.total_quota || 0);
  const cQuota = Math.max(1, cRow?.total_quota || 0);

  return {
    legacy: {
      totalRuns: lRow?.total_runs || 0,
      totalQuotaConsumed: lQuota,
      totalNewCreators: lRow?.total_new || 0,
      totalRelevantNewCreators: lRow?.total_relevant || 0,
      totalQualityNewCreators: lRow?.total_quality || 0,
      relevantYieldPer1000Quota: Math.round(((lRow?.total_relevant || 0) / lQuota) * 1000 * 100) / 100,
      qualityYieldPer1000Quota: Math.round(((lRow?.total_quality || 0) / lQuota) * 1000 * 100) / 100,
      distinctCountries: lRow?.distinct_countries || 0
    },
    frontierCanary: {
      totalTrials: cRow?.total_trials || 0,
      totalQuotaConsumed: cQuota,
      totalNewCreators: cRow?.total_new || 0,
      totalRelevantNewCreators: cRow?.total_relevant || 0,
      totalQualityNewCreators: cRow?.total_quality || 0,
      relevantYieldPer1000Quota: Math.round(((cRow?.total_relevant || 0) / cQuota) * 1000 * 100) / 100,
      qualityYieldPer1000Quota: Math.round(((cRow?.total_quality || 0) / cQuota) * 1000 * 100) / 100,
      distinctCountries: cRow?.distinct_countries || 0,
      averageOverlap: Math.round((cRow?.avg_overlap || 0) * 100) / 100
    }
  };
}

/**
 * Returns comprehensive diagnostic answers for all frontier intelligence operational questions.
 */
export async function getFrontierDiagnostics(): Promise<Record<string, unknown>> {
  const db = await getDb();

  const [
    proposalsByFamily,
    proposalsByCountry,
    trialStatusCounts,
    quotaConsumed,
    sourceValuableCreators,
    neighborhoodStates,
    stateTransitions
  ] = await Promise.all([
    db.query(`SELECT proposal_family, COUNT(*)::int AS count FROM frontier_discovery_proposals GROUP BY proposal_family`),
    db.query(`SELECT country, COUNT(*)::int AS count FROM frontier_discovery_proposals GROUP BY country`),
    db.query(`SELECT trial_status, COUNT(*)::int AS count FROM frontier_discovery_proposals GROUP BY trial_status`),
    db.query(`SELECT COALESCE(SUM(quota_consumed), 0)::int AS total_canary_quota FROM frontier_canary_trials`),
    db.query(`SELECT p.proposal_family, COALESCE(SUM(t.quality_new_creators), 0)::int AS valuable_creators, COALESCE(SUM(t.relevant_new_creators), 0)::int AS relevant_creators FROM frontier_canary_trials t JOIN frontier_discovery_proposals p ON p.proposal_id = t.proposal_id GROUP BY p.proposal_family`),
    db.query(`SELECT state, COUNT(*)::int AS count FROM discovery_neighborhood_frontier_states GROUP BY state`),
    db.query(`SELECT neighborhood_key, from_state, to_state, transition_reason, transitioned_at FROM discovery_neighborhood_state_history ORDER BY transitioned_at DESC LIMIT 20`)
  ]);

  return {
    hypothesisCountsByFamily: Object.fromEntries(proposalsByFamily.rows.map(r => [r.proposal_family, r.count])),
    proposalsByCountry: Object.fromEntries(proposalsByCountry.rows.map(r => [r.country, r.count])),
    proposalStatus: Object.fromEntries(trialStatusCounts.rows.map(r => [r.trial_status, r.count])),
    canaryQuotaConsumed: quotaConsumed.rows[0]?.total_canary_quota || 0,
    sourceValuableCreators: Object.fromEntries(sourceValuableCreators.rows.map(r => [r.proposal_family, { valuable: r.valuable_creators, relevant: r.relevant_creators }])),
    neighborhoodStates: Object.fromEntries(neighborhoodStates.rows.map(r => [r.state, r.count])),
    recentStateTransitions: stateTransitions.rows
  };
}
