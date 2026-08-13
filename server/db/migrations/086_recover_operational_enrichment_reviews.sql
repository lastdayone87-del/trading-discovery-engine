-- Recover only automated NEEDS_REVIEW rows whose current classification or
-- latest enrichment outcome is operationally degraded. Historical failures are
-- deliberately ignored when a newer enrichment outcome exists.

-- Recovery generations preserve the immutable event ledger when an historical
-- investigation step is deliberately executed again. Existing generations are
-- zero; only the exact recovered step/investigation is incremented below.
ALTER TABLE investigation_steps
  ADD COLUMN IF NOT EXISTS recovery_generation INTEGER NOT NULL DEFAULT 0
  CHECK (recovery_generation >= 0);
ALTER TABLE investigations
  ADD COLUMN IF NOT EXISTS recovery_generation INTEGER NOT NULL DEFAULT 0
  CHECK (recovery_generation >= 0);

-- Runtime workflow event keys predate recovery generations. Namespace events for
-- recovered steps/investigations at INSERT time so old immutable keys remain
-- untouched and a recovered execution cannot disappear via ON CONFLICT DO NOTHING.
CREATE OR REPLACE FUNCTION namespace_recovered_investigation_event_key()
RETURNS TRIGGER AS $$
DECLARE
  generation INTEGER := 0;
BEGIN
  IF NEW.step_id IS NOT NULL THEN
    SELECT recovery_generation INTO generation
    FROM investigation_steps
    WHERE id=NEW.step_id;
  ELSE
    SELECT recovery_generation INTO generation
    FROM investigations
    WHERE id=NEW.investigation_id;
  END IF;

  IF COALESCE(generation,0) > 0 THEN
    NEW.event_key := NEW.event_key || ':recovery:' || generation::text;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS investigation_events_recovery_namespace ON investigation_events;
CREATE TRIGGER investigation_events_recovery_namespace
BEFORE INSERT ON investigation_events
FOR EACH ROW EXECUTE FUNCTION namespace_recovered_investigation_event_key();

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
-- step before the job becomes runnable. Increment recovery_generation first so
-- all subsequent workflow events for this execution receive a fresh identity.
UPDATE investigation_steps s
SET state='PENDING',attempt_count=0,worker_id=NULL,lease_expires_at=NULL,
    started_at=NULL,completed_at=NULL,resulting_status=NULL,output_checksum=NULL,
    failure_class=NULL,recovery_generation=recovery_generation+1,updated_at=now()
FROM recover_operational_enrichment_reviews recover
WHERE s.job_id=recover.job_id
  AND s.state IN ('COMPLETED','FAILED','SKIPPED','RETRYING','RUNNING');

-- Reopen only investigations owning those exact recovered steps. Refresh the
-- deadline from the existing investigation_deadline_minutes policy (30 minutes
-- if the setting is absent/malformed/out of INTEGER range), and align the
-- investigation generation with the recovered step so terminal events are
-- namespaced too. ACTIVE owners are included because stale RUNNING/RETRYING
-- steps can legitimately still belong to an ACTIVE investigation with an expired
-- original deadline. Bound digit text before any numeric cast so arbitrary TEXT
-- cannot overflow PostgreSQL numeric types during this transactional migration.
UPDATE investigations i
SET state='ACTIVE',
    completed_at=NULL,
    deadline_at=now()+(
      COALESCE(
        (SELECT CASE
           WHEN setting_value ~ '^[0-9]+$'
             AND length(setting_value) BETWEEN 1 AND 10
             AND (length(setting_value) < 10 OR setting_value <= '2147483647')
             THEN CASE
               WHEN setting_value::INTEGER > 0 THEN setting_value::INTEGER
               ELSE NULL
             END
           ELSE NULL
         END
         FROM app_settings
         WHERE setting_key='investigation_deadline_minutes'
         LIMIT 1),
        30
      )::text || ' minutes'
    )::interval,
    recovery_generation=recovered.max_generation,
    updated_at=now()
FROM (
  SELECT s.investigation_id,MAX(s.recovery_generation) AS max_generation
  FROM investigation_steps s
  JOIN recover_operational_enrichment_reviews recover ON recover.job_id=s.job_id
  GROUP BY s.investigation_id
) recovered
WHERE i.id=recovered.investigation_id
  AND i.state IN ('ACTIVE','COMPLETED','NEEDS_REVIEW','FAILED');

-- Record the recovery itself as immutable history. The trigger above appends the
-- current recovery generation, making this key distinct from any previous run.
INSERT INTO investigation_events(
  event_key,investigation_id,step_id,event_type,payload,policy_version
)
SELECT
  'investigation:'||s.investigation_id::text||':step:'||s.id::text||':recovered',
  s.investigation_id,
  s.id,
  'INVESTIGATION_RECOVERED',
  jsonb_build_object('jobId',s.job_id,'recoveryGeneration',s.recovery_generation),
  s.policy_version
FROM investigation_steps s
JOIN recover_operational_enrichment_reviews recover ON recover.job_id=s.job_id
WHERE s.recovery_generation > 0
ON CONFLICT(event_key) DO NOTHING;

UPDATE jobs j
SET status='PENDING',attempts=0,run_after=now(),locked_by=NULL,locked_at=NULL,
    last_error=NULL,completed_at=NULL,updated_at=now()
FROM recover_operational_enrichment_reviews recover
WHERE j.id=recover.job_id
  AND j.type='ENRICH_CHANNEL'
  AND j.status IN ('FAILED','COMPLETED','PENDING');
