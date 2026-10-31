-- P0.3 acquisition-failure classification (read-only).
-- Production: Coolify application 7zp5h5tz4dkjteaag4phxyme.
-- Access: local SSH tunnel 127.0.0.1:55432 -> 10.0.1.5:5432, role muse_readonly.
-- This script contains SELECT statements only and runs in a read-only transaction.
\pset footer off
\pset pager off
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '90s';
SET LOCAL lock_timeout = '5s';
SET LOCAL work_mem = '8MB';

\echo ## snapshot
SELECT now() AS snapshot_at,
       min(observed_at) AS earliest_observation,
       max(observed_at) AS latest_observation,
       count(*) AS all_observations
FROM external_acquisition_observations;

\echo ## creator_outcome_failure_7d
SELECT outcome, coalesce(failure_class, '(none)') AS failure_class, count(*) AS observations
FROM external_acquisition_observations
WHERE observed_at > now() - interval '7 days'
  AND provenance->>'surface' = 'CREATOR_WEBSITES'
GROUP BY 1, 2
ORDER BY 3 DESC;

\echo ## site_outcome_failure_7d
SELECT outcome, coalesce(failure_class, '(none)') AS failure_class, count(*) AS sites
FROM site_inspections
WHERE last_observed_at > now() - interval '7 days'
GROUP BY 1, 2
ORDER BY 3 DESC;

\echo ## pattern_outcome_7d
WITH o AS (
  SELECT requested_url, outcome
  FROM external_acquisition_observations
  WHERE observed_at > now() - interval '7 days'
    AND provenance->>'surface' = 'CREATOR_WEBSITES'
), c AS (
  SELECT *,
    CASE
      WHEN requested_url !~* '^https?://' THEN 'non-http'
      WHEN requested_url ~* '(%7b%7b|\{\{|window\.|this\.|function|undefined|\[object|%22%7b)' THEN 'template/malformed'
      WHEN requested_url ~* '\.(png|jpe?g|gif|svg|webp|avif|ico|css|js|json|xml|woff2?|ttf|otf|pdf|zip|mp4|webm|mp3|wav)([?#]|$)' THEN 'asset'
      WHEN regexp_replace(requested_url, '^https?://[^/]+', '') IN ('', '/') THEN 'root'
      WHEN requested_url ~ '\?' THEN 'query'
      ELSE 'deep'
    END AS pattern
  FROM o
)
SELECT pattern, outcome, count(*) AS observations
FROM c
GROUP BY 1, 2
ORDER BY 1, 3 DESC;

\echo ## stage_outcome_7d
WITH o AS (
  SELECT outcome, coalesce(failure_class, '(none)') AS failure_class
  FROM external_acquisition_observations
  WHERE observed_at > now() - interval '7 days'
    AND provenance->>'surface' = 'CREATOR_WEBSITES'
)
SELECT CASE
    WHEN failure_class = 'RENDERED_FALLBACK_SATURATED' THEN 'rendered-gate'
    WHEN failure_class IN ('RENDERED_INTERACTION_GAP', 'RENDERED_PARTIAL_COVERAGE') THEN 'rendered-interaction'
    WHEN failure_class = 'RENDERED_TIMEOUT' THEN 'rendered-fetch'
    WHEN failure_class IN ('STATIC_BUDGET_GAP', 'REQUIRED_UNVISITED_BUDGET_GAP') THEN 'static-navigation'
    WHEN failure_class IN ('HTTP_ERROR', 'TRANSIENT_HTTP', 'TIMEOUT', 'NETWORK_FAILURE', 'RATE_LIMIT',
                           'UNSUPPORTED_CONTENT_TYPE', 'LOGIN_WALL', 'PAYWALL_WALL',
                           'PERMANENT_ACCESS_BLOCK', 'REDIRECT_LOOP', 'SSRF_BLOCKED') THEN 'static-fetch'
    WHEN failure_class = 'NO_PAGE_PROCESSED' THEN 'static-parse'
    ELSE 'other/none'
  END AS stage,
  outcome,
  count(*) AS observations
FROM o
GROUP BY 1, 2
ORDER BY 1, 3 DESC;

\echo ## http_status_7d
SELECT coalesce(http_status::text, '(none)') AS http_status, count(*) AS observations
FROM external_acquisition_observations
WHERE observed_at > now() - interval '7 days'
  AND provenance->>'surface' = 'CREATOR_WEBSITES'
  AND failure_class IN ('HTTP_ERROR', 'TRANSIENT_HTTP', 'PERMANENT_ACCESS_BLOCK', 'RATE_LIMIT')
GROUP BY 1
ORDER BY 2 DESC
LIMIT 25;

\echo ## unsupported_content_type_7d
SELECT coalesce(substring(detail from 'Unsupported content type ([^ ;]+)'), '(unparsed)') AS content_type,
       count(*) AS observations
FROM external_acquisition_observations
WHERE observed_at > now() - interval '7 days'
  AND provenance->>'surface' = 'CREATOR_WEBSITES'
  AND failure_class = 'UNSUPPORTED_CONTENT_TYPE'
