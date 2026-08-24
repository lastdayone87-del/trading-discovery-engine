-- Reconcile legacy operational ENRICH_CHANNEL failures that predate the
-- investigation workflow. This is intentionally narrow: semantic/human
-- decisions, completed Discord outcomes, active owners, and stale completed
-- enrichment jobs are excluded.
CREATE TABLE IF NOT EXISTS operational_enrichment_recovery_events (
  event_key TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  prior_scan_status TEXT NOT NULL,
  reason_codes JSONB NOT NULL,
  policy_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS operational_enrichment_recovery_events_channel_idx
  ON operational_enrichment_recovery_events(channel_id, created_at DESC);

CREATE TEMP TABLE recover_operational_enrichment_failures ON COMMIT DROP AS
WITH latest_relevant_job AS (
  SELECT
    c.channel_id,
    c.scan_status AS prior_scan_status,
    j.id::text AS job_id,
    j.updated_at,
    j.last_error,
    ROW_NUMBER() OVER (
      PARTITION BY c.channel_id
      ORDER BY j.updated_at DESC NULLS LAST, j.created_at DESC NULLS LAST, j.id DESC
    ) AS rn
  FROM channels c
  JOIN jobs j ON j.payload->>'channelId'=c.channel_id
  WHERE c.scan_status IN ('FAILED','FAILED_PERMANENT')
    AND j.type IN ('ENRICH_CHANNEL','POST_APPROVAL_ENRICH','FORCE_REVIEW_RESCAN','RETRY_COMMUNITY_ACQUISITION')
)
SELECT
  channel_id,
  prior_scan_status,
  job_id,
  'OPERATIONALLY_BLOCKED_ENRICHMENT_FAILURE'::text AS reason_code
FROM latest_relevant_job
WHERE rn=1
  AND last_error ILIKE 'OPERATIONALLY_BLOCKED_RETRY_REQUIRED:%'
  AND EXISTS (
    SELECT 1 FROM jobs failed_job
    WHERE failed_job.id::text=latest_relevant_job.job_id
      AND failed_job.type='ENRICH_CHANNEL'
      AND failed_job.status='FAILED'
  )
  AND EXISTS (
    SELECT 1 FROM channels c
    WHERE c.channel_id=latest_relevant_job.channel_id
      AND c.trading_status='UNCERTAIN'
      AND COALESCE(c.discord_validation_status,'NOT_STARTED')<>'COMPLETED'
      AND COALESCE(c.country_status,'')<>'REJECTED'
      AND (c.last_checked IS NULL OR c.last_checked < now()-interval '24 hours')
  )
  AND NOT EXISTS (
    SELECT 1 FROM jobs active_job
    WHERE active_job.type IN ('ENRICH_CHANNEL','POST_APPROVAL_ENRICH','FORCE_REVIEW_RESCAN','RETRY_COMMUNITY_ACQUISITION')
      AND active_job.status IN ('PENDING','PROCESSING')
      AND active_job.payload->>'channelId'=latest_relevant_job.channel_id
  );

-- The channel projection is updated before the job becomes visible as PENDING;
-- the migration runner wraps this file in one transaction.
UPDATE channels c
SET scan_status='ENRICHMENT_PENDING',
    last_checked=now(),
    inspection_trail=COALESCE(c.inspection_trail,'[]'::jsonb)||jsonb_build_array(jsonb_build_object(
      'step','ENRICHMENT_RECOVERY',
      'title','Operational Enrichment Recovery Reopened',
      'status','FOUND',
      'details','Reopened from a recoverable legacy operational enrichment failure.',
      'timestamp',now()
    )),
    updated_at=now()
FROM recover_operational_enrichment_failures recover
WHERE c.channel_id=recover.channel_id
  AND c.scan_status=recover.prior_scan_status;

INSERT INTO operational_enrichment_recovery_events(
  event_key,channel_id,job_id,prior_scan_status,reason_codes,policy_version
)
SELECT
  'operational-enrichment:'||recover.job_id,
  recover.channel_id,
  recover.job_id,
  recover.prior_scan_status,
  jsonb_build_array(recover.reason_code,'OPERATIONAL_RECOVERY_COOLDOWN_EXPIRED'),
  'operational-enrichment-recovery-v1'
FROM recover_operational_enrichment_failures recover
ON CONFLICT(event_key) DO NOTHING;

UPDATE jobs j
SET status='PENDING',
    attempts=0,
    run_after=now(),
    locked_by=NULL,
    locked_at=NULL,
    last_error=NULL,
    completed_at=NULL,
    first_transient_failure_at=NULL,
    updated_at=now()
FROM recover_operational_enrichment_failures recover
WHERE j.id::text=recover.job_id
  AND j.status='FAILED';
