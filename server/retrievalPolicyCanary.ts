import { createHash } from 'node:crypto';
import { getDb } from './db';
import { getYouTubeQuotaDay, getYouTubeQuotaDayStartAt } from './youtubeQuotaDay';
import type { RetrievalLane } from './retrievalLanes';
import type { SearchOrdering } from './searchOrdering';
import {
  type RetrievalConfiguration,
  buildRetrievalConfiguration,
  ensureRetrievalConfigurationPersisted,
  CURRENT_RETRIEVAL_POLICY_VERSION
} from './retrievalConfiguration';
import {
  getNeighborhoodRetrievalEvidence,
  recomputeNeighborhoodRetrievalEvidence
} from './retrievalPolicyEvidence';

export interface RetrievalEligibilityResult {
  eligible: boolean;
  maxPageDepthCeiling: number;
  allowedOrderings: SearchOrdering[];
  rejectionReasons: string[];
}

export interface CanaryTreatmentReservation {
  id?: string;
  reservationId: string;
  opportunityKey: string;
  neighborhoodKey: string;
  queryRunId?: string | null;
  reservationStatus: 'RESERVED' | 'COMMITTED' | 'RELEASED' | 'DEFERRED';
  quotaReserved: number;
  quotaConsumed: number;
  quotaDay: string;
  policyVersion: string;
  config: RetrievalConfiguration;
  createdAt?: string;
}

/**
 * Derives a deterministic pseudo-random float in [0, 1) from seed inputs.
 * Ensures reproducible, audit-safe treatment selection across restarts and retries.
 */
export function deterministicExplorationValue(seed: string): number {
  const hashHex = createHash('sha256').update(seed).digest('hex').slice(0, 8);
  const intVal = parseInt(hashHex, 16);
  return intVal / 0xFFFFFFFF;
}

/**
 * Evaluates retrieval-strategy eligibility per neighborhood state and evidence.
 * Phase 9 cannot override Phase 8 neighborhood eligibility or global safety limits.
 */
export function evaluateRetrievalPolicyEligibility(input: {
  neighborhoodKey: string;
  frontierState?: string;
  isSaturating?: boolean;
  recentDuplicateRatio?: number;
}): RetrievalEligibilityResult {
  const reasons: string[] = [];
  const frontierState = (input.frontierState || 'UNEXPLORED').toUpperCase();

  if (frontierState === 'HARMFUL') {
    reasons.push('HARMFUL_NEIGHBORHOOD_SHALLOW_RELEVANCE_ONLY');
    return {
      eligible: false,
      maxPageDepthCeiling: 1,
      allowedOrderings: ['RELEVANCE'],
      rejectionReasons: reasons
    };
  }

  if (frontierState === 'SATURATED' || input.isSaturating) {
    reasons.push('SATURATED_NEIGHBORHOOD_SHALLOW_ONLY');
    return {
      eligible: false,
      maxPageDepthCeiling: 1,
      allowedOrderings: ['RELEVANCE'],
      rejectionReasons: reasons
    };
  }

  if (input.recentDuplicateRatio && input.recentDuplicateRatio >= 0.70) {
    reasons.push('HIGH_DUPLICATE_RATIO_DEPTH_LIMITED');
    return {
      eligible: true,
      maxPageDepthCeiling: 1,
      allowedOrderings: ['RELEVANCE', 'DATE'],
      rejectionReasons: reasons
    };
  }

  return {
    eligible: true,
    maxPageDepthCeiling: 3,
    allowedOrderings: ['RELEVANCE', 'DATE'],
    rejectionReasons: []
  };
}

/**
 * Evaluates and reserves Phase 9 canary treatment authority under a transaction advisory lock.
 * Concurrency-safe: tracks reserved + committed treatment capacity in the active Pacific quota day.
 */
