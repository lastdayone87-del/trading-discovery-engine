/**
 * Read-only P3 production verification.
 *
 * This file intentionally replaces the forensic investigation script only on a
 * short-lived diagnostic branch. It never writes to the production database.
 */
const fs = require('node:fs');
const { Client } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL secret is required');

const report = { generatedAt: new Date().toISOString(), readOnly: true, queries: {} };

async function main() {
  const client = new Client({ connectionString: DATABASE_URL, ssl: /railway|proxy|rlwy/.test(DATABASE_URL) ? { rejectUnauthorized: false } : undefined });
  await client.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    await client.query("SET LOCAL statement_timeout = '300s'");

    const q = async (label, sql, params = []) => {
      try {
        const result = await client.query(sql, params);
        report.queries[label] = { rows: result.rows };
        return result.rows;
      } catch (error) {
        report.queries[label] = { error: error.message };
        return null;
      }
    };

    await q('basics', `SELECT current_database() AS database, inet_server_addr()::text AS server_addr,
                             version() AS version, now() AS now`);
    const schema = await q('schema', `SELECT max(version)::int AS schema_version, count(*)::int AS applied
                                       FROM schema_migrations`);
    const markerRows = await q('deploy_marker', `SELECT applied_at FROM schema_migrations WHERE version=206`);
    const marker = markerRows?.[0]?.applied_at || null;

    await q('controls', `SELECT * FROM candidate_scoring_controls WHERE singleton=true`);
    await q('index', `SELECT i.indexrelid::regclass::text AS index_name, i.indisvalid, i.indisready,
                             i.indnatts, pg_get_indexdef(i.indexrelid) AS definition,
                             pg_size_pretty(pg_relation_size(i.indexrelid)) AS index_size
                        FROM pg_index i
                       WHERE i.indexrelid = to_regclass('public.idx_corpus_occurrences_normalized')`);
    await q('index_stats', `SELECT indexrelid::regclass::text AS index_name, idx_scan, idx_tup_read,
                                   idx_tup_fetch, pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
                              FROM pg_stat_user_indexes
                             WHERE relname='corpus_candidate_occurrences'
                             ORDER BY indexrelid::regclass::text`);
    await q('corpus_tables', `SELECT relname, n_live_tup, pg_size_pretty(pg_total_relation_size(oid)) AS total_size
                                FROM pg_class
                               WHERE relname IN ('corpus_candidate_occurrences','corpus_documents','candidate_feature_snapshots','candidate_adjudication_results')
                               ORDER BY relname`);
    await q('span_stats', `SELECT count(*)::bigint AS rows,
                                  max(octet_length(normalized_span))::int AS max_span_bytes,
                                  count(*) FILTER (WHERE octet_length(normalized_span)>2048)::int AS over_cap
                             FROM corpus_candidate_occurrences`);

    await q('jobs', `SELECT type, status, count(*)::int AS n
                       FROM jobs
                      WHERE type IN ('SCORE_CANDIDATES','TERM_HARVEST','AI_ADJUDICATE_CANDIDATE','ENRICH_CHANNEL','CLASSIFY_DISCOVERED_CHANNEL','FORCE_REVIEW_RESCAN')
                        AND status IN ('PENDING','PROCESSING','FAILED')
                      GROUP BY type, status
                      ORDER BY type, status`);
    if (marker) {
      await q('jobs_after_deploy', `SELECT type, status, count(*)::int AS n
                                      FROM jobs
                                     WHERE type IN ('SCORE_CANDIDATES','TERM_HARVEST','AI_ADJUDICATE_CANDIDATE','ENRICH_CHANNEL','CLASSIFY_DISCOVERED_CHANNEL','FORCE_REVIEW_RESCAN')
                                       AND created_at >= $1
                                     GROUP BY type, status
                                     ORDER BY type, status`, [marker]);
      await q('ai_jobs_after_deploy', `SELECT status, count(*)::int AS n,
                                              count(*) FILTER (WHERE last_error IS NOT NULL)::int AS with_error,
                                              max(last_error) AS sample_error
                                         FROM jobs
                                        WHERE type='AI_ADJUDICATE_CANDIDATE' AND created_at >= $1
                                        GROUP BY status ORDER BY status`, [marker]);
      await q('ai_deferrals', `SELECT status, count(*)::int AS n
                                 FROM jobs
                                WHERE type='AI_ADJUDICATE_CANDIDATE' AND created_at >= $1
                                  AND (last_error LIKE 'AI_ADJUDICATION_PAUSED%' OR last_error LIKE 'AI_BUDGET_EXHAUSTED%')
                                GROUP BY status ORDER BY status`, [marker]);
      await q('scoring_duration', `WITH attempts AS (
                                     SELECT a.started_at, a.finished_at,
                                            EXTRACT(EPOCH FROM (a.finished_at-a.started_at)) AS secs,
                                            a.started_at >= $1 AS after_deploy
                                       FROM jobs j
                                       JOIN LATERAL (
                                         SELECT started_at, finished_at
                                           FROM job_attempts
                                          WHERE job_id=j.id AND finished_at IS NOT NULL
                                          ORDER BY attempt_number DESC LIMIT 1
                                       ) a ON true
                                      WHERE j.type='SCORE_CANDIDATES'
                                        AND a.finished_at > now()-interval '7 days'
                                   )
                                   SELECT after_deploy, count(*)::int AS n,
                                          round(avg(secs)::numeric,1) AS avg_s,
                                          round(percentile_cont(0.5) WITHIN GROUP (ORDER BY secs)::numeric,1) AS p50_s,
                                          round(percentile_cont(0.95) WITHIN GROUP (ORDER BY secs)::numeric,1) AS p95_s,
                                          round(max(secs)::numeric,1) AS max_s
                                     FROM attempts GROUP BY after_deploy ORDER BY after_deploy`, [marker]);
      await q('scoring_duration_hourly', `SELECT date_trunc('hour', a.started_at) AS hour, count(*)::int AS n,
                                                 round(avg(EXTRACT(EPOCH FROM (a.finished_at-a.started_at)))::numeric,1) AS avg_s,
                                                 round(max(EXTRACT(EPOCH FROM (a.finished_at-a.started_at)))::numeric,1) AS max_s
                                            FROM jobs j
                                            JOIN LATERAL (
                                              SELECT started_at, finished_at
                                                FROM job_attempts
                                               WHERE job_id=j.id AND finished_at IS NOT NULL
                                               ORDER BY attempt_number DESC LIMIT 1
                                            ) a ON true
                                           WHERE j.type='SCORE_CANDIDATES'
                                             AND a.started_at >= $1
                                           GROUP BY 1 ORDER BY 1 DESC`, [marker]);
      await q('scoring_stuck', `SELECT count(*) FILTER (WHERE status='PROCESSING')::int AS processing,
                                       count(*) FILTER (WHERE status='PROCESSING' AND last_progress_at < now()-interval '5 minutes')::int AS stale
                                  FROM jobs WHERE type='SCORE_CANDIDATES'`);
      await q('scoring_latest', `SELECT id, status, attempts, created_at, last_progress_at, completed_at,
                                        left(COALESCE(last_error,''),180) AS error
                                   FROM jobs WHERE type='SCORE_CANDIDATES'
                                  ORDER BY created_at DESC LIMIT 12`);
      await q('scoring_docs_after_deploy', `SELECT id, status, payload->>'documentId' AS document_id, created_at
                                              FROM jobs
                                             WHERE type='SCORE_CANDIDATES' AND created_at >= $1
                                             ORDER BY created_at DESC LIMIT 8`, [marker]);
    }

    await q('channel_status', `SELECT trading_status, count(*)::int AS n
                                 FROM channels GROUP BY trading_status ORDER BY trading_status`);
    await q('channel_funnel_24h', `SELECT count(*)::int AS total,
                                          count(*) FILTER (WHERE created_at > now()-interval '24 hours')::int AS new_24h,
                                          count(*) FILTER (WHERE trading_status='TRADING_CONFIRMED' AND updated_at > now()-interval '24 hours')::int AS confirmed_24h,
                                          count(*) FILTER (WHERE scan_status='ENRICHMENT_PENDING')::int AS enrichment_pending
                                     FROM channels`);
    await q('confirmed_reviews', `SELECT r.state, count(*)::int AS n
                                    FROM channel_reviews r JOIN channels c USING(channel_id)
                                   WHERE c.trading_status='TRADING_CONFIRMED'
                                   GROUP BY r.state ORDER BY r.state`);
    await q('confirmed_no_review', `SELECT count(*)::int AS confirmed_without_pending_review
                                      FROM channels c
                                     WHERE c.trading_status='TRADING_CONFIRMED'
                                       AND NOT EXISTS (SELECT 1 FROM channel_reviews r WHERE r.channel_id=c.channel_id AND r.state='PENDING')`);
    if (marker) {
      await q('review_cleanup_after_deploy', `SELECT count(*)::int AS superseded_after_deploy
                                                FROM channel_reviews
                                               WHERE state='SUPERSEDED' AND updated_at >= $1`, [marker]);
      await q('diagnostics_after_deploy', `SELECT decision->>'status' AS status, count(*)::int AS n
                                             FROM production_classification_diagnostics
                                            WHERE created_at >= $1
                                            GROUP BY 1 ORDER BY n DESC`, [marker]);
      await q('semantic_confirmed_after_deploy', `SELECT decision->>'status' AS status, count(*)::int AS n
                                                    FROM production_classification_diagnostics
                                                   WHERE created_at >= $1
                                                     AND decision->'policy_reasons' @> '["SEMANTIC_ADMISSION_CONFIRMED"]'::jsonb
                                                   GROUP BY 1 ORDER BY n DESC`, [marker]);
      await q('semantic_confirmed_recent', `SELECT decision->>'status' AS status, count(*)::int AS n
                                              FROM production_classification_diagnostics
                                             WHERE created_at >= now()-interval '24 hours'
                                               AND decision->'policy_reasons' @> '["SEMANTIC_ADMISSION_CONFIRMED"]'::jsonb
                                             GROUP BY 1 ORDER BY n DESC`);
      await q('legacy_confidence', `SELECT COALESCE(decision->>'tradingFocus', decision->'classification'->>'tradingFocus') AS trading_focus,
                                           count(*)::int AS n
                                      FROM production_classification_diagnostics
                                     WHERE created_at >= $1
                                       AND decision->'policy_reasons' @> '["SEMANTIC_ADMISSION_CONFIRMED"]'::jsonb
                                     GROUP BY 1 ORDER BY n DESC`, [marker]);
      await q('ai_deferred_candidates', `SELECT count(*)::int AS deferred
                                           FROM candidate_feature_snapshots f
                                          WHERE f.decision='AMBIGUOUS'
                                            AND NOT EXISTS (SELECT 1 FROM classification_assertions a WHERE a.candidate_key=f.candidate_key AND a.assertion_source='AI')
                                            AND NOT EXISTS (SELECT 1 FROM candidate_adjudication_results r WHERE r.candidate_key=f.candidate_key)
                                            AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.type='AI_ADJUDICATE_CANDIDATE' AND j.payload->>'candidateKey'=f.candidate_key AND j.status IN ('PENDING','PROCESSING','FAILED'))`);
      await q('ai_usage_today', `SELECT count(*)::int AS completed_today,
                                        COALESCE(sum(cost_microunits),0)::bigint AS cost_today
                                   FROM candidate_adjudication_results
                                  WHERE completed_at >= date_trunc('day',now())`);
    }
    await q('scheduler', `SELECT name, is_enabled, is_running, locked_by, last_run_at, next_run_at,
                                 left(COALESCE(last_report::text,''),2000) AS last_report
                            FROM scheduler_state`);
    await q('query_runs_24h', `SELECT status, count(*)::int AS n, max(completed_at) AS latest
                                 FROM query_runs
                                WHERE scheduled_at > now()-interval '24 hours'
                                GROUP BY status ORDER BY n DESC`);

    const scoringDoc = report.queries.scoring_docs_after_deploy?.rows?.find(row => row.status === 'PENDING')
      || report.queries.scoring_docs_after_deploy?.rows?.[0];
    if (scoringDoc?.document_id) {
      const explain = await q('scoring_explain', `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT o.normalized_span,o.literal_span,o.document_id::text,a.entity_cluster_key,a.source_type,a.observed_at,
               d.language,o.start_offset,o.end_offset
          FROM corpus_candidate_occurrences o
          JOIN corpus_documents d ON d.id=o.document_id
          JOIN corpus_source_artifacts a ON a.id=d.artifact_id
         WHERE o.normalized_span IN (SELECT normalized_span FROM corpus_candidate_occurrences WHERE document_id=$1)
         ORDER BY o.normalized_span,a.observed_at,o.occurrence_key`, [scoringDoc.document_id]);
      const plan = explain?.[0]?.['QUERY PLAN']?.[0];
      if (plan) {
        report.scoringExplain = {
          documentId: scoringDoc.document_id,
          executionTimeMs: plan['Execution Time'],
          planningTimeMs: plan['Planning Time'],
          topNode: plan.Plan?.['Node Type'],
          indexNames: JSON.stringify(plan.Plan).match(/"Index Name":"[^"]+"/g) || [],
          sharedHitBlocks: plan.Plan?.['Shared Hit Blocks'],
          sharedReadBlocks: plan.Plan?.['Shared Read Blocks'],
        };
      }
    }

    await client.query('ROLLBACK');
  } finally {
    await client.end().catch(() => undefined);
  }

  fs.mkdirSync('forensic-output', { recursive: true });
  fs.writeFileSync('forensic-output/production-p3-verification.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    generatedAt: report.generatedAt,
    schema: report.queries.schema?.rows?.[0],
    deployMarker: report.queries.deploy_marker?.rows?.[0] || null,
    index: report.queries.index?.rows?.[0] || report.queries.index,
    indexStats: report.queries.index_stats?.rows,
    spanStats: report.queries.span_stats?.rows?.[0],
    controls: report.queries.controls?.rows?.[0],
    jobs: report.queries.jobs?.rows,
    jobsAfterDeploy: report.queries.jobs_after_deploy?.rows,
    aiJobsAfterDeploy: report.queries.ai_jobs_after_deploy?.rows,
    aiDeferrals: report.queries.ai_deferrals?.rows,
    aiDeferredCandidates: report.queries.ai_deferred_candidates?.rows?.[0],
    aiUsageToday: report.queries.ai_usage_today?.rows?.[0],
    scoringDuration: report.queries.scoring_duration?.rows,
    scoringDurationHourly: report.queries.scoring_duration_hourly?.rows,
    scoringStuck: report.queries.scoring_stuck?.rows?.[0],
    scoringExplain: report.scoringExplain,
    channelStatus: report.queries.channel_status?.rows,
    channelFunnel24h: report.queries.channel_funnel_24h?.rows?.[0],
    confirmedReviews: report.queries.confirmed_reviews?.rows,
    confirmedNoReview: report.queries.confirmed_no_review?.rows?.[0],
    reviewCleanupAfterDeploy: report.queries.review_cleanup_after_deploy?.rows?.[0],
    diagnosticsAfterDeploy: report.queries.diagnostics_after_deploy?.rows,
    semanticConfirmedAfterDeploy: report.queries.semantic_confirmed_after_deploy?.rows,
    legacyConfidence: report.queries.legacy_confidence?.rows,
    scheduler: report.queries.scheduler?.rows,
    queryRuns24h: report.queries.query_runs_24h?.rows,
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
