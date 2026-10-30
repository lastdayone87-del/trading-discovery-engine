import { getDb } from './db';
import type { RetrievalLane } from './retrievalLanes';
import type { SearchOrdering } from './searchOrdering';
import {
  countTrailingContinuationStreaks,
  countTrailingLowYieldPages,
  parseContinuationDecisionV2,
  type ContinuationDecision,
  type ContinuationDecisionV2,
  type ContinuationStreaks,
} from './continuationPolicy';
import type { QueryFunnelMetrics } from './queryPerformance';

export type AutonomousPageDecision = ContinuationDecision | ContinuationDecisionV2;

type PageStoreRunner = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };

export interface AutonomousPageObservation {
  queryRunId: string;
  pageNumber: number;
  inputPageToken: string | null;
  nextPageToken: string | null;
  retrievalLane: RetrievalLane;
  searchOrdering: SearchOrdering;
  rawResultCount: number;
  distinctCreatorCount: number;
  knownCreators: number;
  newCreators: number;
  confirmedCreators: number;
  qualityConfirmedCreators: number;
  averageQualityScore: number;
  countryPrecision: number;
  communityDiversity: number;
  noveltyRatio: number;
  duplicateRatio: number;
  quotaUnits: number;
  decision: AutonomousPageDecision;
  stoppingReason: string | null;
  pageMetrics: QueryFunnelMetrics;
  retrievalConfigKey?: string | null;
  retrievalTreatmentOrigin?: string | null;
  // Country Discovery Loop v2 page economics (all optional for legacy callers).
  elapsedMs?: number;
  retrievalMs?: number;
  processingMs?: number;
  marginalNewCreators?: number;
  marginalConfirmedCreators?: number;
  marginalQualityCreators?: number;
  marginalNonTradingCreators?: number;
  novelCandidateTerms?: number;
  crossPageRepeatCreators?: number;
  cumulativeUniqueCreators?: number;
  providerPageCostUnits?: number;
  providerPageCostUsd?: number;
  relevance?: Record<string, unknown>;
  marginalUtilityV2?: number;
  continuationDecisionV2?: ContinuationDecisionV2 | null;
  resumeMode?: 'TOKEN' | 'REWALK' | 'OFFSET' | 'NONE';
  deferredReason?: 'QUOTA' | 'TIME' | null;
}

function asContinuationDecisionV2(decision: AutonomousPageDecision): ContinuationDecisionV2 | null {
  return 'streaks' in decision && decision.streaks ? decision : null;
}