export async function reserveRetrievalCanaryTreatment(input: {
  opportunityKey: string;
  neighborhoodKey: string;
  retrievalLane: RetrievalLane;
  defaultOrdering: SearchOrdering;
  frontierState?: string;
  isSaturating?: boolean;
  now?: Date;
  clientOverride?: any;
}): Promise<{
  authorized: boolean;
  reservation?: CanaryTreatmentReservation;
  config?: RetrievalConfiguration;
  reason: string;
}> {
  const now = input.now || new Date();
  const quotaDay = getYouTubeQuotaDay(now);

  const runner = input.clientOverride || (process.env.DATABASE_URL ? await getDb() : null);
  if (!runner) {
    return { authorized: false, reason: 'DATABASE_UNAVAILABLE' };
  }

  // Check Feature Switch (Fail Closed)
  try {
    const settingRes = await runner.query(
      `SELECT setting_value FROM app_settings WHERE setting_key = 'retrieval_strategy_learning_enabled'`
    );
    const enabled = settingRes.rows[0]?.setting_value === 'true';
    if (!enabled) {
      return { authorized: false, reason: 'RETRIEVAL_STRATEGY_LEARNING_DISABLED' };
    }
  } catch (err) {
    return { authorized: false, reason: `FAILED_TO_VERIFY_SETTING: ${err instanceof Error ? err.message : String(err)}` };
  }

  const client = input.clientOverride ? null : await (await getDb()).connect();
  const activeRunner = input.clientOverride || client;

  try {
    if (client) await activeRunner.query('BEGIN');

    // Concurrency advisory lock for Phase 9 canary authority
    await activeRunner.query('SELECT pg_advisory_xact_lock(741963287)');

    // Read Configurable Caps
    const [assignCapRes, quotaCapRes] = await Promise.all([
      activeRunner.query(`SELECT setting_value FROM app_settings WHERE setting_key = 'retrieval_canary_daily_assignment_cap'`),
      activeRunner.query(`SELECT setting_value FROM app_settings WHERE setting_key = 'retrieval_canary_daily_quota_cap'`)
    ]);

    const assignmentCap = Number(assignCapRes.rows[0]?.setting_value ?? 10);
    const quotaCap = Number(quotaCapRes.rows[0]?.setting_value ?? 1000);

    const usageRes = await activeRunner.query(
      `SELECT
         COUNT(*)::int AS daily_assignments,
         COALESCE(SUM(GREATEST(quota_reserved, quota_consumed)), 0)::int AS daily_quota_used
       FROM retrieval_canary_reservations
       WHERE quota_day = $1
         AND reservation_status IN ('RESERVED', 'COMMITTED')`,
      [quotaDay]
    );

    const dailyAssignments = Number(usageRes.rows[0]?.daily_assignments || 0);
    const dailyQuotaUsed = Number(usageRes.rows[0]?.daily_quota_used || 0);

    if (dailyAssignments >= assignmentCap || dailyQuotaUsed + 100 > quotaCap) {
      if (client) await activeRunner.query('COMMIT');
      return {
        authorized: false,
        reason: `RETRIEVAL_CANARY_DAILY_CAP_EXCEEDED (assignments: ${dailyAssignments}/${assignmentCap}, quota: ${dailyQuotaUsed + 100}/${quotaCap})`
      };
    }

    // Select learned configuration deterministically
    const learned = await selectLearnedRetrievalConfiguration({
      opportunityKey: input.opportunityKey,
      neighborhoodKey: input.neighborhoodKey,
      retrievalLane: input.retrievalLane,
      defaultOrdering: input.defaultOrdering,
      frontierState: input.frontierState,
      isSaturating: input.isSaturating,
      clientOverride: activeRunner
    });

    if (!learned.eligibility.eligible) {
      if (client) await activeRunner.query('COMMIT');
      return {
        authorized: false,
        reason: `INELIGIBLE_NEIGHBORHOOD: ${learned.eligibility.rejectionReasons.join(', ')}`
      };
    }

    await ensureRetrievalConfigurationPersisted(learned.config, activeRunner);

    const reservationId = `retrieval-res:${input.opportunityKey}:${learned.config.configKey}:${CURRENT_RETRIEVAL_POLICY_VERSION}`;

    const reservation: CanaryTreatmentReservation = {
      reservationId,
      opportunityKey: input.opportunityKey,
      neighborhoodKey: input.neighborhoodKey,
      reservationStatus: 'RESERVED',
      quotaReserved: 100,
      quotaConsumed: 0,
      quotaDay,
      policyVersion: CURRENT_RETRIEVAL_POLICY_VERSION,
      config: learned.config,
      createdAt: now.toISOString()
    };

    await activeRunner.query(
      `INSERT INTO retrieval_canary_reservations(
         reservation_id, opportunity_key, neighborhood_key, reservation_status,
         quota_reserved, quota_consumed, quota_day, policy_version, retrieval_config_key, created_at
       )
       VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT(reservation_id) DO UPDATE SET
         reservation_status = EXCLUDED.reservation_status`,
      [
        reservation.reservationId,
        reservation.opportunityKey,
        reservation.neighborhoodKey,
        reservation.reservationStatus,
        reservation.quotaReserved,
        reservation.quotaConsumed,
        reservation.quotaDay,
        reservation.policyVersion,
        reservation.config.configKey,
        reservation.createdAt
      ]
    );

    if (client) await activeRunner.query('COMMIT');

    return {
      authorized: true,
      reservation,
      config: learned.config,
      reason: learned.reason
    };
  } catch (err) {
    if (client) await activeRunner.query('ROLLBACK').catch(() => undefined);
    return {
      authorized: false,
      reason: `RETRIEVAL_CANARY_RESERVATION_ERROR: ${err instanceof Error ? err.message : String(err)}`
    };
  } finally {
    if (client) client.release();
  }
}

