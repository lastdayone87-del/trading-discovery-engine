-- Migration 152: record the first successful validation of each Discord
-- candidate. Discovery time is not confirmation time: discord_candidates.
-- discovered_at records when a locator was first seen, while the append-only
-- discord_check_attempts ledger records when the provider actually confirmed
-- it. Backfill only from operational_outcome='SUCCEEDED' rows; a candidate
-- with no successful attempt keeps first_validated_at NULL rather than
-- receiving a synthetic date.
--
-- This migration is additive. It does not infer success from discovery,
-- channel first_seen, enrichment time, or the invite registry.
ALTER TABLE discord_candidates ADD COLUMN IF NOT EXISTS first_validated_at TIMESTAMPTZ;

WITH successful_validation AS (
  SELECT channel_id,
         lower(COALESCE(resolved_locator, invite_locator)) AS normalized_locator,
         MIN(checked_at) AS first_validated_at
    FROM discord_check_attempts
   WHERE operational_outcome='SUCCEEDED'
   GROUP BY channel_id, lower(COALESCE(resolved_locator, invite_locator))
)
UPDATE discord_candidates dc
   SET first_validated_at=LEAST(COALESCE(dc.first_validated_at, successful_validation.first_validated_at), successful_validation.first_validated_at)
  FROM successful_validation
 WHERE dc.channel_id=successful_validation.channel_id
   AND dc.normalized_locator=successful_validation.normalized_locator
   AND (dc.first_validated_at IS NULL OR dc.first_validated_at > successful_validation.first_validated_at);

-- The attempt projection is the write path for new confirmations. Keep the
-- existing projection semantics and stamp only the earliest successful
-- checked_at. LEAST also repairs a late-arriving earlier attempt without ever
-- overwriting a genuinely earlier confirmation with a later one.
CREATE OR REPLACE FUNCTION project_discord_candidate_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE projected_id TEXT := COALESCE(NEW.candidate_id,encode(digest(lower(NEW.invite_locator),'sha256'),'hex'));
BEGIN
  INSERT INTO discord_candidates(channel_id,candidate_id,raw_locator,normalized_locator,locator_type,source_surface,source_url)
  VALUES(NEW.channel_id,projected_id,COALESCE(NEW.raw_locator,NEW.invite_locator),lower(COALESCE(NEW.resolved_locator,NEW.invite_locator)),COALESCE(NEW.locator_type,'NATIVE_INVITE'),NEW.source_surface,NEW.source_url)
  ON CONFLICT(channel_id,normalized_locator) DO NOTHING;
  UPDATE discord_candidates SET validation_status=CASE WHEN NEW.operational_outcome IN('SUCCEEDED','CONFIRMED_INVALID') THEN 'COMPLETED' ELSE 'RETRY_PENDING' END,
    liveness_status=CASE WHEN NEW.operational_outcome='SUCCEEDED' THEN 'ACTIVE' WHEN NEW.operational_outcome='CONFIRMED_INVALID' THEN 'DEAD' ELSE liveness_status END,
    relevance_status=CASE WHEN NEW.operational_outcome='SUCCEEDED' AND NEW.semantic_status='NON_TRADING' THEN 'NON_TRADING' WHEN NEW.operational_outcome='SUCCEEDED' AND NEW.semantic_status IN('ACTIVE','ACTIVE_LOW_VOLUME') THEN 'TRADING_RELEVANT' WHEN NEW.operational_outcome='SUCCEEDED' THEN 'UNCERTAIN' ELSE relevance_status END,
    retryable=NEW.retryable,attempt_count=attempt_count+1,last_checked=NEW.checked_at,
    failure_reason=CASE WHEN NEW.operational_outcome='SUCCEEDED' THEN NULL ELSE NEW.reason END,
    first_validated_at=CASE WHEN NEW.operational_outcome='SUCCEEDED' THEN LEAST(COALESCE(first_validated_at,NEW.checked_at),NEW.checked_at) ELSE first_validated_at END,
    candidate_status=CASE WHEN NEW.operational_outcome='SUCCEEDED' THEN 'VALIDATED' WHEN NEW.operational_outcome='CONFIRMED_INVALID' THEN 'INVALID' ELSE 'VALIDATION_FAILED' END
  WHERE channel_id=NEW.channel_id AND normalized_locator=lower(COALESCE(NEW.resolved_locator,NEW.invite_locator));
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS discord_candidate_attempt_projection ON discord_check_attempts;
CREATE TRIGGER discord_candidate_attempt_projection AFTER INSERT ON discord_check_attempts FOR EACH ROW EXECUTE FUNCTION project_discord_candidate_attempt();

COMMENT ON COLUMN discord_candidates.first_validated_at IS 'Earliest discord_check_attempts.checked_at with operational_outcome=SUCCEEDED for this channel/locator; NULL when no trustworthy successful validation exists.';
