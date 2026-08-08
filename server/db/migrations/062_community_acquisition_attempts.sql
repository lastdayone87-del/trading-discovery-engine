-- Phase A: immutable operational observations for community acquisition.
-- Existing channels.discord_status remains the compatibility projection; these
-- rows preserve why a projection was (or was not) changed.
CREATE TABLE IF NOT EXISTS discord_check_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_key TEXT NOT NULL UNIQUE,
  channel_id TEXT NOT NULL,
  invite_locator TEXT NOT NULL,
  semantic_status TEXT NOT NULL CHECK (semantic_status IN
    ('ACTIVE','ACTIVE_LOW_VOLUME','NON_TRADING','DEAD','UNCERTAIN')),
  operational_outcome TEXT NOT NULL CHECK (operational_outcome IN
    ('SUCCEEDED','CONFIRMED_INVALID','RATE_LIMITED','TIMEOUT','NETWORK_FAILURE',
     'AUTHENTICATION_FAILURE','PROVIDER_FAILURE','MALFORMED_RESPONSE','INVALID_LOCATOR')),
  retryable BOOLEAN NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  http_status INTEGER,
  provider_error_class TEXT,
  reason TEXT NOT NULL,
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  policy_version TEXT NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(provenance)='object')
);
CREATE INDEX IF NOT EXISTS idx_discord_check_attempts_channel_time
  ON discord_check_attempts(channel_id,checked_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS external_acquisition_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_key TEXT NOT NULL UNIQUE,
  channel_id TEXT NOT NULL,
  requested_url TEXT NOT NULL,
  final_url TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN
    ('FOUND','INSPECTED_NO_MATCH','PARTIALLY_INSPECTED','ACQUISITION_FAILED')),
  retryable BOOLEAN NOT NULL,
  http_status INTEGER,
  failure_class TEXT,
  detail TEXT NOT NULL,
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  policy_version TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(provenance)='object')
);
CREATE INDEX IF NOT EXISTS idx_external_acquisition_channel_time
  ON external_acquisition_observations(channel_id,observed_at DESC,id DESC);

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['discord_check_attempts','external_acquisition_observations'] LOOP
    EXECUTE format('CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation()',t,t);
  END LOOP;
END $$;

COMMENT ON TABLE discord_check_attempts IS 'Append-only Discord semantic and operational check outcomes; failures never imply DEAD.';
COMMENT ON TABLE external_acquisition_observations IS 'Append-only per-URL acquisition outcomes; failed acquisition is distinct from inspected-no-match.';
