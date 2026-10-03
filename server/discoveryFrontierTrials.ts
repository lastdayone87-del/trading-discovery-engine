import { getDb } from './db';
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
 * Checks kill switch, proposal status, neighborhood safety, active trial status,
 * and reservation-safe daily canary capacity (summing GREATEST(quota_reserved, quota_consumed)).
 */
export async function evaluateTrialGate(
  proposalId: string,
  requestedQuota = 100,
  client?: any
): Promise<TrialGateResult> {
  const db = client || await getDb();

  // 1. Explicit Kill Switch Check (Fail Closed)
  let killSwitch = 'false';
  try {
    const settingRes = await db.query(
      `SELECT setting_value FROM app_settings WHERE setting_key = 'frontier_trials_enabled'`
    );
    // Missing configuration is not authorization. Canary trials must be explicitly enabled.
    killSwitch = settingRes.rows[0]?.setting_value ?? 'false';
  } catch (error) {
    return {
      eligible: false,
      reason: `Failed to verify operator kill switch setting: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  if (killSwitch !== 'true') {
    return { eligible: false, reason: 'Frontier trials are globally disabled or kill switch check unverified.' };
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

  // 3. Neighborhood Eligibility Check (Fail Closed)
  if (row.target_neighborhood_key) {
    try {
      const stateRes = await db.query(
        `SELECT state FROM discovery_neighborhood_frontier_states WHERE neighborhood_key = $1`,
        [row.target_neighborhood_key]
      );
      if (stateRes.rows.length > 0 && stateRes.rows[0].state === 'HARMFUL') {
        return { eligible: false, reason: 'Target neighborhood is classified as HARMFUL.' };
      }
    } catch (error) {
      return {
        eligible: false,
        reason: `Failed to verify target neighborhood frontier state: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  // 4. Cooldown & Active Trial Check
  const trialRes = await db.query(
    `SELECT trial_id, trial_key, initiated_at
     FROM frontier_canary_trials
     WHERE proposal_id = $1 AND trial_status IN ('INITIATED', 'COMPLETED')
     LIMIT 1`,
    [proposalId]
  );

  if (trialRes.rows.length > 0) {
    return { eligible: false, reason: 'Trial already exists or active for this proposal.' };
  }

  // 5. Reservation-Safe Daily Canary Quota Safety Cap Check (Max 500 units/day)
  // Sum GREATEST(quota_reserved, quota_consumed) across the last 24h window
  const capacityRes = await db.query(
    `SELECT COALESCE(SUM(GREATEST(quota_reserved, quota_consumed)), 0)::int AS daily_reserved_capacity
     FROM frontier_canary_trials
     WHERE initiated_at >= now() - interval '24 hours'
       AND trial_status IN ('INITIATED', 'COMPLETED')`
  );

  const dailyReservedCapacity = capacityRes.rows[0]?.daily_reserved_capacity || 0;
  if (dailyReservedCapacity + requestedQuota > 500) {
    return {
      eligible: false,
      reason: `Daily canary trial quota cap (500 units) would be exceeded (${dailyReservedCapacity} reserved + ${requestedQuota} requested = ${dailyReservedCapacity + requestedQuota}).`
    };
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
 * Initiates a canary trial atomically and restart-safely under a deterministic trial identity.
 */
export async function initiateCanaryTrial(
  proposalId: string,
  options: { maxQuota?: number; pageDepth?: number; trialKey?: string } = {},
  /**
   * Optional caller-owned database client. When supplied, initiation joins
   * the caller's transaction (no BEGIN/COMMIT/ROLLBACK/release here), so a
   * caller rollback atomically rolls the trial reservation back with it —
   * an initiated trial cannot orphan on scheduling rollback. When absent,
   * the previous standalone-transaction behavior is unchanged.
   */
  externalClient?: { query: (text: string, values?: any[]) => Promise<{ rows: any[]; rowCount: number | null }> }
): Promise<FrontierCanaryTrial> {
  const owned = !externalClient;
  let client: { query: (text: string, values?: any[]) => Promise<{ rows: any[]; rowCount: number | null }>; release?: () => void };
  if (owned) {
    const db = await getDb();
    client = await db.connect();
  } else {
    client = externalClient!;
  }

  // Savepoint lifecycle for caller-owned transactions. The savepoint is
  // established once; abort rolls back to it (never a bare ROLLBACK, which
  // would destroy the caller's transaction); release happens at most once,
  // on the success path only. The `trialScopeOpen` flag makes repeated
  // abort calls safe: rejection branches abort and then rethrow through the
  // shared catch, which must NOT touch a savepoint that no longer exists —
  // a second ROLLBACK TO would error and poison the caller's entire
  // transaction, failing scheduling that should proceed without a trial.
  let trialScopeOpen = false;
  const commit = async (): Promise<void> => {
    if (owned) {
      await client.query('COMMIT');
      return;
    }
    if (!trialScopeOpen) return;
    trialScopeOpen = false;
    await client.query('RELEASE SAVEPOINT frontier_trial_init');
  };
  const rollback = async (): Promise<void> => {
    if (owned) {
      await client.query('ROLLBACK');
      return;
    }
    if (!trialScopeOpen) return;
    trialScopeOpen = false;
    await client.query('ROLLBACK TO SAVEPOINT frontier_trial_init');
  };

  try {
    if (owned) {
      await client.query('BEGIN');
    } else {
      await client.query('SAVEPOINT frontier_trial_init');
      trialScopeOpen = true;
    }

    // Acquire transaction-scoped advisory lock to serialize daily canary capacity checks across all concurrent workers & proposals.
    // This is a hard safety boundary: failure to acquire/verify the lock aborts the transaction.
    await client.query('SELECT pg_advisory_xact_lock(741963285)');

    // Fetch proposal details inside transaction with FOR UPDATE
    const propRes = await client.query(
      `SELECT proposal_id, dedup_key, country, target_neighborhood_key
       FROM frontier_discovery_proposals
       WHERE proposal_id = $1 FOR UPDATE`,
      [proposalId]
    );

    if (!propRes.rows.length) {
      await rollback();
      throw new Error('Proposal ID not found.');
    }

    const prop = propRes.rows[0];
    const trialKey = options.trialKey || `trial:${prop.dedup_key || prop.proposal_id}`;

    // Check for existing trial with this trial_key or proposal_id idempotently
    const existingRes = await client.query(
      `SELECT trial_id, trial_key, proposal_id, country, neighborhood_key,
              quota_reserved, quota_consumed, trial_status, initiated_at
       FROM frontier_canary_trials
       WHERE trial_key = $1 OR (proposal_id = $2 AND trial_status IN ('INITIATED', 'COMPLETED'))
       FOR UPDATE`,
      [trialKey, proposalId]
    );

    if (existingRes.rows.length > 0) {
      await commit();
      const row = existingRes.rows[0];
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

    const rawQuota = options.maxQuota ?? 100;
    if (
      typeof rawQuota !== 'number' ||
      !Number.isFinite(rawQuota) ||
      !Number.isInteger(rawQuota) ||
      rawQuota < 1 ||
      rawQuota > 100
    ) {
      await rollback();
      throw new Error(
        `Invalid canary quota reservation: ${rawQuota}. Quota reservation must be an integer between 1 and 100.`
      );
    }
    const quotaReserved = rawQuota;

    // Evaluate gate inside transaction for concurrency safety
    const gate = await evaluateTrialGate(proposalId, quotaReserved, client);
    if (!gate.eligible || !gate.proposal) {
      await rollback();
      throw new Error(`Trial gate rejected proposal: ${gate.reason}`);
    }

    const res = await client.query(
      `INSERT INTO frontier_canary_trials(
         trial_key, proposal_id, country, neighborhood_key, quota_reserved,
         trial_status, retrieval_config
       )
       VALUES($1, $2, $3, $4, $5, 'INITIATED', $6)
       ON CONFLICT(trial_key) DO UPDATE SET trial_status = frontier_canary_trials.trial_status
       RETURNING trial_id, trial_key, proposal_id, country, neighborhood_key,
                 quota_reserved, quota_consumed, trial_status, initiated_at`,
      [
        trialKey,
        proposalId,
        gate.proposal.country,
        gate.proposal.targetNeighborhoodKey,
        quotaReserved,
        JSON.stringify({
          maxQuota: quotaReserved,
          pageDepthCap: Math.min(1, options.pageDepth ?? 1),
          proposalFamily: gate.proposal.proposalFamily,
          concept: gate.proposal.concept
        })
      ]
    );

    // Mark proposal status as TRIED
    await client.query(
      `UPDATE frontier_discovery_proposals SET trial_status = 'TRIED' WHERE proposal_id = $1`,
      [proposalId]
    );

    await commit();

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
  } catch (error) {
    await rollback();
    throw error;
  } finally {
    if (owned) client.release();
  }
}

/**
 * Completes a canary trial, enforcing the trial's reserved quota cap on metrics.quotaConsumed.
 */
export async function completeCanaryTrial(
  trialId: string,
  queryRunId: string,
  rawMetrics: FrontierTrialMetrics
): Promise<FrontierCanaryTrial> {
  const db = await getDb();

  // Retrieve trial's reserved quota
  const trialCheck = await db.query(
    `SELECT quota_reserved FROM frontier_canary_trials WHERE trial_id = $1`,
    [trialId]
  );

  if (!trialCheck.rows.length) {
    throw new Error(`Canary trial ${trialId} not found.`);
  }

  const quotaReserved = trialCheck.rows[0].quota_reserved;
  // Enforce per-trial reserved quota cap: quotaConsumed cannot exceed quotaReserved
  const enforcedQuotaConsumed = Math.min(quotaReserved, Math.max(0, rawMetrics.quotaConsumed));
  const metrics: FrontierTrialMetrics = {
    ...rawMetrics,
    quotaConsumed: enforcedQuotaConsumed
  };

  const outcomeState = classifyTrialOutcomeState(metrics);

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
      enforcedQuotaConsumed,
      metrics.marginalDiscoveryValue,
      metrics.coverageGain,
      JSON.stringify(metrics)
    ]
  );

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
 * Completion-funnel to trial-metrics mapping (trial-funnel-map-v1).
 * Measured funnel fields map one-to-one; known_channel_overlap is a
 * documented proxy (known share among resolved creators) because per-trial
 * overlap is not measured at completion; neighborhoodOverlap,
 * marginalDiscoveryValue, and coverageGain have no completion-time source
 * and are recorded as 0 (documented unmeasured). Zeros cannot falsely
 * trigger SATURATED (>=0.80) or coverage-PROMISING (>=0.20); HARMFUL stays
 * meaningful on measured quota/relevant/overlap-proxy.
 */
export const TRIAL_FUNNEL_MAP_VERSION = 'trial-funnel-map-v1';

export function mapCompletionFunnelToTrialMetrics(funnel: {
  rawResults: number;
  distinctResults: number;
  knownChannels: number;
  newChannels: number;
  tradingConfirmed: number;
  qualityChannels: number;
  quotaUsed: number;
}): FrontierTrialMetrics {
  const nonNegative = (value: number): number => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
  const known = nonNegative(funnel.knownChannels);
  const fresh = nonNegative(funnel.newChannels);
  return {
    creatorsReturned: nonNegative(funnel.rawResults),
    distinctCreators: nonNegative(funnel.distinctResults),
    newCreators: fresh,
    relevantNewCreators: nonNegative(funnel.tradingConfirmed),
    qualityNewCreators: nonNegative(funnel.qualityChannels),
    knownChannelOverlap: known + fresh > 0 ? known / (known + fresh) : 0,
    neighborhoodOverlap: 0,
    quotaConsumed: nonNegative(funnel.quotaUsed),
    marginalDiscoveryValue: 0,
    coverageGain: 0,
  };
}

/**
 * Completes the INITIATED trial linked to a finished query run. Thin wrapper
 * over completeCanaryTrial (unchanged): maps the run's measured completion
 * funnel to trial metrics. Trial failures propagate to the caller — callers
 * serving production runs must catch (best-effort, never fail the run).
 */
export async function completeFrontierTrialForRun(
  trialId: string,
  queryRunId: string,
  funnel: {
    rawResults: number;
    distinctResults: number;
    knownChannels: number;
    newChannels: number;
    tradingConfirmed: number;
    qualityChannels: number;
    quotaUsed: number;
  }
): Promise<FrontierCanaryTrial> {
  return completeCanaryTrial(trialId, queryRunId, mapCompletionFunnelToTrialMetrics(funnel));
}

/**
 * Resolves whether a trial request may link to a scheduled run. Pure.
 * Proposal consumption flows exclusively through frontier decisions, so a
 * request is linkable only when the run carries the frontier decision whose
 * proposal matches the requested proposal. Anything else fails closed with
 * an explicit reason instead of attaching to an unrelated run.
 */
export function resolveTrialLinkage(args: {
  requestedProposalId: string;
  decisionProposalId: string | null;
}): { proceed: true; proposalId: string } | { proceed: false; reason: 'TRIAL_REQUIRES_FRONTIER_DECISION' | 'TRIAL_PROPOSAL_DECISION_MISMATCH' } {
  if (!args.decisionProposalId) {
    return { proceed: false, reason: 'TRIAL_REQUIRES_FRONTIER_DECISION' };
  }
  if (args.decisionProposalId !== args.requestedProposalId) {
    return { proceed: false, reason: 'TRIAL_PROPOSAL_DECISION_MISMATCH' };
  }
  return { proceed: true, proposalId: args.requestedProposalId };
}

/**
 * Whether a trial reservation covers at least the first page's execution
 * cost. Pure. A reservation below first-page cost can never stay within
 * budget, so such requests are refused before reserving anything.
 */
export function isTrialQuotaSufficient(maxQuota: number, firstPageCostUnits: number): boolean {
  if (!Number.isFinite(maxQuota) || !Number.isFinite(firstPageCostUnits)) return false;
  if (firstPageCostUnits < 0) return false;
  return maxQuota >= firstPageCostUnits;
}

/**
 * Bounds continuation pages by the trial reservation (100 units per
 * official page — the existing quota methodology, unchanged). Free
 * (zero-cost) execution needs no bound; callers skip the cap then.
 * Pure. A zero bound stops continuation after the already-executed first
 * page; it never deadlocks the run.
 */
export function trialContinuationCap(normalMaxPages: number, quotaReservedUnits: number): number {
  if (!Number.isFinite(normalMaxPages) || !Number.isFinite(quotaReservedUnits)) {
    return Math.max(0, Math.floor(normalMaxPages) || 0);
  }
  return Math.max(0, Math.min(Math.floor(normalMaxPages), Math.floor(quotaReservedUnits / 100)));
}

/**
 * Yield per 1,000 quota units with honest zero handling. Returns the actual
 * recorded consumption alongside the yield: a genuinely zero-quota arm
 * reports zero consumption (the denominator alone is floored at 1 to avoid
 * divide-by-zero, never the reported total). Pure.
 */
export function quotaYieldPer1000(value: number, quotaUnits: number): { totalQuotaConsumed: number; yieldPer1000Quota: number } {
  const consumed = Number.isFinite(quotaUnits) && quotaUnits > 0 ? Math.floor(quotaUnits) : 0;
  return {
    totalQuotaConsumed: consumed,
    yieldPer1000Quota: Math.round((value / Math.max(1, consumed)) * 1000 * 100) / 100,
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
  selectionArms: Array<Record<string, unknown>>;
}> {
  const db = await getDb();

  // Legacy Autonomous Search Runs. A run is legacy only when it is neither
  // a serving-path FRONTIER_CANARY allocation nor flagged by the legacy
  // isFrontierTrial marker (kept for backward compatibility). Previously the
  // serving-path allocation_origin was ignored here, so canary runs were
  // silently counted as legacy.
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
       AND NOT (allocation_origin = 'FRONTIER_CANARY' OR (metadata->>'isFrontierTrial')::boolean IS TRUE)`,
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

  const legacyRelevantYield = quotaYieldPer1000(Number(lRow?.total_relevant || 0), Number(lRow?.total_quota || 0));
  const legacyQualityYield = quotaYieldPer1000(Number(lRow?.total_quality || 0), Number(lRow?.total_quota || 0));
  const canaryRelevantYield = quotaYieldPer1000(Number(cRow?.total_relevant || 0), Number(cRow?.total_quota || 0));
  const canaryQualityYield = quotaYieldPer1000(Number(cRow?.total_quality || 0), Number(cRow?.total_quota || 0));

  // Selection-arm breakdown over the same window. Arms resolve from the
  // persisted selectionExperiment envelope (see resolvePersistedSelectionArm);
  // runs without an envelope are CONTROL. Allocation origin (LEGACY vs
  // FRONTIER_CANARY) stays a separate dimension in `legacy`/`frontierCanary`
  // above and is intentionally not conflated here.
  const armRes = await db.query(
    `SELECT
       COALESCE(NULLIF(metadata->'selectionExperiment'->>'servedArm', ''), 'CONTROL') AS arm,
       COUNT(*)::int AS runs,
       COALESCE(SUM(quota_used), 0)::int AS quota,
       COALESCE(SUM(new_channels), 0)::int AS newc,
       COALESCE(SUM(trading_confirmed), 0)::int AS relevant,
       COALESCE(SUM(quality_channels), 0)::int AS quality,
       COUNT(DISTINCT country)::int AS countries
     FROM query_runs
     WHERE completed_at >= now() - ($1 || ' hours')::interval
     GROUP BY 1 ORDER BY 1`,
    [windowHours]
  );

  return {
    legacy: {
      totalRuns: lRow?.total_runs || 0,
      totalQuotaConsumed: legacyRelevantYield.totalQuotaConsumed,
      totalNewCreators: lRow?.total_new || 0,
      totalRelevantNewCreators: lRow?.total_relevant || 0,
      totalQualityNewCreators: lRow?.total_quality || 0,
      relevantYieldPer1000Quota: legacyRelevantYield.yieldPer1000Quota,
      qualityYieldPer1000Quota: legacyQualityYield.yieldPer1000Quota,
      distinctCountries: lRow?.distinct_countries || 0
    },
    frontierCanary: {
      totalTrials: cRow?.total_trials || 0,
      totalQuotaConsumed: canaryRelevantYield.totalQuotaConsumed,
      totalNewCreators: cRow?.total_new || 0,
      totalRelevantNewCreators: cRow?.total_relevant || 0,
      totalQualityNewCreators: cRow?.total_quality || 0,
      relevantYieldPer1000Quota: canaryRelevantYield.yieldPer1000Quota,
      qualityYieldPer1000Quota: canaryQualityYield.yieldPer1000Quota,
      distinctCountries: cRow?.distinct_countries || 0,
      averageOverlap: Math.round((cRow?.avg_overlap || 0) * 100) / 100
    },
    selectionArms: armRes.rows.map(row => {
      const relevantYield = quotaYieldPer1000(Number(row.relevant || 0), Number(row.quota || 0));
      const qualityYield = quotaYieldPer1000(Number(row.quality || 0), Number(row.quota || 0));
      return {
        arm: String(row.arm || 'CONTROL'),
        runs: Number(row.runs || 0),
        totalQuotaConsumed: relevantYield.totalQuotaConsumed,
        totalNewCreators: Number(row.newc || 0),
        totalRelevantNewCreators: Number(row.relevant || 0),
        totalQualityNewCreators: Number(row.quality || 0),
        relevantYieldPer1000Quota: relevantYield.yieldPer1000Quota,
        qualityYieldPer1000Quota: qualityYield.yieldPer1000Quota,
        distinctCountries: Number(row.countries || 0),
      };
    })
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