export async function recordAutonomousPage(p: AutonomousPageObservation): Promise<boolean> {
  const db = await getDb();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const decisionV2 = p.continuationDecisionV2 ?? asContinuationDecisionV2(p.decision);
    const r = await client.query(
      `INSERT INTO autonomous_query_page_observations(
         query_run_id,page_number,input_page_token,next_page_token,retrieval_lane,search_ordering,
         raw_result_count,distinct_creator_count,known_creators,new_creators,confirmed_creators,
         quality_confirmed_creators,average_quality_score,country_precision,community_diversity,
         novelty_ratio,duplicate_ratio,quota_units,marginal_utility,should_continue,
         decision_reason_codes,primary_reason,stopping_reason,page_metrics,retrieval_config_key,
         retrieval_treatment_origin,elapsed_ms,retrieval_ms,processing_ms,marginal_new_creators,
         marginal_confirmed_creators,marginal_quality_creators,marginal_non_trading_creators,
         novel_candidate_terms,cross_page_repeat_creators,cumulative_unique_creators,
         provider_page_cost_units,provider_page_cost_usd,relevance,marginal_utility_v2,
         continuation_decision_v2,resume_mode,deferred_reason
       ) VALUES(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
         $23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43
       ) ON CONFLICT(query_run_id,page_number) DO NOTHING RETURNING id`,
      [
        p.queryRunId, p.pageNumber, p.inputPageToken, p.nextPageToken, p.retrievalLane, p.searchOrdering,
        p.rawResultCount, p.distinctCreatorCount, p.knownCreators, p.newCreators, p.confirmedCreators,
        p.qualityConfirmedCreators, p.averageQualityScore, p.countryPrecision, p.communityDiversity,
        p.noveltyRatio, p.duplicateRatio, p.quotaUnits, p.decision.marginalUtility, p.decision.shouldContinue,
        JSON.stringify(p.decision.reasonCodes), p.decision.primaryReason, p.stoppingReason,
        JSON.stringify(p.pageMetrics), p.retrievalConfigKey || null, p.retrievalTreatmentOrigin || 'CONTROL',
        Math.max(0, Math.trunc(p.elapsedMs || 0)), Math.max(0, Math.trunc(p.retrievalMs || 0)),
        Math.max(0, Math.trunc(p.processingMs || 0)), Math.max(0, Math.trunc(p.marginalNewCreators || 0)),
        Math.max(0, Math.trunc(p.marginalConfirmedCreators || 0)), Math.max(0, Math.trunc(p.marginalQualityCreators || 0)),
        Math.max(0, Math.trunc(p.marginalNonTradingCreators || 0)), Math.max(0, Math.trunc(p.novelCandidateTerms || 0)),
        Math.max(0, Math.trunc(p.crossPageRepeatCreators || 0)), Math.max(0, Math.trunc(p.cumulativeUniqueCreators || 0)),
        Math.max(0, Math.trunc(p.providerPageCostUnits || 0)), Math.max(0, Number(p.providerPageCostUsd || 0)),
        JSON.stringify(p.relevance || {}), Number(p.marginalUtilityV2 ?? p.decision.marginalUtility ?? 0),
        JSON.stringify(decisionV2 || {}), p.resumeMode || 'NONE', p.deferredReason || null,
      ],
    );
    if (r.rowCount) {
      const run = await client.query(`SELECT query_id,job_id,country FROM query_runs WHERE id=$1`, [p.queryRunId]);
      await client.query(
        `INSERT INTO outcome_events(
           event_key,subject_type,subject_id,event_type,event_version,source_event_key,query_id,
           query_run_id,job_id,country,retrieval_lane,verification_status,policy_version,
           feature_version,event_time,payload
         ) VALUES($1,'QUERY_PAGE',$2,'PAGE_FUNNEL_RECORDED',1,$3,$4,$9,$5,$6,$7,'PROVISIONAL',
           'passive-exploration-v1','query-page-funnel-v1',now(),$8)
         ON CONFLICT(event_key) DO NOTHING`,
        [
          `query-run:${p.queryRunId}:page:${p.pageNumber}:funnel:v1`, p.queryRunId,
          `query-run:${p.queryRunId}:selected:v1`, run.rows[0]?.query_id, run.rows[0]?.job_id,
          run.rows[0]?.country, p.retrievalLane,
          JSON.stringify({...p.pageMetrics,quotaUsed:p.quotaUnits,pageNumber:p.pageNumber}),p.queryRunId],
      );
      await client.query(
        `UPDATE query_runs
         SET pages_completed=GREATEST(pages_completed,$2), next_page_token=$3,
             last_page_at=now(), run_quota_consumed_units=run_quota_consumed_units+$4
         WHERE id=$1`,
        [p.queryRunId, p.pageNumber, p.nextPageToken, Math.max(0, Math.trunc(p.quotaUnits || 0))],
      );
    }
    await client.query('COMMIT');
    return !!r.rowCount;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function autonomousPageExists(runId: string, pageNumber: number): Promise<boolean> {
  const db = await getDb();
  const r = await db.query('SELECT 1 FROM autonomous_query_page_observations WHERE query_run_id=$1 AND page_number=$2', [runId, pageNumber]);
  return !!r.rowCount;
}

export interface PersistedAutonomousPage {
  pageNumber: number;
  nextPageToken: string | null;
  shouldContinue: boolean;
  primaryReason: string;
  continuationDecisionV2: ContinuationDecisionV2 | null;
  pageMetrics: QueryFunnelMetrics;
  resumeMode: 'TOKEN' | 'REWALK' | 'OFFSET' | 'NONE';
  elapsedMs: number;
  retrievalMs: number;
  processingMs: number;
  providerPageCostUnits: number;
  providerPageCostUsd: number;
}

/**
 * Re-read the durable post-page decision. A saved page is the retry point of
 * no return: re-running it would spend quota and double-count sightings, so a
 * retry replays the handoff from this record instead of the provider.
 */
export async function getAutonomousPageObservation(runId: string, pageNumber: number): Promise<PersistedAutonomousPage | null> {
  const db = await getDb();
  const r = await db.query(
    `SELECT page_number,next_page_token,should_continue,primary_reason,continuation_decision_v2,
            page_metrics,resume_mode,elapsed_ms,retrieval_ms,processing_ms,
            provider_page_cost_units,provider_page_cost_usd
     FROM autonomous_query_page_observations
     WHERE query_run_id=$1 AND page_number=$2`,
    [runId, pageNumber],
  );
  const row = r.rows[0];
  if (!row) return null;
  const parse = <T>(value: unknown, fallback: T): T => {
    if (value === null || value === undefined) return fallback;
    if (typeof value !== 'string') return value as T;
    try { return JSON.parse(value) as T; } catch { return fallback; }
  };
  return {
    pageNumber: Number(row.page_number),
    nextPageToken: row.next_page_token ? String(row.next_page_token) : null,
    shouldContinue: row.should_continue === true,
    primaryReason: String(row.primary_reason || ''),
    continuationDecisionV2: parseContinuationDecisionV2(parse<unknown>(row.continuation_decision_v2, null)),
    pageMetrics: parse<QueryFunnelMetrics>(row.page_metrics, {} as QueryFunnelMetrics),
    resumeMode: String(row.resume_mode || 'NONE') as PersistedAutonomousPage['resumeMode'],
    elapsedMs: Math.max(0, Number(row.elapsed_ms || 0)),
    retrievalMs: Math.max(0, Number(row.retrieval_ms || 0)),
    processingMs: Math.max(0, Number(row.processing_ms || 0)),
    providerPageCostUnits: Math.max(0, Number(row.provider_page_cost_units || 0)),
    providerPageCostUsd: Math.max(0, Number(row.provider_page_cost_usd || 0)),
  };
}

export interface AutonomousPageMarginalMetrics {
  pageDistinctCreators: number;
  marginalNewCreators: number;
  marginalConfirmedCreators: number;
  marginalQualityCreators: number;
  marginalNonTradingCreators: number;
  crossPageRepeatCreators: number;
  cumulativeUniqueCreators: number;
  cumulativeCountryRejected: number;
  cumulativeConfirmedCreators: number;
  cumulativeQualityCreators: number;
  cumulativeNonTradingCreators: number;
}

/**
 * Deduplicated page-scoped and run-cumulative creator outcomes. A creator is
 * attributed to the page of its FIRST sighting in the run, even when the
 * trading/quality outcome resolves later. Cumulative distinct creators are
 * counted from channel_sightings, never by summing per-page distinct counts.
 */
export async function getAutonomousPageMarginalMetrics(runId: string, pageNumber: number, clientOverride?: PageStoreRunner): Promise<AutonomousPageMarginalMetrics> {
  const db = clientOverride || await getDb();
  const targetPage = Math.max(1, Math.trunc(pageNumber) || 1);
  const result = await db.query(
    `WITH first_sighting AS (
       SELECT s.channel_id, MIN(s.page_number) AS first_page,
              -- Productivity requires a persisted fresh creator. An unseen
              -- country-rejected candidate was never catalogued and must not
              -- excuse a low-value or wrong-country page from stopping.
              BOOL_OR(s.persisted AND NOT s.was_known) AS was_new,
              -- Outcome at the creator's first sighting: a creator rejected on
              -- page 1 and seen again on page 3 is still one rejection.
              (array_agg(s.funnel_outcome ORDER BY s.page_number))[1] AS first_outcome
       FROM channel_sightings s
       WHERE s.query_run_id=$1
       GROUP BY s.channel_id
     ),
     page_sightings AS (
       SELECT DISTINCT s.channel_id
       FROM channel_sightings s
       WHERE s.query_run_id=$1 AND s.page_number=$2
     )
     SELECT
       COUNT(*) FILTER (WHERE fs.first_page=$2)::int AS page_distinct,
       COUNT(*) FILTER (WHERE fs.first_page=$2 AND fs.was_new)::int AS marginal_new,
       COUNT(*) FILTER (WHERE fs.first_page=$2 AND c.trading_status='TRADING_CONFIRMED')::int AS marginal_confirmed,
       COUNT(*) FILTER (WHERE fs.first_page=$2 AND c.trading_status='TRADING_CONFIRMED' AND COALESCE(c.quality_score,0)>=55)::int AS marginal_quality,
       COUNT(*) FILTER (WHERE fs.first_page=$2 AND c.trading_status IN ('NON_TRADING','HUMAN_REJECTED'))::int AS marginal_non_trading,
       COUNT(*) FILTER (WHERE fs.first_page < $2 AND ps.channel_id IS NOT NULL)::int AS cross_page_repeat,
       COUNT(*) FILTER (WHERE fs.first_page <= $2)::int AS cumulative_unique,
       COUNT(*) FILTER (WHERE fs.first_page <= $2 AND fs.first_outcome='COUNTRY_REJECTED')::int AS cumulative_country_rejected,
       COUNT(*) FILTER (WHERE fs.first_page <= $2 AND c.trading_status='TRADING_CONFIRMED')::int AS cumulative_confirmed,
       COUNT(*) FILTER (WHERE fs.first_page <= $2 AND c.trading_status='TRADING_CONFIRMED' AND COALESCE(c.quality_score,0)>=55)::int AS cumulative_quality,
       COUNT(*) FILTER (WHERE fs.first_page <= $2 AND c.trading_status IN ('NON_TRADING','HUMAN_REJECTED'))::int AS cumulative_non_trading
     FROM first_sighting fs
     LEFT JOIN channels c ON c.channel_id=fs.channel_id
     LEFT JOIN page_sightings ps ON ps.channel_id=fs.channel_id`,
    [runId, targetPage],
  );
  const row = result.rows[0] || {};
  return {
    pageDistinctCreators: Number(row.page_distinct || 0),
    marginalNewCreators: Number(row.marginal_new || 0),
    marginalConfirmedCreators: Number(row.marginal_confirmed || 0),
    marginalQualityCreators: Number(row.marginal_quality || 0),
    marginalNonTradingCreators: Number(row.marginal_non_trading || 0),
    crossPageRepeatCreators: Number(row.cross_page_repeat || 0),
    cumulativeUniqueCreators: Number(row.cumulative_unique || 0),
    cumulativeCountryRejected: Number(row.cumulative_country_rejected || 0),
    cumulativeConfirmedCreators: Number(row.cumulative_confirmed || 0),
    cumulativeQualityCreators: Number(row.cumulative_quality || 0),
    cumulativeNonTradingCreators: Number(row.cumulative_non_trading || 0),
  };
}

/**
 * Count literal candidate terms first observed on this page (novel to the
 * country's canonical vocabulary). A new canonical term is only counted when
 * an observation from a creator sighted on this page created/refreshed it
 * after the page began; existing canonical terms are never "novel".
 */
export async function countNovelCandidateTermsForPage(
  runId: string,
  pageNumber: number,
  since: Date,
): Promise<number> {
  const db = await getDb();
  const result = await db.query(
    `SELECT COUNT(DISTINCT t.id)::int AS novel_terms
     FROM terminology_observations o
     JOIN canonical_trading_terms t ON t.id=o.canonical_term_id
     WHERE o.query_run_id=$1
       AND o.query_page_number=$2
       AND o.observed_at >= $3
       AND COALESCE(t.first_observed_at, t.created_at) >= $3`,
    [runId, Math.max(1, Math.trunc(pageNumber) || 1), since.toISOString()],
  );
  return Number(result.rows[0]?.novel_terms || 0);
}

export interface AutonomousContinuationState {
  consecutiveLowYieldPages: number;
  cumulativeDistinctCreators: number;
  delayedConfirmedCreators: number;
  delayedNonTradingCreators: number;
  delayedQualityCreators: number;
  // v2: page-scoped outcomes and reconstructed consecutive streaks.
  pageConfirmedCreators: number;
  pageQualityCreators: number;
  pageNonTradingCreators: number;
  cumulativeConfirmedCreators: number;
  cumulativeQualityCreators: number;
  cumulativeNonTradingCreators: number;
  v2Streaks: ContinuationStreaks;
  lastDecisionV2: ContinuationDecisionV2 | null;
}

export async function getAutonomousContinuationState(runId: string, pageNumber?: number, clientOverride?: PageStoreRunner): Promise<AutonomousContinuationState> {
  const db = clientOverride || await getDb();
  const targetPage = Math.max(1, pageNumber || 1);
  // Streaks describe pages *before* the page being evaluated. Including the
  // current page would double-count a persisted decision when a page job is
  // retried and could stop the run before page+1 is queued.
  const [pagesRes, marginal] = await Promise.all([
    db.query(
      `SELECT distinct_creator_count,marginal_utility,decision_reason_codes,continuation_decision_v2
       FROM autonomous_query_page_observations
       WHERE query_run_id=$1 AND page_number < $2
       ORDER BY page_number DESC`,
      [runId, targetPage],
    ),
    getAutonomousPageMarginalMetrics(runId, targetPage, db),
  ]);
  const rows = pagesRes.rows.map(row => {
    const codes = typeof row.decision_reason_codes === 'string'
      ? JSON.parse(row.decision_reason_codes)
      : row.decision_reason_codes;
    return {
      marginalUtility: Number(row.marginal_utility),
      reasonCodes: Array.isArray(codes) ? codes : [],
      continuationDecisionV2: typeof row.continuation_decision_v2 === 'string'
        ? JSON.parse(row.continuation_decision_v2)
        : row.continuation_decision_v2,
    };
  });
  const consecutive = countTrailingLowYieldPages(rows);
  const v2Streaks = countTrailingContinuationStreaks(rows);
  return {
    consecutiveLowYieldPages: consecutive,
    cumulativeDistinctCreators: marginal.cumulativeUniqueCreators,
    delayedConfirmedCreators: marginal.cumulativeConfirmedCreators,
    delayedNonTradingCreators: marginal.cumulativeNonTradingCreators,
    delayedQualityCreators: marginal.cumulativeQualityCreators,
    pageConfirmedCreators: marginal.marginalConfirmedCreators,
    pageQualityCreators: marginal.marginalQualityCreators,
    pageNonTradingCreators: marginal.marginalNonTradingCreators,
    cumulativeConfirmedCreators: marginal.cumulativeConfirmedCreators,
    cumulativeQualityCreators: marginal.cumulativeQualityCreators,
    cumulativeNonTradingCreators: marginal.cumulativeNonTradingCreators,
    v2Streaks,
    lastDecisionV2: rows.length ? parseContinuationDecisionV2(rows[0].continuationDecisionV2) : null,
  };
}

export async function getAutonomousRunMetrics(runId: string): Promise<QueryFunnelMetrics> {
  const db = await getDb();
  const r = await db.query(
    'SELECT page_metrics, cumulative_unique_creators FROM autonomous_query_page_observations WHERE query_run_id=$1 ORDER BY page_number',
    [runId],
  );
  return aggregatePageMetrics(r.rows.map(row => {
    const metrics = typeof row.page_metrics === 'string' ? JSON.parse(row.page_metrics) : row.page_metrics;
    // Attach the persisted cumulative count so aggregation reports the run's
    // true unique reach instead of the sum of overlapping page populations.
    const cumulative = row.cumulative_unique_creators === null || row.cumulative_unique_creators === undefined
      ? undefined
      : Math.max(0, Number(row.cumulative_unique_creators) || 0);
    return cumulative === undefined ? metrics : { ...metrics, cumulativeUniqueCreators: cumulative };
  }));
}

export interface PendingAutonomousRun {
  runId: string;
  queryId: number;
  query: string;
  country: string;
  source: string;
  pagesCompleted: number;
  nextPageToken: string | null;
  resumeMode: 'TOKEN' | 'REWALK' | 'OFFSET' | 'NONE';
  continuationStatus: string;
  /**
   * The linked child owns the next cursor. A parent with this set must never
   * be resumed as if it still owned its cursor; the reconciler only repairs
   * the child handoff and finalizes the parent.
   */
  continuedToRunId: string | null;
  deferredUntil: string | null;
  lastPageAt: string | null;
  /**
   * Age anchor used by the SQL shortlist: last_page_at, else started_at, else
   * scheduled_at. The reconciler must sort on the same value or its retained
   * candidates can disagree with the SQL ranking.
   */
  resumeAt: string | null;
  explorationPagesRemaining: number;
  retrievalLane: string | null;
  searchOrdering: string | null;
  retrievalConfigKey: string | null;
  retrievalTreatmentOrigin: string | null;
  requestedPageDepth: number | null;
  /** Run metadata carries the original trial/experiment linkage. */
  runMetadata: Record<string, unknown> | null;
  providerAllocationSnapshot: unknown;
  marginalUtility: number;
}

/**
 * Fallback candidates retained per country. A blocked top run (for example a
 * treatment page whose incremental reservation was denied) must not prevent
 * another eligible run in the same country from resuming, so the reconciler
 * receives a small ranked list per country and tries the next candidate when
 * one cannot be scheduled. At most one run per country is enqueued per sweep.
 */
export const AUTONOMOUS_CONTINUATION_CANDIDATES_PER_COUNTRY = 5;

/**
 * Runs eligible for the orphan reconciler: up to
 * `AUTONOMOUS_CONTINUATION_CANDIDATES_PER_COUNTRY` best candidates per
 * country, ordered by country and within a country by marginal utility
 * descending, then oldest pending age, then run ID. There is no global row
 * limit here: a limit applied before the fairness rotation would exclude
 * alphabetically later countries permanently when the pending-country count
 * exceeds the limit. The caller rotates over the full country set, bounds the
 * countries per sweep, and allows at most one successful enqueue per country.
 */
export async function listPendingAutonomousRuns(
  perCountryLimit = AUTONOMOUS_CONTINUATION_CANDIDATES_PER_COUNTRY,
): Promise<PendingAutonomousRun[]> {
  const db = await getDb();
  const perCountry = Math.max(1, Math.min(20, Math.trunc(perCountryLimit) || AUTONOMOUS_CONTINUATION_CANDIDATES_PER_COUNTRY));
  const result = await db.query(
    // Rank within each country, then retain a small fallback list per country.
    // The caller's fairness cursor rotates across every country.
    `WITH candidates AS (
       SELECT qr.id, qr.query_id, ql.query, qr.country, qr.source, qr.pages_completed,
              qr.next_page_token, qr.resume_mode, qr.continuation_status, qr.deferred_until,
              qr.continued_to_run_id,
              qr.last_page_at, qr.exploration_pages_remaining, qr.retrieval_lane,
              qr.search_ordering, qr.retrieval_config_key, qr.retrieval_treatment_origin,
              qr.requested_page_depth, qr.metadata, qr.provider_allocation_snapshot,
              COALESCE(qr.last_page_at, qr.started_at, qr.scheduled_at) AS resume_at,
              COALESCE((
                SELECT p.marginal_utility_v2
                FROM autonomous_query_page_observations p
                WHERE p.query_run_id=qr.id
                ORDER BY p.page_number DESC LIMIT 1
              ),0) AS marginal_utility
       FROM query_runs qr
       JOIN query_library ql ON ql.id=qr.query_id
       WHERE qr.continuation_status IN ('RUNNING','DEFERRED_QUOTA','DEFERRED_TIME')
         AND qr.status NOT IN ('COMPLETED','FAILED')
         AND (qr.deferred_until IS NULL OR qr.deferred_until <= now())
         -- A live page job already owns this run. Only PENDING/PROCESSING
         -- block recovery: a COMPLETED/FAILED job whose page observation is
         -- missing is a deferred page and must be reopenable.
         AND NOT EXISTS (
           SELECT 1 FROM jobs j
           WHERE j.status IN ('PENDING','PROCESSING')
             AND (
               j.idempotency_key = 'search-run:'||qr.id
               OR j.idempotency_key = 'search-run:'||qr.id||':page:1'
               OR j.idempotency_key = 'search-run:'||qr.id||':page:'||GREATEST(qr.pages_completed+1,1)
             )
         )
     ), ranked AS (
       SELECT candidates.*,
              ROW_NUMBER() OVER (
                PARTITION BY LOWER(candidates.country)
                ORDER BY candidates.marginal_utility DESC, candidates.resume_at ASC, candidates.id ASC
              ) AS country_rank
       FROM candidates
     )
     SELECT * FROM ranked
     WHERE country_rank <= $1
     ORDER BY LOWER(country) ASC,
              country_rank ASC,
              marginal_utility DESC,
              resume_at ASC,
              id ASC`,
    [perCountry],
  );
  return result.rows.map((row: Record<string, unknown>) => ({
    runId: String(row.id),
    queryId: Number(row.query_id),
    query: String(row.query || ''),
    country: String(row.country),
    source: String(row.source),
    pagesCompleted: Number(row.pages_completed || 0),
    nextPageToken: row.next_page_token ? String(row.next_page_token) : null,
    resumeMode: String(row.resume_mode || 'NONE') as PendingAutonomousRun['resumeMode'],
    continuationStatus: String(row.continuation_status || 'RUNNING'),
    continuedToRunId: row.continued_to_run_id ? String(row.continued_to_run_id) : null,
    deferredUntil: row.deferred_until ? new Date(row.deferred_until as string).toISOString() : null,
    lastPageAt: row.last_page_at ? new Date(row.last_page_at as string).toISOString() : null,
    resumeAt: row.resume_at ? new Date(row.resume_at as string).toISOString() : null,
    explorationPagesRemaining: Number(row.exploration_pages_remaining || 0),
    retrievalLane: row.retrieval_lane ? String(row.retrieval_lane) : null,
    searchOrdering: row.search_ordering ? String(row.search_ordering) : null,
    retrievalConfigKey: row.retrieval_config_key ? String(row.retrieval_config_key) : null,
    retrievalTreatmentOrigin: row.retrieval_treatment_origin ? String(row.retrieval_treatment_origin) : null,
    requestedPageDepth: row.requested_page_depth == null ? null : Number(row.requested_page_depth),
    runMetadata: row.metadata && typeof row.metadata === 'object'
      ? row.metadata as Record<string, unknown>
      : null,
    providerAllocationSnapshot: row.provider_allocation_snapshot,
    marginalUtility: Number(row.marginal_utility || 0),
  }));
}

export function aggregatePageMetrics(pages: QueryFunnelMetrics[]): QueryFunnelMetrics {
  const sum = (key: keyof QueryFunnelMetrics) => pages.reduce((n, p) => n + Number(p[key] || 0), 0);
  const weightedDistinct = sum('distinctResults');
  // The last measured cumulative value is the run's unique reach; per-page
  // distinct counts overlap across pages and cannot be summed. Weighted
  // averages still use per-page distinct counts as their weights.
  let cumulativeDistinct: number | undefined;
  let cumulativeCountryRejected: number | undefined;
  for (const page of pages) {
    if (page.cumulativeUniqueCreators !== undefined) {
      const value = Math.max(0, Number(page.cumulativeUniqueCreators) || 0);
      // Migration 161 defaults historical rows to 0. Zero is never a valid
      // cumulative reach once a run has seen creators, and a zero-result page
      // must not erase an earlier cumulative. Treat it as an unbackfilled
      // legacy default; the per-page fallback below stays authoritative when
      // every row is zero.
      if (value > 0) cumulativeDistinct = value;
    }
    if (page.cumulativeCountryRejected !== undefined) {
      cumulativeCountryRejected = Math.max(0, Number(page.cumulativeCountryRejected) || 0);
    }
  }
  const distinct = cumulativeDistinct ?? weightedDistinct;
  // A creator repeated on several pages is one distinct result and must also
  // be one country rejection. The cumulative counter supplies the unique
  // count for CDL pages; legacy pages without it keep the summed fallback but
  // are clamped so precision cannot go negative.
  const countryRejected = Math.min(distinct, cumulativeCountryRejected ?? sum('countryRejected'));
  const evaluated = sum('nonTrading') + sum('uncertain') + sum('needsReview') + sum('tradingConfirmed');
  const weighted = (key: keyof QueryFunnelMetrics) => weightedDistinct ? pages.reduce((n, p) => n + p.distinctResults * Number(p[key] || 0), 0) / weightedDistinct : 0;
  // Scope weighting survives aggregation: pages carrying scope data sum
  // their in-scope counts while legacy pages without the field contribute
  // their full fresh count (neutral handling). The aggregate stays absent
  // only when NO page observed scope, preserving the legacy fallback.
  const scopedPages = pages.filter(p => p.inScopeNewChannels !== undefined);
  const inScopeAggregate = scopedPages.length
    ? pages.reduce((n, p) => n + Number(p.inScopeNewChannels ?? p.newChannels), 0)
    : undefined;
  return {
    rawResults: sum('rawResults'), deferredResults: sum('deferredResults'),
    evaluatedRawResults: sum('evaluatedRawResults'), distinctResults: distinct,
    duplicateResults: sum('duplicateResults'), knownChannels: sum('knownChannels'),
    newChannels: sum('newChannels'), inScopeNewChannels: inScopeAggregate,
    countryRejected, nonTrading: sum('nonTrading'),
    uncertain: sum('uncertain'), needsReview: sum('needsReview'),
    tradingConfirmed: sum('tradingConfirmed'),
    freshTradingConfirmed: sum('freshTradingConfirmed'),
    qualityChannels: sum('qualityChannels'),
    communitiesDiscovered: sum('communitiesDiscovered'),
    averageQualityScore: weighted('averageQualityScore'),
    noveltyRatio: distinct ? sum('newChannels') / distinct : 0,
    countryPrecision: distinct ? (distinct - countryRejected) / distinct : 0,
    tradingPrecision: evaluated ? sum('tradingConfirmed') / evaluated : 0,
    performanceScore: Math.round(weighted('performanceScore')),
  };
}
