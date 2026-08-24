-- Separate the retryable-infrastructure age budget from immutable job creation
-- provenance. The runtime starts this clock only when the job actually sees its
-- first retryable provider/infrastructure failure.
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS first_transient_failure_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS jobs_transient_retry_age_idx
  ON jobs(first_transient_failure_at)
  WHERE status IN ('PENDING','PROCESSING') AND first_transient_failure_at IS NOT NULL;

-- Historical repair is intentionally causal and narrow. Under the old runtime,
-- jobs.created_at was passed to decideJobFailure as if it were the first failure
-- time. A job older than the retry-age window could therefore receive the
-- OPERATIONALLY_BLOCKED_RETRY_REQUIRED terminal marker on its very first claim.
-- Exactly one durable job_attempt row proves there was no earlier execution of
-- that job. Rows with more history are left untouched because causality cannot
-- be proven from the durable state.
CREATE TEMP TABLE recover_first_attempt_transient_age_false_terminals ON COMMIT DROP AS
WITH attempt_counts AS (
  SELECT job_id, COUNT(*)::integer AS attempt_rows
  FROM job_attempts
  GROUP BY job_id
)
SELECT
  j.id AS job_id,
  j.payload->>'channelId' AS channel_id,
  s.id AS step_id,
  s.investigation_id,
  a.attempt_rows
FROM jobs j
JOIN channels c ON c.channel_id=j.payload->>'channelId'
JOIN attempt_counts a ON a.job_id=j.id
LEFT JOIN investigation_steps s ON s.job_id=j.id
WHERE j.type='ENRICH_CHANNEL'
  AND j.status='FAILED'
  AND j.attempts=1
  AND a.attempt_rows = 1
  AND j.last_error LIKE 'OPERATIONALLY_BLOCKED_RETRY_REQUIRED:%'
  AND c.scan_status='FAILED'
  AND c.trading_status='UNCERTAIN'
  AND c.country_status <> 'REJECTED';

-- Reopen the exact resumable step when the failed job belongs to one. Recovery
-- generation preserves immutable event identity for the new execution.
UPDATE investigation_steps s
SET state='PENDING',
    attempt_count=0,
    worker_id=NULL,
    lease_expires_at=NULL,
    started_at=NULL,
    completed_at=NULL,
    resulting_status=NULL,
    output_checksum=NULL,
    failure_class=NULL,
    recovery_generation=recovery_generation+1,
    updated_at=now()
FROM recover_first_attempt_transient_age_false_terminals recover
WHERE recover.step_id=s.id
  AND s.state='FAILED';

-- Reopen only the investigation owning the exact recovered step. Refresh its
-- deadline from the existing policy with the same safe integer parsing used by
-- the workflow recovery path.
UPDATE investigations i
SET state='ACTIVE',
    current_step_id=recover.step_id,
    completed_at=NULL,
    deadline_at=now()+(
      COALESCE(
        (SELECT CASE
           WHEN normalized_value <> '0'
             AND length(normalized_value) BETWEEN 1 AND 10
             AND (length(normalized_value) < 10 OR normalized_value <= '2147483647')
             THEN normalized_value::INTEGER
           ELSE NULL
         END
         FROM (
           SELECT CASE
             WHEN setting_value ~ '^[0-9]+$'
               THEN COALESCE(NULLIF(regexp_replace(setting_value,'^0+','','g'),''),'0')
             ELSE '0'
           END AS normalized_value
           FROM app_settings
           WHERE setting_key='investigation_deadline_minutes'
           LIMIT 1
         ) setting
        ),
        30
      )::text || ' minutes'
    )::interval,
    recovery_generation=GREATEST(i.recovery_generation,s.recovery_generation),
    updated_at=now()
FROM recover_first_attempt_transient_age_false_terminals recover
JOIN investigation_steps s ON s.id=recover.step_id
WHERE i.id=recover.investigation_id
  AND i.state='OPERATIONALLY_BLOCKED';

INSERT INTO investigation_events(
  event_key,investigation_id,step_id,event_type,payload,policy_version
)
SELECT
  'investigation:'||s.investigation_id::text||':step:'||s.id::text||':transient-age-anchor-recovered',
  s.investigation_id,
  s.id,
  'INVESTIGATION_RECOVERED',
  jsonb_build_object(
    'jobId',s.job_id,
    'reason','JOB_CREATED_AT_WAS_USED_AS_FIRST_TRANSIENT_FAILURE_AT',
    'recoveryGeneration',s.recovery_generation
  ),
  s.policy_version
FROM investigation_steps s
JOIN recover_first_attempt_transient_age_false_terminals recover ON recover.step_id=s.id
WHERE s.recovery_generation > 0
ON CONFLICT(event_key) DO NOTHING;

-- Restore only the operational projection. Semantic terminal decisions are
-- excluded by the candidate selection above.
UPDATE channels c
SET scan_status='ENRICHMENT_PENDING',
    last_checked=now(),
    updated_at=now()
FROM recover_first_attempt_transient_age_false_terminals recover
WHERE c.channel_id=recover.channel_id
  AND c.scan_status='FAILED'
  AND c.trading_status='UNCERTAIN'
  AND c.country_status <> 'REJECTED';

-- Start a fresh transient-failure window on the next actual infrastructure
-- failure. Do not rewrite created_at: it remains creation provenance.
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
FROM recover_first_attempt_transient_age_false_terminals recover
WHERE j.id=recover.job_id;
