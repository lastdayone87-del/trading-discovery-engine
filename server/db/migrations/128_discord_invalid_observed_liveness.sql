-- Additive fidelity fix: project INVALID_OBSERVED into candidate liveness.
-- Background: the validator distinguishes first-sight invalid (INVALID_OBSERVED,
-- retryable, needs a confirming observation) from confirmed invalid
-- (CONFIRMED_INVALID -> DEAD). The original projection kept the prior liveness
-- on every non-terminal outcome, so a candidate that once SUCCEEDED kept
-- liveness='ACTIVE' after an INVALID_OBSERVED observation. The candidate row
-- also carries candidate_status='VALIDATION_FAILED' so dashboard serving is
-- unaffected; this only corrects the liveness signal for future consumers.
-- Idempotent: CREATE OR REPLACE + DROP/CREATE trigger, and the backfill UPDATE
-- matches zero rows on re-run (liveness is no longer 'ACTIVE' afterwards).

CREATE OR REPLACE FUNCTION project_discord_candidate_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE projected_id TEXT := COALESCE(NEW.candidate_id,encode(digest(lower(NEW.invite_locator),'sha256'),'hex'));
BEGIN
  INSERT INTO discord_candidates(channel_id,candidate_id,raw_locator,normalized_locator,locator_type,source_surface,source_url)
  VALUES(NEW.channel_id,projected_id,COALESCE(NEW.raw_locator,NEW.invite_locator),lower(COALESCE(NEW.resolved_locator,NEW.invite_locator)),COALESCE(NEW.locator_type,'NATIVE_INVITE'),NEW.source_surface,NEW.source_url)
  ON CONFLICT(channel_id,normalized_locator) DO NOTHING;
  UPDATE discord_candidates SET validation_status=CASE WHEN NEW.operational_outcome IN('SUCCEEDED','CONFIRMED_INVALID') THEN 'COMPLETED' ELSE 'RETRY_PENDING' END,
    liveness_status=CASE WHEN NEW.operational_outcome='SUCCEEDED' THEN 'ACTIVE' WHEN NEW.operational_outcome='CONFIRMED_INVALID' THEN 'DEAD' WHEN NEW.operational_outcome='INVALID_OBSERVED' THEN 'INVALID_OBSERVED' ELSE liveness_status END,
    relevance_status=CASE WHEN NEW.operational_outcome='SUCCEEDED' AND NEW.semantic_status='NON_TRADING' THEN 'NON_TRADING' WHEN NEW.operational_outcome='SUCCEEDED' AND NEW.semantic_status IN('ACTIVE','ACTIVE_LOW_VOLUME') THEN 'TRADING_RELEVANT' WHEN NEW.operational_outcome='SUCCEEDED' THEN 'UNCERTAIN' ELSE relevance_status END,
    retryable=NEW.retryable,attempt_count=attempt_count+1,last_checked=NEW.checked_at,
    failure_reason=CASE WHEN NEW.operational_outcome='SUCCEEDED' THEN NULL ELSE NEW.reason END,
    candidate_status=CASE WHEN NEW.operational_outcome='SUCCEEDED' THEN 'VALIDATED' WHEN NEW.operational_outcome='CONFIRMED_INVALID' THEN 'INVALID' ELSE 'VALIDATION_FAILED' END
  WHERE channel_id=NEW.channel_id AND normalized_locator=lower(COALESCE(NEW.resolved_locator,NEW.invite_locator));
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS discord_candidate_attempt_projection ON discord_check_attempts;
CREATE TRIGGER discord_candidate_attempt_projection AFTER INSERT ON discord_check_attempts FOR EACH ROW EXECUTE FUNCTION project_discord_candidate_attempt();

-- Backfill: only rows whose *latest* attempt is INVALID_OBSERVED and whose
-- liveness still shows the stale pre-observation 'ACTIVE'. Rows whose latest
-- outcome is inconclusive (RATE_LIMITED, PROVIDER_FAILURE, ...) intentionally
-- keep last-known-good ACTIVE per the preservation policy. VALIDATED rows can
-- never match (predicate requires VALIDATION_FAILED).
UPDATE discord_candidates dc SET liveness_status='INVALID_OBSERVED'
WHERE dc.candidate_status='VALIDATION_FAILED'
  AND dc.validation_status='RETRY_PENDING'
  AND dc.liveness_status='ACTIVE'
  AND EXISTS (
    SELECT 1 FROM (
      SELECT DISTINCT ON (channel_id, lower(COALESCE(resolved_locator, invite_locator)))
        channel_id, lower(COALESCE(resolved_locator, invite_locator)) AS loc, operational_outcome
      FROM discord_check_attempts
      ORDER BY channel_id, lower(COALESCE(resolved_locator, invite_locator)), checked_at DESC
    ) latest
    WHERE latest.channel_id = dc.channel_id
      AND latest.loc = dc.normalized_locator
      AND latest.operational_outcome = 'INVALID_OBSERVED'
  );