GROUP BY 1
ORDER BY 2 DESC
LIMIT 25;

\echo ## host_outcome_7d
WITH o AS (
  SELECT lower(regexp_replace(split_part(regexp_replace(requested_url, '^https?://', ''), '/', 1), '^www\.', '')) AS host_raw,
         outcome, coalesce(failure_class, '(none)') AS failure_class
  FROM external_acquisition_observations
  WHERE observed_at > now() - interval '7 days'
    AND provenance->>'surface' = 'CREATOR_WEBSITES'
), h AS (
  SELECT split_part(host_raw, ':', 1) AS host, outcome, failure_class FROM o
)
SELECT host,
       count(*) AS observations,
       count(*) FILTER (WHERE outcome = 'FOUND') AS found,
       count(*) FILTER (WHERE outcome = 'ACQUISITION_FAILED') AS failed,
       count(*) FILTER (WHERE outcome = 'PARTIALLY_INSPECTED') AS partial,
       count(*) FILTER (WHERE outcome = 'INSPECTED_NO_MATCH') AS no_match,
       round(100.0 * count(*) FILTER (WHERE outcome = 'FOUND') / count(*), 1) AS found_pct,
       mode() WITHIN GROUP (ORDER BY failure_class) FILTER (WHERE outcome = 'ACQUISITION_FAILED') AS top_failure
FROM h
GROUP BY host
HAVING count(*) >= 100
ORDER BY observations DESC
LIMIT 30;

\echo ## host_recovery_7d
WITH o AS (
  SELECT channel_id,
         lower(regexp_replace(split_part(regexp_replace(requested_url, '^https?://', ''), '/', 1), '^www\.', '')) AS host_raw,
         outcome, observed_at
  FROM external_acquisition_observations
  WHERE observed_at > now() - interval '7 days'
    AND provenance->>'surface' = 'CREATOR_WEBSITES'
), h AS (
  SELECT channel_id, split_part(host_raw, ':', 1) AS host, outcome, observed_at FROM o
), f AS (
  SELECT channel_id, host, min(observed_at) AS first_fail
  FROM h
  WHERE outcome = 'ACQUISITION_FAILED'
  GROUP BY 1, 2
), r AS (
  SELECT f.host, f.channel_id,
         bool_or(h.outcome = 'FOUND' AND h.observed_at > f.first_fail) AS recovered,
         bool_or(h.outcome = 'INSPECTED_NO_MATCH' AND h.observed_at > f.first_fail) AS clean_later
  FROM f
  JOIN h ON h.channel_id = f.channel_id AND h.host = f.host
  GROUP BY 1, 2
)
SELECT host,
       count(*) AS failed_channels,
       count(*) FILTER (WHERE recovered) AS recovered,
       count(*) FILTER (WHERE clean_later AND NOT recovered) AS clean_no_match_later,
       round(100.0 * count(*) FILTER (WHERE recovered) / count(*), 1) AS recovery_pct
FROM r
GROUP BY host
HAVING count(*) >= 20
ORDER BY failed_channels DESC
LIMIT 25;

\echo ## rendered_telemetry_7d
WITH r AS (
  SELECT provenance->'crawlerTelemetry' AS t
  FROM external_acquisition_observations
  WHERE observed_at > now() - interval '7 days'
    AND provenance->>'surface' = 'CREATOR_WEBSITES'
    AND provenance->'crawlerTelemetry'->>'mode' = 'RENDERED'
)
SELECT count(*) AS rendered_observations,
       count(*) FILTER (WHERE (t->>'pagesInspected')::int > 0) AS with_pages,
       sum((t->>'pagesInspected')::int) AS pages_inspected,
       sum((t->>'clicksStarted')::int) AS clicks_started,
       sum((t->>'clicksSucceeded')::int) AS clicks_succeeded,
       sum((t->>'clicksFailed')::int) AS clicks_failed,
       sum((t->>'requestsStarted')::int) AS requests_started,
       sum((t->>'requestsFailed')::int) AS requests_failed,
       sum((t->>'blockedRequests')::int) AS blocked_requests,
       sum((t->>'navigationTimeouts')::int) AS navigation_timeouts,
       sum((t->>'hostBackoffsApplied')::int) AS host_backoffs,
       count(*) FILTER (WHERE (t->>'budgetExhausted')::boolean) AS budget_exhausted
FROM r;

\echo ## click_failure_detail_7d
WITH r AS (
  SELECT provenance->'crawlerTelemetry' AS t
  FROM external_acquisition_observations
  WHERE observed_at > now() - interval '7 days'
    AND provenance->>'surface' = 'CREATOR_WEBSITES'
    AND provenance->'crawlerTelemetry'->>'mode' = 'RENDERED'
)
SELECT k AS failure_kind, sum(v::int) AS count
FROM r, jsonb_each_text(coalesce(t->'clickFailureDetail', '{}'::jsonb)) AS x(k, v)
GROUP BY 1
ORDER BY 2 DESC;

