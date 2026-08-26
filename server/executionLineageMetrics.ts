import { getDb } from './dbCore';

export function normalizeExecutionLineageWindowHours(value: unknown, fallback = 168): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(720, Math.max(1, Math.floor(parsed))) : fallback;
}

/**
 * Read-only aggregate over the existing append-only query/page/sighting/nomination
 * records. This function deliberately returns categories and counts only: no raw
 * query text, provider keys, identifiers, URLs, or channel content.
 */
export async function getExecutionLineageMetrics(hours = 168): Promise<Record<string, unknown>> {
  const windowHours = normalizeExecutionLineageWindowHours(hours);
  const db = await getDb();
  const params = [windowHours];
  const [runSummary, runBreakdown, providerOutcomes, pageSummary, pageBreakdown, sightingBreakdown, nominationBreakdown, admissionBreakdown, completeness, currentStates, continuationJobs] = await Promise.all([
    db.query(`SELECT COUNT(*)::int AS total_runs,
      COUNT(*) FILTER (WHERE status='COMPLETED')::int AS completed_runs,
      COUNT(*) FILTER (WHERE status='FAILED')::int AS failed_runs,
      COUNT(*) FILTER (WHERE status='RETRYING')::int AS retrying_runs,
      COUNT(*) FILTER (WHERE status NOT IN ('COMPLETED','FAILED','RETRYING'))::int AS open_runs,
      COALESCE(SUM(raw_results),0)::bigint AS raw_results,
      COALESCE(SUM(unique_channels),0)::bigint AS unique_channels,
      COALESCE(SUM(quality_channels),0)::bigint AS quality_channels,
      COALESCE(SUM(communities_discovered),0)::bigint AS communities_discovered,
      COALESCE(SUM(quota_reserved),0)::bigint AS quota_reserved,
      COALESCE(SUM(quota_used),0)::bigint AS quota_used,
      COALESCE(SUM(provider_requests_attempted),0)::bigint AS provider_requests_attempted,
      COALESCE(SUM(provider_requests_succeeded),0)::bigint AS provider_requests_succeeded,
      COALESCE(SUM(provider_requests_failed),0)::bigint AS provider_requests_failed,
      COALESCE(SUM(provider_rate_limited),0)::bigint AS provider_rate_limited
      FROM query_runs WHERE COALESCE(completed_at,started_at,scheduled_at) >= now() - ($1::int * interval '1 hour')`, params),
    db.query(`SELECT country, COALESCE(retrieval_lane,'UNSPECIFIED') AS retrieval_lane,
      COALESCE(provider_key,'UNSPECIFIED') AS provider_key, COALESCE(selection_strategy,'UNSPECIFIED') AS selection_strategy,
      status, COUNT(*)::int AS run_count, COALESCE(SUM(raw_results),0)::bigint AS raw_results,
      COALESCE(SUM(unique_channels),0)::bigint AS unique_channels, COALESCE(SUM(quality_channels),0)::bigint AS quality_channels,
      COALESCE(SUM(communities_discovered),0)::bigint AS communities_discovered,
      COALESCE(SUM(quota_used),0)::bigint AS quota_used
      FROM query_runs WHERE COALESCE(completed_at,started_at,scheduled_at) >= now() - ($1::int * interval '1 hour')
      GROUP BY country,retrieval_lane,provider_key,selection_strategy,status ORDER BY country,retrieval_lane,provider_key,status`, params),
    db.query(`SELECT COALESCE(NULLIF(performance_details->>'providerRunOutcome',''),
        CASE WHEN provider_key='youtube-search' AND COALESCE(provider_requests_attempted,0)>0 THEN 'UNLABELED_PROVIDER_ATTEMPT' ELSE 'NO_PROVIDER_OUTCOME' END) AS provider_outcome,
      COUNT(*)::int AS run_count, COALESCE(SUM(raw_results),0)::bigint AS raw_results,
      COALESCE(SUM(unique_channels),0)::bigint AS unique_channels, COALESCE(SUM(quota_used),0)::bigint AS quota_used
      FROM query_runs WHERE COALESCE(completed_at,started_at,scheduled_at) >= now() - ($1::int * interval '1 hour')
      GROUP BY provider_outcome ORDER BY provider_outcome`, params),
    db.query(`SELECT COUNT(*)::int AS page_observations, COUNT(DISTINCT query_run_id)::int AS runs_with_pages,
      COUNT(*) FILTER (WHERE input_page_token IS NULL)::int AS first_pages,
      COUNT(*) FILTER (WHERE input_page_token IS NOT NULL)::int AS continuation_pages,
      COUNT(*) FILTER (WHERE next_page_token IS NOT NULL)::int AS pages_with_continuation,
      COUNT(*) FILTER (WHERE should_continue)::int AS pages_marked_continue,
      COUNT(*) FILTER (WHERE stopping_reason IS NOT NULL)::int AS pages_with_stop_reason,
      COALESCE(SUM(raw_result_count),0)::bigint AS raw_results,
      COALESCE(SUM(distinct_creator_count),0)::bigint AS distinct_creators,
      COALESCE(SUM(new_creators),0)::bigint AS new_creators,
      COALESCE(SUM(duplicate_ratio),0)::float AS duplicate_ratio_sum,
      COALESCE(SUM(quota_units),0)::bigint AS quota_units
      FROM autonomous_query_page_observations WHERE created_at >= now() - ($1::int * interval '1 hour')`, params),
    db.query(`SELECT page_number, COUNT(*)::int AS page_count, COUNT(*) FILTER (WHERE next_page_token IS NOT NULL)::int AS with_continuation,
      COUNT(*) FILTER (WHERE should_continue)::int AS marked_continue, COUNT(*) FILTER (WHERE stopping_reason IS NOT NULL)::int AS stopped,
      COALESCE(SUM(raw_result_count),0)::bigint AS raw_results, COALESCE(SUM(distinct_creator_count),0)::bigint AS distinct_creators,
      COALESCE(SUM(new_creators),0)::bigint AS new_creators, COALESCE(SUM(confirmed_creators),0)::bigint AS confirmed_creators,
      COALESCE(SUM(quality_confirmed_creators),0)::bigint AS quality_confirmed_creators,
      COALESCE(AVG(duplicate_ratio),0)::float AS average_duplicate_ratio
      FROM autonomous_query_page_observations WHERE created_at >= now() - ($1::int * interval '1 hour')
      GROUP BY page_number ORDER BY page_number`, params),
    db.query(`SELECT COALESCE(country_outcome,'UNSPECIFIED') AS country_outcome, COALESCE(trading_outcome,'UNSPECIFIED') AS trading_outcome,
      COALESCE(funnel_outcome,'UNSPECIFIED') AS funnel_outcome, COALESCE(search_lane,'UNSPECIFIED') AS retrieval_lane,
      COUNT(*)::int AS sightings, COUNT(*) FILTER (WHERE persisted)::int AS persisted,
      COUNT(*) FILTER (WHERE was_known)::int AS known, COUNT(*) FILTER (WHERE NOT was_known)::int AS new
      FROM channel_sightings WHERE observed_at >= now() - ($1::int * interval '1 hour')
      GROUP BY country_outcome,trading_outcome,funnel_outcome,retrieval_lane ORDER BY country_outcome,retrieval_lane,funnel_outcome`, params),
    db.query(`SELECT country, COALESCE(source_type,'UNSPECIFIED') AS source_type,
      COALESCE(retrieval_lane,'UNSPECIFIED') AS retrieval_lane, COALESCE(query_generation_mode,'UNSPECIFIED') AS query_generation_mode,
      COUNT(*)::int AS nominations
      FROM discovery_nominations WHERE observed_at >= now() - ($1::int * interval '1 hour')
      GROUP BY country,source_type,retrieval_lane,query_generation_mode ORDER BY country,source_type,retrieval_lane,query_generation_mode`, params),
    db.query(`SELECT resulting_state, classification_status, investigation_state, COUNT(*)::int AS decisions
      FROM channel_admission_decisions WHERE decided_at >= now() - ($1::int * interval '1 hour')
      GROUP BY resulting_state,classification_status,investigation_state ORDER BY resulting_state,classification_status,investigation_state`, params),
    db.query(`SELECT COUNT(*)::int AS total_runs,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM autonomous_query_page_observations p WHERE p.query_run_id=qr.id))::int AS runs_with_pages,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM channel_sightings s WHERE s.query_run_id=qr.id))::int AS runs_with_sightings,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM discovery_nominations n WHERE n.query_run_id=qr.id))::int AS runs_with_nominations,
      COUNT(*) FILTER (WHERE NULLIF(qr.performance_details->>'providerRunOutcome','') IS NOT NULL)::int AS runs_with_provider_outcome,
      COUNT(*) FILTER (WHERE qr.provider_key='youtube-search' AND COALESCE(qr.provider_requests_attempted,0)>0)::int AS youtube_runs_with_provider_attempt,
      COUNT(*) FILTER (WHERE qr.provider_key='youtube-search' AND COALESCE(qr.provider_requests_attempted,0)=0)::int AS youtube_runs_without_provider_attempt
      FROM query_runs qr WHERE COALESCE(qr.completed_at,qr.started_at,qr.scheduled_at) >= now() - ($1::int * interval '1 hour')`, params),
    db.query(`SELECT COALESCE(country_status,'UNSPECIFIED') AS country_status, COALESCE(trading_status,'UNSPECIFIED') AS trading_status,
      COALESCE(scan_status,'UNSPECIFIED') AS scan_status, COALESCE(discord_status,'UNSPECIFIED') AS discord_status,
      COUNT(*)::int AS channels
      FROM channels GROUP BY country_status,trading_status,scan_status,discord_status ORDER BY country_status,trading_status,scan_status,discord_status`, []),
    db.query(`SELECT COUNT(*)::int AS search_youtube_jobs,
      COUNT(*) FILTER (WHERE CASE WHEN COALESCE(payload->>'pageNumber','') ~ '^[2-9][0-9]?$' THEN (payload->>'pageNumber')::int ELSE 1 END > 1)::int AS continuation_jobs,
      COUNT(*) FILTER (WHERE CASE WHEN COALESCE(payload->>'pageNumber','') ~ '^[2-9][0-9]?$' THEN (payload->>'pageNumber')::int ELSE 1 END > 1 AND status='PENDING')::int AS continuation_pending,
      COUNT(*) FILTER (WHERE CASE WHEN COALESCE(payload->>'pageNumber','') ~ '^[2-9][0-9]?$' THEN (payload->>'pageNumber')::int ELSE 1 END > 1 AND status='PROCESSING')::int AS continuation_processing,
      COUNT(*) FILTER (WHERE CASE WHEN COALESCE(payload->>'pageNumber','') ~ '^[2-9][0-9]?$' THEN (payload->>'pageNumber')::int ELSE 1 END > 1 AND status='COMPLETED')::int AS continuation_completed,
      COUNT(*) FILTER (WHERE CASE WHEN COALESCE(payload->>'pageNumber','') ~ '^[2-9][0-9]?$' THEN (payload->>'pageNumber')::int ELSE 1 END > 1 AND status='FAILED')::int AS continuation_failed,
      COUNT(*) FILTER (WHERE CASE WHEN COALESCE(payload->>'pageNumber','') ~ '^[2-9][0-9]?$' THEN (payload->>'pageNumber')::int ELSE 1 END > 1 AND status NOT IN ('PENDING','PROCESSING','COMPLETED','FAILED'))::int AS continuation_other,
      COUNT(*) FILTER (WHERE CASE WHEN COALESCE(payload->>'pageNumber','') ~ '^[2-9][0-9]?$' THEN (payload->>'pageNumber')::int ELSE 1 END > 1 AND NULLIF(payload->>'queryRunId','') IS NOT NULL)::int AS continuation_with_query_run_id,
      MIN(created_at) FILTER (WHERE CASE WHEN COALESCE(payload->>'pageNumber','') ~ '^[2-9][0-9]?$' THEN (payload->>'pageNumber')::int ELSE 1 END > 1) AS earliest_continuation_created_at,
      MAX(created_at) FILTER (WHERE CASE WHEN COALESCE(payload->>'pageNumber','') ~ '^[2-9][0-9]?$' THEN (payload->>'pageNumber')::int ELSE 1 END > 1) AS latest_continuation_created_at
      FROM jobs WHERE type='SEARCH_YOUTUBE' AND created_at >= now() - ($1::int * interval '1 hour')`, params)
  ]);
  const first = (result: any) => result.rows[0] || {};
  return {
    generatedAt: new Date().toISOString(), windowHours,
    runSummary: first(runSummary), runBreakdown: runBreakdown.rows, providerOutcomes: providerOutcomes.rows,
    pageSummary: first(pageSummary), pageBreakdown: pageBreakdown.rows,
    sightingBreakdown: sightingBreakdown.rows, nominationBreakdown: nominationBreakdown.rows,
    admissionBreakdown: admissionBreakdown.rows, completeness: first(completeness), currentChannelStates: currentStates.rows,
    continuationJobs: first(continuationJobs)
  };
}
