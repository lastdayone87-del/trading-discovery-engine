-- Migration 158: durable per-key YouTube cap-refusal accounting.
--
-- Cap refusals happen before provider dispatch, so they never reach
-- job_attempts and they disappear with the application log when Docker rotates
-- it. The monitor therefore saw zero refusals while the enforced path was
-- refusing thousands of dispatches per hour. These tables persist one row per
-- dispatch identity and one aggregate counter per (Pacific quota day, key), so
-- a monitor restart or a log rotation cannot lose or duplicate a refusal.
--
-- quota_day is TEXT for parity with youtube_key_quota_usage.quota_day. The
-- event row is the idempotency fence: a retry of the same operation_id never
-- increments the counter twice. The counter is the read model used by the
-- stop rule and is scoped to the Pacific day, so the reset boundary starts at
-- zero without any explicit truncation.

CREATE TABLE IF NOT EXISTS youtube_key_cap_refusal_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quota_day TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL,
  projected_units INTEGER NOT NULL CHECK (projected_units >= 0),
  request_units INTEGER NOT NULL CHECK (request_units > 0),
  cap_units INTEGER NOT NULL CHECK (cap_units > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One refusal observation per dispatch identity; retries never duplicate.
  UNIQUE (quota_day, operation_id)
);

CREATE INDEX IF NOT EXISTS youtube_key_cap_refusal_events_day_key_idx
  ON youtube_key_cap_refusal_events (quota_day, key_fingerprint);
CREATE INDEX IF NOT EXISTS youtube_key_cap_refusal_events_created_idx
  ON youtube_key_cap_refusal_events (created_at);

CREATE TABLE IF NOT EXISTS youtube_key_cap_refusal_counters (
  quota_day TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL,
  refusals BIGINT NOT NULL DEFAULT 0 CHECK (refusals >= 0),
  projected_units_max INTEGER NOT NULL DEFAULT 0 CHECK (projected_units_max >= 0),
  last_request_units INTEGER NOT NULL DEFAULT 0 CHECK (last_request_units >= 0),
  first_refused_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_refused_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (quota_day, key_fingerprint)
);

CREATE INDEX IF NOT EXISTS youtube_key_cap_refusal_counters_day_idx
  ON youtube_key_cap_refusal_counters (quota_day, last_refused_at DESC);

COMMENT ON TABLE youtube_key_cap_refusal_events IS
  'Idempotent per-dispatch YouTube per-key cap refusals. Durable across monitor restarts and application log rotation.';
COMMENT ON TABLE youtube_key_cap_refusal_counters IS
  'Aggregate YouTube per-key cap refusals by Pacific quota day. Read by the corrected stop-rule monitor.';