/**
 * Commits a reserved retrieval canary treatment reservation when query run is scheduled.
 */
export async function commitRetrievalCanaryReservation(
  reservationId: string,
  queryRunId: string,
  clientOverride?: any
): Promise<boolean> {
  const runner = clientOverride || (process.env.DATABASE_URL ? await getDb() : null);
  if (!runner) return false;

  const res = await runner.query(
    `UPDATE retrieval_canary_reservations
     SET reservation_status = 'COMMITTED',
         query_run_id = $2
     WHERE reservation_id = $1
       AND reservation_status = 'RESERVED'`,
    [reservationId, queryRunId]
  ).catch((err: unknown) => {
    console.warn('[RetrievalPolicyCanary] Failed to commit canary reservation:', err);
    return { rowCount: 0 };
  });

  return (res?.rowCount ?? 0) > 0;
}

/**
 * Releases a reserved canary treatment reservation if scheduling fails.
 */
export async function releaseRetrievalCanaryReservation(
  reservationId: string,
  reason: string,
  clientOverride?: any
): Promise<boolean> {
  const runner = clientOverride || (process.env.DATABASE_URL ? await getDb() : null);
  if (!runner) return false;

  const res = await runner.query(
    `UPDATE retrieval_canary_reservations
     SET reservation_status = 'RELEASED',
         quota_reserved = 0
     WHERE reservation_id = $1
       AND reservation_status = 'RESERVED'`,
    [reservationId]
  ).catch((err: unknown) => {
    console.warn('[RetrievalPolicyCanary] Failed to release canary reservation:', err);
    return { rowCount: 0 };
  });

  return (res?.rowCount ?? 0) > 0;
}

/**
 * Atomically reserves incremental treatment quota for multi-page continuation requests (page 2 / page 3).
 * Enforces treatment quota caps before the continuation job is created.
 */
