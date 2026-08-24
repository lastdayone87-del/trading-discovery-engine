-- Historical projection repair only. This does not reopen jobs, change retry
-- budgets, alter scan status, or modify semantic/human terminal decisions.
CREATE TABLE IF NOT EXISTS community_retry_projection_reconciliation_events (
  event_key TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  prior_validation_status TEXT NOT NULL,
  resulting_validation_status TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS community_retry_projection_reconciliation_channel_idx
  ON community_retry_projection_reconciliation_events(channel_id, created_at DESC);

CREATE TEMP TABLE _terminal_community_retry_projection_reconciliation ON COMMIT DROP AS
WITH latest_retry AS (
  SELECT DISTINCT ON (j.payload->>'channelId')
    j.payload->>'channelId' AS channel_id,
    j.id::text AS job_id,
    j.status,
    j.last_error
  FROM jobs j
  WHERE j.type='RETRY_COMMUNITY_ACQUISITION'
  ORDER BY j.payload->>'channelId', j.updated_at DESC NULLS LAST, j.created_at DESC NULLS LAST, j.id DESC
)
SELECT
  c.channel_id,
  latest_retry.job_id,
  c.scan_status AS prior_scan_status,
  c.discord_validation_status AS prior_validation_status,
  'FAILED_OPERATIONAL'::text AS resulting_validation_status
FROM channels c
JOIN latest_retry ON latest_retry.channel_id=c.channel_id
WHERE latest_retry.status='FAILED'
  AND c.scan_status IN ('FAILED','FAILED_PERMANENT')
  AND c.discord_validation_status='RETRY_PENDING'
  AND c.country_status <> 'REJECTED'
  AND c.trading_status NOT IN ('NON_TRADING','HUMAN_REJECTED')
  AND NOT EXISTS (
    SELECT 1 FROM jobs active_job
    WHERE active_job.type='RETRY_COMMUNITY_ACQUISITION'
      AND active_job.status IN ('PENDING','PROCESSING')
      AND active_job.payload->>'channelId'=c.channel_id
  );

UPDATE channels c
SET discord_validation_status=reconcile.resulting_validation_status,
    updated_at=now()
FROM _terminal_community_retry_projection_reconciliation reconcile
WHERE c.channel_id=reconcile.channel_id
  AND c.discord_validation_status=reconcile.prior_validation_status;

INSERT INTO community_retry_projection_reconciliation_events(
  event_key, channel_id, job_id, prior_validation_status,
  resulting_validation_status, policy_version
)
SELECT
  'community-retry-projection:'||reconcile.job_id,
  reconcile.channel_id,
  reconcile.job_id,
  reconcile.prior_validation_status,
  reconcile.resulting_validation_status,
  'community-retry-terminal-projection-v1'
FROM _terminal_community_retry_projection_reconciliation reconcile
ON CONFLICT(event_key) DO NOTHING;
