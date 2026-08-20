CREATE TABLE IF NOT EXISTS discord_candidates (
  channel_id TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  candidate_id TEXT NOT NULL,
  raw_locator TEXT NOT NULL,
  normalized_locator TEXT NOT NULL,
  locator_type TEXT NOT NULL,
  source_surface TEXT,
  source_url TEXT,
  candidate_status TEXT NOT NULL DEFAULT 'DISCOVERED',
  validation_status TEXT NOT NULL DEFAULT 'NOT_STARTED',
  liveness_status TEXT NOT NULL DEFAULT 'NOT_CHECKED',
  relevance_status TEXT NOT NULL DEFAULT 'NOT_CHECKED',
  retryable BOOLEAN NOT NULL DEFAULT true,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_checked TIMESTAMPTZ,
  failure_reason TEXT,
  selected BOOLEAN NOT NULL DEFAULT false,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(channel_id,candidate_id),
  UNIQUE(channel_id,normalized_locator)
);
INSERT INTO discord_candidates(channel_id,candidate_id,raw_locator,normalized_locator,locator_type,source_surface,source_url,candidate_status,validation_status,liveness_status,retryable,attempt_count,last_checked,failure_reason,selected)
SELECT latest.channel_id,latest.projected_id,latest.raw_locator,latest.normalized_locator,latest.locator_type,latest.source_surface,latest.source_url,
  CASE WHEN latest.operational_outcome='SUCCEEDED' THEN 'VALIDATED' WHEN latest.operational_outcome='CONFIRMED_INVALID' THEN 'INVALID' ELSE 'VALIDATION_FAILED' END,
  CASE WHEN latest.operational_outcome IN('SUCCEEDED','CONFIRMED_INVALID') THEN 'COMPLETED' ELSE 'RETRY_PENDING' END,
  CASE WHEN latest.operational_outcome='SUCCEEDED' THEN 'ACTIVE' WHEN latest.operational_outcome='CONFIRMED_INVALID' THEN 'DEAD' ELSE 'NOT_CHECKED' END,
  latest.retryable,latest.attempt_count,latest.checked_at,CASE WHEN latest.operational_outcome='SUCCEEDED' THEN NULL ELSE latest.reason END,
  EXISTS(SELECT 1 FROM channels c WHERE c.channel_id=latest.channel_id AND c.discord_candidate_id=latest.projected_id)
FROM (SELECT DISTINCT ON(channel_id,COALESCE(candidate_id,encode(digest(lower(invite_locator),'sha256'),'hex')))
  channel_id,COALESCE(candidate_id,encode(digest(lower(invite_locator),'sha256'),'hex')) projected_id,COALESCE(raw_locator,invite_locator) raw_locator,
  COALESCE(resolved_locator,invite_locator) normalized_locator,COALESCE(locator_type,'NATIVE_INVITE') locator_type,source_surface,source_url,operational_outcome,retryable,checked_at,reason,
  COUNT(*) OVER(PARTITION BY channel_id,COALESCE(candidate_id,encode(digest(lower(invite_locator),'sha256'),'hex')))::int attempt_count
  FROM discord_check_attempts ORDER BY channel_id,COALESCE(candidate_id,encode(digest(lower(invite_locator),'sha256'),'hex')),checked_at DESC) latest
ON CONFLICT(channel_id,candidate_id) DO NOTHING;
CREATE INDEX IF NOT EXISTS idx_discord_candidates_channel ON discord_candidates(channel_id,selected DESC,last_checked DESC);

CREATE OR REPLACE FUNCTION project_discord_candidate_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE projected_id TEXT := COALESCE(NEW.candidate_id,encode(digest(lower(NEW.invite_locator),'sha256'),'hex'));
BEGIN
  INSERT INTO discord_candidates(channel_id,candidate_id,raw_locator,normalized_locator,locator_type,source_surface,source_url)
  VALUES(NEW.channel_id,projected_id,COALESCE(NEW.raw_locator,NEW.invite_locator),COALESCE(NEW.resolved_locator,NEW.invite_locator),COALESCE(NEW.locator_type,'NATIVE_INVITE'),NEW.source_surface,NEW.source_url)
  ON CONFLICT(channel_id,candidate_id) DO NOTHING;
  UPDATE discord_candidates SET validation_status=CASE WHEN NEW.operational_outcome IN('SUCCEEDED','CONFIRMED_INVALID') THEN 'COMPLETED' ELSE 'RETRY_PENDING' END,
    liveness_status=CASE WHEN NEW.operational_outcome='SUCCEEDED' THEN 'ACTIVE' WHEN NEW.operational_outcome='CONFIRMED_INVALID' THEN 'DEAD' ELSE liveness_status END,
    retryable=NEW.retryable,attempt_count=attempt_count+1,last_checked=NEW.checked_at,
    failure_reason=CASE WHEN NEW.operational_outcome='SUCCEEDED' THEN NULL ELSE NEW.reason END,
    candidate_status=CASE WHEN NEW.operational_outcome='SUCCEEDED' THEN 'VALIDATED' WHEN NEW.operational_outcome='CONFIRMED_INVALID' THEN 'INVALID' ELSE 'VALIDATION_FAILED' END
  WHERE channel_id=NEW.channel_id AND candidate_id=projected_id;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS discord_candidate_attempt_projection ON discord_check_attempts;
CREATE TRIGGER discord_candidate_attempt_projection AFTER INSERT ON discord_check_attempts FOR EACH ROW EXECUTE FUNCTION project_discord_candidate_attempt();