export async function reserveIncrementalTreatmentPageQuota(input: {
  queryRunId: string;
  pageNumber: number;
  now?: Date;
  clientOverride?: any;
}): Promise<{
  authorized: boolean;
  reason: string;
}> {
  const now = input.now || new Date();
  const quotaDay = getYouTubeQuotaDay(now);

  const runner = input.clientOverride || (process.env.DATABASE_URL ? await getDb() : null);
  if (!runner) return { authorized: false, reason: 'DATABASE_UNAVAILABLE' };

  const client = input.clientOverride ? null : await (await getDb()).connect();
  const activeRunner = input.clientOverride || client;

  try {
    if (client) await activeRunner.query('BEGIN');

    // Concurrency advisory lock for Phase 9 canary authority
    await activeRunner.query('SELECT pg_advisory_xact_lock(741963287)');

    const [quotaCapRes, pageCapRes] = await Promise.all([
      activeRunner.query(`SELECT setting_value FROM app_settings WHERE setting_key = 'retrieval_canary_daily_quota_cap'`),
      activeRunner.query(`SELECT setting_value FROM app_settings WHERE setting_key = 'retrieval_canary_max_additional_pages'`)
    ]);

    const quotaCap = Number(quotaCapRes.rows[0]?.setting_value ?? 1000);
    const maxAdditionalPages = Number(pageCapRes.rows[0]?.setting_value ?? 5);

    const [usageRes, pageRes] = await Promise.all([
      activeRunner.query(
        `SELECT COALESCE(SUM(GREATEST(quota_reserved, quota_consumed)), 0)::int AS daily_quota_used
         FROM retrieval_canary_reservations
         WHERE quota_day = $1 AND reservation_status IN ('RESERVED', 'COMMITTED')`,
        [quotaDay]
      ),
      activeRunner.query(
        `SELECT COUNT(*)::int AS extra_pages
         FROM autonomous_query_page_observations
         WHERE retrieval_treatment_origin = 'CANARY_TREATMENT'
           AND page_number > 1
           AND created_at >= $1`,
        [getYouTubeQuotaDayStartAt(now)]
      )
    ]);

    const dailyQuotaUsed = Number(usageRes.rows[0]?.daily_quota_used || 0);
    const extraPagesUsed = Number(pageRes.rows[0]?.extra_pages || 0);

    if (dailyQuotaUsed + 100 > quotaCap || extraPagesUsed >= maxAdditionalPages) {
      if (client) await activeRunner.query('COMMIT');
      return {
        authorized: false,
        reason: `INCREMENTAL_CANARY_QUOTA_CAP_EXCEEDED (quota: ${dailyQuotaUsed + 100}/${quotaCap}, extra pages: ${extraPagesUsed}/${maxAdditionalPages})`
      };
    }

    // Top-up existing reservation for query run
    await activeRunner.query(
      `UPDATE retrieval_canary_reservations
       SET quota_reserved = quota_reserved + 100
       WHERE query_run_id = $1 AND reservation_status = 'COMMITTED'`,
      [input.queryRunId]
    );

    if (client) await activeRunner.query('COMMIT');
    return { authorized: true, reason: 'INCREMENTAL_CANARY_QUOTA_AUTHORIZED' };
  } catch (err) {
    if (client) await activeRunner.query('ROLLBACK').catch(() => undefined);
    return {
      authorized: false,
      reason: `INCREMENTAL_QUOTA_RESERVATION_ERROR: ${err instanceof Error ? err.message : String(err)}`
    };
  } finally {
    if (client) client.release();
  }
}

/**
 * Selects a learned adaptive retrieval configuration for a given neighborhood deterministically.
 */
