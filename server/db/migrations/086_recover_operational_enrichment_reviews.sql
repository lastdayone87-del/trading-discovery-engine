-- Recover channels that were sent to human review because enrichment/classification
-- provider coverage was operationally degraded rather than genuinely exhausted.
--
-- This is deliberately selective:
--   * only automated NEEDS_REVIEW rows with no completed human decision;
--   * only rows whose persisted classifier audit says provider coverage degraded,
--     or whose latest ENRICH_CHANNEL failure is recognizably infrastructural;
--   * only the latest enrichment job for each affected channel is reopened.
--
-- Human decisions, NON_TRADING/HUMAN_REJECTED tombstones, country policy, and
-- unrelated retry/cooldown jobs are not touched.

CREATE TEMP TABLE recover_operational_enrichment_reviews ON COMMIT DROP AS
SELECT c.channel_id
FROM channels c
LEFT JOIN channel_reviews r ON r.channel_id = c.channel_id
WHERE c.scan_status = 'NEEDS_REVIEW'
  AND c.trading_status = 'NEEDS_REVIEW'
  AND COALESCE(r.state::text, 'PENDING') = 'PENDING'
  AND NOT EXISTS (
    SELECT 1 FROM channel_review_decisions d WHERE d.channel_id = c.channel_id
  )
  AND (
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(COALESCE(c.trading_relevance_breakdown->'reasoning', '[]'::jsonb)) reason
      WHERE reason ILIKE '%Degraded Providers: true%'
         OR reason ILIKE '%PROVIDER_COVERAGE_DEGRADED%'
         OR reason ILIKE '%PROVIDER_TIMEOUT%'
         OR reason ILIKE '%PROVIDER_RATE_LIMIT%'
         OR reason ILIKE '%PROVIDER_TRANSIENT_FAILURE%'
         OR reason ILIKE '%PROVIDER_CREDENTIALS_EXHAUSTED%'
         OR reason ILIKE '%PROVIDER_CANCELLED%'
    )
    OR EXISTS (
      SELECT 1
      FROM jobs j
      WHERE j.type = 'ENRICH_CHANNEL'
        AND j.payload->>'channelId' = c.channel_id
        AND j.status = 'FAILED'
        AND (
          j.last_error ILIKE '%quota%'
          OR j.last_error ILIKE '%rate limit%'
          OR j.last_error ILIKE '%timeout%'
          OR j.last_error ILIKE '%timed out%'
          OR j.last_error ILIKE '%transient%'
          OR j.last_error ILIKE '%temporar%'
          OR j.last_error ILIKE '%ECONN%'
          OR j.last_error ILIKE '%EAI_AGAIN%'
          OR j.last_error ILIKE '%provider%cool%'
        )
    )
  );

-- Remove only the still-pending automated review request. A later legitimate
-- ambiguity can create a fresh review version through the existing trigger.
UPDATE channel_reviews r
SET state = 'SUPERSEDED', updated_at = now()
FROM recover_operational_enrichment_reviews recover
WHERE r.channel_id = recover.channel_id
  AND r.state = 'PENDING';

UPDATE channels c
SET trading_status = 'UNCERTAIN',
    scan_status = 'ENRICHMENT_PENDING',
    updated_at = now()
FROM recover_operational_enrichment_reviews recover
WHERE c.channel_id = recover.channel_id;

WITH latest AS (
  SELECT DISTINCT ON (j.payload->>'channelId')
    j.id,
    j.payload->>'channelId' AS channel_id
  FROM jobs j
  JOIN recover_operational_enrichment_reviews recover
    ON recover.channel_id = j.payload->>'channelId'
  WHERE j.type = 'ENRICH_CHANNEL'
    AND j.status IN ('FAILED','COMPLETED','PENDING')
  ORDER BY j.payload->>'channelId', j.updated_at DESC, j.created_at DESC
)
UPDATE jobs j
SET status = 'PENDING',
    attempts = 0,
    run_after = now(),
    locked_by = NULL,
    locked_at = NULL,
    last_error = NULL,
    completed_at = NULL,
    updated_at = now()
FROM latest
WHERE j.id = latest.id;
