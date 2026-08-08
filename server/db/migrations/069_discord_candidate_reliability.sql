-- Additive, backward-compatible Discord state separation. Existing rows remain
-- NOT_CHECKED/NOT_STARTED and are never inferred into stronger liveness states.
ALTER TABLE channels ADD COLUMN IF NOT EXISTS discord_resolution_status TEXT NOT NULL DEFAULT 'NOT_ATTEMPTED'
  CHECK(discord_resolution_status IN('NOT_ATTEMPTED','RESOLVED','UNRESOLVED'));
ALTER TABLE channels ADD COLUMN IF NOT EXISTS discord_liveness_status TEXT NOT NULL DEFAULT 'NOT_CHECKED'
  CHECK(discord_liveness_status IN('NOT_CHECKED','ACTIVE','INVALID_OBSERVED','DEAD','UNCERTAIN'));
ALTER TABLE channels ADD COLUMN IF NOT EXISTS discord_relevance_status TEXT NOT NULL DEFAULT 'NOT_CHECKED'
  CHECK(discord_relevance_status IN('NOT_CHECKED','TRADING_RELEVANT','NON_TRADING','UNCERTAIN'));
ALTER TABLE channels ADD COLUMN IF NOT EXISTS discord_validation_status TEXT NOT NULL DEFAULT 'NOT_STARTED'
  CHECK(discord_validation_status IN('NOT_STARTED','RETRY_PENDING','SUCCEEDED','FAILED_OPERATIONAL','COMPLETED'));
ALTER TABLE channels ADD COLUMN IF NOT EXISTS discord_candidate_id TEXT;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS discord_candidate_raw_locator TEXT;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS discord_candidate_type TEXT;

ALTER TABLE discord_check_attempts ADD COLUMN IF NOT EXISTS candidate_id TEXT;
ALTER TABLE discord_check_attempts ADD COLUMN IF NOT EXISTS raw_locator TEXT;
ALTER TABLE discord_check_attempts ADD COLUMN IF NOT EXISTS locator_type TEXT;
ALTER TABLE discord_check_attempts ADD COLUMN IF NOT EXISTS resolved_locator TEXT;
ALTER TABLE discord_check_attempts ADD COLUMN IF NOT EXISTS source_surface TEXT;
ALTER TABLE discord_check_attempts ADD COLUMN IF NOT EXISTS source_url TEXT;
ALTER TABLE discord_check_attempts ADD COLUMN IF NOT EXISTS response_content_type TEXT;
ALTER TABLE discord_check_attempts ADD COLUMN IF NOT EXISTS provider_error_code INTEGER;
CREATE INDEX IF NOT EXISTS idx_discord_attempt_candidate_time ON discord_check_attempts(channel_id,candidate_id,checked_at DESC);
ALTER TABLE discord_check_attempts DROP CONSTRAINT IF EXISTS discord_check_attempts_operational_outcome_check;
ALTER TABLE discord_check_attempts ADD CONSTRAINT discord_check_attempts_operational_outcome_check CHECK(operational_outcome IN
  ('SUCCEEDED','INVALID_OBSERVED','CONFIRMED_INVALID','RATE_LIMITED','TIMEOUT','NETWORK_FAILURE','AUTHENTICATION_FAILURE','PROVIDER_FAILURE','MALFORMED_RESPONSE','INVALID_LOCATOR'));