export async function selectLearnedRetrievalConfiguration(input: {
  opportunityKey: string;
  neighborhoodKey: string;
  retrievalLane: RetrievalLane;
  defaultOrdering: SearchOrdering;
  frontierState?: string;
  isSaturating?: boolean;
  explorationRatio?: number;
  clientOverride?: any;
}): Promise<{
  config: RetrievalConfiguration;
  isExploration: boolean;
  eligibility: RetrievalEligibilityResult;
  reason: string;
}> {
  const eligibility = evaluateRetrievalPolicyEligibility({
    neighborhoodKey: input.neighborhoodKey,
    frontierState: input.frontierState,
    isSaturating: input.isSaturating
  });

  const runner = input.clientOverride || (process.env.DATABASE_URL ? await getDb() : null);

  if (!eligibility.eligible) {
    const config = buildRetrievalConfiguration({
      searchOrdering: 'RELEVANCE',
      retrievalLane: input.retrievalLane,
      requestedPageDepth: 1
    });
    if (runner) await ensureRetrievalConfigurationPersisted(config, runner);
    return {
      config,
      isExploration: false,
      eligibility,
      reason: `Ineligible for Phase 9 expansion: ${eligibility.rejectionReasons.join(', ')}`
    };
  }

  const allowedDepth = eligibility.maxPageDepthCeiling;
  const candidateConfigs: RetrievalConfiguration[] = [];

  for (const ordering of eligibility.allowedOrderings) {
    for (let depth = 1; depth <= allowedDepth; depth++) {
      candidateConfigs.push(
        buildRetrievalConfiguration({
          searchOrdering: ordering,
          retrievalLane: input.retrievalLane,
          requestedPageDepth: depth
        })
      );
    }
  }

  const expRatio = Math.min(0.5, Math.max(0.05, input.explorationRatio ?? 0.15));
  // Deterministic seed for reproducible treatment exploration
  const seed = `${input.opportunityKey}:${input.neighborhoodKey}:${CURRENT_RETRIEVAL_POLICY_VERSION}`;
  const explorationVal = deterministicExplorationValue(seed);
  const isExploration = explorationVal < expRatio;

  let chosenConfig: RetrievalConfiguration;
  let selectionReason = '';

  if (isExploration) {
    const scoredCandidates = await Promise.all(
      candidateConfigs.map(async cand => {
        const ev = await getNeighborhoodRetrievalEvidence(input.neighborhoodKey, cand.configKey, runner);
        return {
          cand,
          executionCount: ev?.executionCount || 0,
          uncertainty: ev?.uncertainty ?? 1.0
        };
      })
    );

    scoredCandidates.sort((a, b) => a.executionCount - b.executionCount || b.uncertainty - a.uncertainty);
    chosenConfig = scoredCandidates[0].cand;
    selectionReason = `Deterministic exploration floor selected under-tested configuration (executions: ${scoredCandidates[0].executionCount}, uncertainty: ${scoredCandidates[0].uncertainty}).`;
  } else {
    const scoredCandidates = await Promise.all(
      candidateConfigs.map(async cand => {
        const ev = await getNeighborhoodRetrievalEvidence(input.neighborhoodKey, cand.configKey, runner);
        const expVal = ev?.expectedMarginalValue || (cand.searchOrdering === 'DATE' ? 45 : 50);
        const quota = Math.max(100, cand.requestedPageDepth * 100);
        const valuePerQuota = (expVal / quota) * 100;
        const uncert = ev?.uncertainty ?? 1.0;
        return {
          cand,
          score: valuePerQuota + (uncert * 5)
        };
      })
    );

    scoredCandidates.sort((a, b) => b.score - a.score);
    chosenConfig = scoredCandidates[0].cand;
    selectionReason = `Deterministic exploitation selected top-performing configuration (score: ${Math.round(scoredCandidates[0].score * 10) / 10}).`;
  }

  if (runner) {
    await ensureRetrievalConfigurationPersisted(chosenConfig, runner);
  }

  return {
    config: chosenConfig,
    isExploration,
    eligibility,
    reason: selectionReason
  };
}

/**
 * Retrieves comprehensive operational diagnostics for Phase 9 retrieval strategy learning.
 */
export async function getRetrievalPolicyDiagnostics(): Promise<Record<string, unknown>> {
  if (!process.env.DATABASE_URL) return {};
  const db = await getDb();

  const [
    configCounts,
    shadowRecs,
    treatmentOriginCounts,
    orderingPerformance,
    pageYields
  ] = await Promise.all([
    db.query(`SELECT COUNT(*)::int AS total_configs FROM retrieval_configurations`),
    db.query(`SELECT COUNT(*)::int AS total_recs, COUNT(*) FILTER (WHERE differs_from_executed = true)::int AS diff_count FROM retrieval_policy_shadow_recommendations`),
    db.query(`SELECT COALESCE(retrieval_treatment_origin, 'CONTROL') AS origin, COUNT(*)::int AS count, COALESCE(SUM(quota_used), 0)::int AS total_quota FROM query_runs GROUP BY 1`),
    db.query(`SELECT search_ordering, COUNT(*)::int AS run_count, COALESCE(SUM(trading_confirmed), 0)::int AS confirmed, COALESCE(SUM(quality_channels), 0)::int AS quality, COALESCE(SUM(quota_used), 0)::int AS total_quota FROM query_runs GROUP BY search_ordering`),
    db.query(`SELECT page_number, COUNT(*)::int AS sample_size, ROUND(AVG(new_creators)::numeric, 2)::float AS avg_new, ROUND(AVG(confirmed_creators)::numeric, 2)::float AS avg_confirmed, ROUND(AVG(quality_confirmed_creators)::numeric, 2)::float AS avg_quality, ROUND(AVG(duplicate_ratio)::numeric, 3)::float AS avg_duplicate FROM autonomous_query_page_observations GROUP BY page_number ORDER BY page_number ASC`)
  ]);

  const shadowTotal = Number(shadowRecs.rows[0]?.total_recs || 0);
  const shadowDiffs = Number(shadowRecs.rows[0]?.diff_count || 0);

  return {
    registeredConfigurationsCount: Number(configCounts.rows[0]?.total_configs || 0),
    shadowRecommendations: {
      total: shadowTotal,
      diffCount: shadowDiffs,
      diffRatePercent: shadowTotal > 0 ? Math.round((shadowDiffs / shadowTotal) * 1000) / 10 : 0
    },
    runsByTreatmentOrigin: Object.fromEntries(treatmentOriginCounts.rows.map(r => [r.origin, { runs: r.count, totalQuota: r.total_quota }])),
    orderingPerformanceByMode: orderingPerformance.rows.map(r => {
      const q = Math.max(1, Number(r.total_quota || 0));
      return {
        ordering: r.search_ordering,
        runs: Number(r.run_count || 0),
        totalQuota: q,
        relevantYieldPer1000Quota: Math.round((Number(r.confirmed || 0) / q) * 1000 * 100) / 100,
        qualityYieldPer1000Quota: Math.round((Number(r.quality || 0) / q) * 1000 * 100) / 100
      };
    }),
    pageLevelYieldBreakdown: pageYields.rows
  };
}

