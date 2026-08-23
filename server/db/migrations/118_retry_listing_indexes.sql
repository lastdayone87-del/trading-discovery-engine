-- Support Channels Table retry-observability projections added in PR #357.
-- The listing resolves the latest RETRY_COMMUNITY_ACQUISITION job by channel
-- and then aggregates/reads that job's append-only attempt history. Keep these
-- lookups index-backed so dashboard pagination does not devolve into repeated
-- jobs/job_attempts scans as production history grows.

CREATE INDEX IF NOT EXISTS idx_jobs_retry_community_channel_created
  ON jobs ((payload->>'channelId'), created_at DESC)
  WHERE type = 'RETRY_COMMUNITY_ACQUISITION';

CREATE INDEX IF NOT EXISTS idx_job_attempts_job_started
  ON job_attempts (job_id, started_at DESC);