\echo ## drop_reasons_7d
WITH r AS (
  SELECT provenance->'crawlerTelemetry' AS t
  FROM external_acquisition_observations
  WHERE observed_at > now() - interval '7 days'
    AND provenance->>'surface' = 'CREATOR_WEBSITES'
    AND provenance->'crawlerTelemetry'->>'mode' = 'RENDERED'
)
SELECT k AS drop_reason, sum(v::int) AS count
FROM r, jsonb_each_text(coalesce(t->'dropReasons', '{}'::jsonb)) AS x(k, v)
GROUP BY 1
ORDER BY 2 DESC;

\echo ## ceilings_7d
WITH r AS (
  SELECT provenance->'crawlerTelemetry' AS t
  FROM external_acquisition_observations
  WHERE observed_at > now() - interval '7 days'
    AND provenance->>'surface' = 'CREATOR_WEBSITES'
    AND provenance->'crawlerTelemetry'->>'mode' = 'RENDERED'
)
SELECT coalesce(t->'ceiling'->>'kind', '(none)') AS ceiling, count(*) AS observations
FROM r
GROUP BY 1
ORDER BY 2 DESC;

\echo ## zero_page_reasons_7d
WITH r AS (
  SELECT provenance->'crawlerTelemetry' AS t
  FROM external_acquisition_observations
  WHERE observed_at > now() - interval '7 days'
    AND provenance->>'surface' = 'CREATOR_WEBSITES'
    AND provenance->'crawlerTelemetry'->>'mode' = 'RENDERED'
)
SELECT coalesce(t->>'zeroPageReason', '(none)') AS zero_page_reason, count(*) AS observations
FROM r
GROUP BY 1
ORDER BY 2 DESC;

\echo ## scrolls_used_7d
WITH r AS (
  SELECT provenance->'crawlerTelemetry' AS t
  FROM external_acquisition_observations
  WHERE observed_at > now() - interval '7 days'
    AND provenance->>'surface' = 'CREATOR_WEBSITES'
    AND provenance->'crawlerTelemetry'->>'mode' = 'RENDERED'
)
SELECT t->>'scrollsUsed' AS scrolls_used, count(*) AS observations
FROM r
WHERE t ? 'scrollsUsed'
GROUP BY 1
ORDER BY 2 DESC;

\echo ## retry_jobs
SELECT status,
       count(*) AS jobs,
       count(*) FILTER (WHERE attempts = 0) AS zero_attempt,
       count(*) FILTER (WHERE attempts BETWEEN 1 AND 2) AS one_or_two,
       count(*) FILTER (WHERE attempts >= 3) AS three_plus,
       round(avg(attempts), 1) AS avg_attempts,
       min(created_at) AS oldest,
       max(created_at) AS newest,
       count(*) FILTER (WHERE run_after <= now()) AS due
FROM jobs
WHERE type = 'RETRY_COMMUNITY_ACQUISITION'
GROUP BY status
ORDER BY jobs DESC;

\echo ## pending_retry_reasons
SELECT coalesce(payload->>'retryReason', '(none)') AS retry_reason,
       count(*) AS jobs,
       count(*) FILTER (WHERE attempts = 0) AS zero_attempt,
       count(*) FILTER (WHERE locked_by IS NULL) AS unlocked,
       count(*) FILTER (WHERE run_after <= now()) AS due
FROM jobs
WHERE type = 'RETRY_COMMUNITY_ACQUISITION' AND status = 'PENDING'
GROUP BY 1
ORDER BY 2 DESC;

\echo ## retry_attempts_7d
SELECT ja.status, count(*) AS attempts, count(*) FILTER (WHERE ja.error IS NOT NULL) AS with_error
FROM job_attempts ja
JOIN jobs j ON j.id = ja.job_id
WHERE j.type = 'RETRY_COMMUNITY_ACQUISITION'
  AND ja.started_at > now() - interval '7 days'
GROUP BY 1
ORDER BY 2 DESC;

\echo ## sample_failed_observations
SELECT left(channel_id, 10) || '…' AS channel_prefix,
       lower(regexp_replace(split_part(regexp_replace(requested_url, '^https?://', ''), '/', 1), '^www\.', '')) AS host,
       outcome,
       coalesce(failure_class, '(none)') AS failure_class,
       http_status,
       left(regexp_replace(coalesce(detail, ''), 'https?://[^ ]+', '<url>', 'g'), 140) AS safe_detail,
       provenance->'crawlerTelemetry'->>'mode' AS mode,
       provenance->'crawlerTelemetry'->>'pagesInspected' AS pages,
       provenance->'crawlerTelemetry'->>'clicksFailed' AS clicks_failed
FROM external_acquisition_observations
WHERE observed_at > now() - interval '7 days'
  AND provenance->>'surface' = 'CREATOR_WEBSITES'
  AND outcome = 'ACQUISITION_FAILED'
ORDER BY observed_at DESC
LIMIT 20;

COMMIT;
