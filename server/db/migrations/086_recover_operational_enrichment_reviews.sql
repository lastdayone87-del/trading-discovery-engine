-- Recover only automated NEEDS_REVIEW rows whose current classification or
-- latest enrichment outcome is operationally degraded. Historical failures are
-- deliberately ignored when a newer enrichment outcome exists.

CREATE TEMP TABLE recover_operational_enrichment_reviews ON COMMIT DROP AS
WITH latest_enrichment AS (
  SELECT DISTINCT ON (j.payload->>'channelId')
    j.payload->>'channelId' AS channel_id,
    j.id,
    j.status,
    j.last_error,
    j.updated_at,
    j.created_at
  FROM jobs j
  WHERE j.type='ENRICH_CHANNEL'
    AND j.payload ? 'channelId'
  ORDER BY j.payload->>'channelId', j.updated_at DESC, j.created_at DESC, j.id DESC
)
SELECT c.channel_id, latest.id AS job_id
FROM channels c
LEFT JOIN channel_reviews r ON r.channel_id=c.channel_id
LEFT JOIN latest_enrichment latest ON latest.channel_id=c.channel_id
WHERE c.scan_status='NEEDS_REVIEW'
  AND c.trading_status='NEEDS_REVIEW'
  AND COALESCE(r.state::text,'PENDING')='PENDING'
  AND NOT EXISTS (SELECT 1 FROM channel_review_decisions d WHERE d.channel_id=c.channel_id)
  AND c.trading_status NOT IN ('NON_TRADING','HUMAN_REJECTED')
  AND c.country_status <> 'REJECTED'
  AND latest.id IS NOT NULL
  AND (
    EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(COALESCE(c.trading_relevance_breakdown->'reasoning','[]'::jsonb)) reason
      WHERE reason ILIKE '%Degraded Providers: true%'
         OR reason ILIKE '%PROVIDER_COVERAGE_DEGRADED%'
         OR reason ILIKE '%PROVIDER_TIMEOUT%'
         OR reason ILIKE '%PROVIDER_RATE_LIMIT%'
         OR reason ILIKE '%PROVIDER_TRANSIENT_FAILURE%'
         OR reason ILIKE '%PROVIDER_CREDENTIALS_EXHAUSTED%'
         OR reason ILIKE '%PROVIDER_CANCELLED%'
         OR reason ILIKE '%PROVIDER_EXECUTION_FAILED%'
    )
    OR (
      latest.status='FAILED'
      AND (
        latest.last_error ILIKE '%quota%'
        OR latest.last_error ILIKE '%rate limit%'
        OR latest.last_error ILIKE '%timeout%'
        OR latest.last_error ILIKE '%timed out%'
        OR latest.last_error ILIKE '%transient%'
        OR latest.last_error ILIKE '%temporar%'
        OR latest.last_error ILIKE '%ECONN%'
        OR latest.last_error ILIKE '%EAI_AGAIN%'
        OR latest.last_error ILIKE '%provider%cool%'
      )
    )
  );

UPDATE channel_reviews r
SET state='SUPERSEDED',updated_at=now()
FROM recover_operational_enrichment_reviews recover
WHERE r.channel_id=recover.channel_id AND r.state='PENDING';

UPDATE channels c
SET trading_status='UNCERTAIN',scan_status='ENRICHMENT_PENDING',updated_at=now()
FROM recover_operational_enrichment_reviews recover
WHERE c.channel_id=recover.channel_id;

-- If the recovered job is owned by a resumable investigation, reopen the exact
-- step before the job becomes runnable. Otherwise startInvestigationStep() sees
-- the old COMPLETED/FAILED projection and safely-but-incorrectly skips the job.
UPDATE investigation_steps s
SET state='PENDING',attempt_count=0,worker_id=NULL,lease_expires_at=NULL,
    started_at=NULL,completed_at=NULL,resulting_status=NULL,output_checksum=NULL,
    failure_class=NULL,updated_at=now()
FROM recover_operational_enrichment_reviews recover
WHERE s.job_id=recover.job_id
  AND s.state IN ('COMPLETED','FAILED','SKIPPED','RETRYING','RUNNING');

-- Reopen only investigations that own one of those exact recovered jobs. Keep
-- current_step_id pointing at the same step so the existing workflow resumes it.
UPDATE investigations i
SET state='ACTIVE',completed_at=NULL,updated_at=now()
FROM investigation_steps s
JOIN recover_operational_enrichment_reviews recover ON recover.job_id=s.job_id
WHERE i.id=s.investigation_id
  AND i.state IN ('COMPLETED','NEEDS_REVIEW','FAILED');

UPDATE jobs j
SET status='PENDING',attempts=0,run_after=now(),locked_by=NULL,locked_at=NULL,
    last_error=NULL,completed_at=NULL,updated_at=now()
FROM recover_operational_enrichment_reviews recover
WHERE j.id=recover.job_id
  AND j.type='ENRICH_CHANNEL'
  AND j.status IN ('FAILED','COMPLETED','PENDING');