/**
 * Compares Control vs Canary Treatment runs.
 */
export async function getRetrievalPolicyControlComparison(windowDays = 7): Promise<{
  control: Record<string, unknown>;
  canaryTreatment: Record<string, unknown>;
}> {
  if (!process.env.DATABASE_URL) return { control: {}, canaryTreatment: {} };
  const db = await getDb();

  const [controlRes, canaryRes] = await Promise.all([
    db.query(
      `SELECT
         COUNT(*)::int AS run_count,
         COALESCE(SUM(quota_used), 0)::int AS total_quota,
         COALESCE(SUM(new_channels), 0)::int AS new_creators,
         COALESCE(SUM(trading_confirmed), 0)::int AS relevant_creators,
         COALESCE(SUM(quality_channels), 0)::int AS quality_creators
       FROM query_runs
       WHERE created_at >= now() - ($1 || ' days')::interval
         AND COALESCE(retrieval_treatment_origin, 'CONTROL') = 'CONTROL'`,
      [windowDays]
    ),
    db.query(
      `SELECT
         COUNT(*)::int AS run_count,
         COALESCE(SUM(quota_used), 0)::int AS total_quota,
         COALESCE(SUM(new_channels), 0)::int AS new_creators,
         COALESCE(SUM(trading_confirmed), 0)::int AS relevant_creators,
         COALESCE(SUM(quality_channels), 0)::int AS quality_creators
       FROM query_runs
       WHERE created_at >= now() - ($1 || ' days')::interval
         AND retrieval_treatment_origin = 'CANARY_TREATMENT'`,
      [windowDays]
    )
  ]);

  const ctrl = controlRes.rows[0] || {};
  const trt = canaryRes.rows[0] || {};
  const cQuota = Math.max(1, ctrl.total_quota || 0);
  const tQuota = Math.max(1, trt.total_quota || 0);

  return {
    control: {
      runs: ctrl.run_count || 0,
      totalQuota: cQuota,
      newCreators: ctrl.new_creators || 0,
      relevantNewCreators: ctrl.relevant_creators || 0,
      qualityNewCreators: ctrl.quality_creators || 0,
      relevantYieldPer1000Quota: Math.round(((ctrl.relevant_creators || 0) / cQuota) * 1000 * 100) / 100,
      qualityYieldPer1000Quota: Math.round(((ctrl.quality_creators || 0) / cQuota) * 1000 * 100) / 100
    },
    canaryTreatment: {
      runs: trt.run_count || 0,
      totalQuota: tQuota,
      newCreators: trt.new_creators || 0,
      relevantNewCreators: trt.relevant_creators || 0,
      qualityNewCreators: trt.quality_creators || 0,
      relevantYieldPer1000Quota: Math.round(((trt.relevant_creators || 0) / tQuota) * 1000 * 100) / 100,
      qualityYieldPer1000Quota: Math.round(((trt.quality_creators || 0) / tQuota) * 1000 * 100) / 100
    }
  };
}
