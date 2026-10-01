-- Migration 132: durable YouTube key-health telemetry (non-destructive).
--
-- Two additive tables, no changes to existing tables:
--
-- 1. youtube_invalid_input_quarantine remembers inputs that recently
--    produced HTTP 400/404/422 from the YouTube Data API (bad channel IDs,
--    invalid query shapes) so the provider layer stops re-issuing them on
--    every rescan. Rows expire via expires_at; readers must ignore expired
--    rows and writers prune them opportunistically. Raw channel IDs are not
--    secrets; search queries are stored as hashes (see input_value note).
--
-- 2. youtube_provider_suspension persists CONSUMER_SUSPENDED / dead-key
--    quarantine durably by key fingerprint (never the key itself) so a
--    Railway restart or redeploy cannot cause already-dead keys to be
--    reprobed. The in-memory cooldown remains the hot-path authority;
--    this table is hydrated once at startup and maintained on transitions.
--
-- Operational safety: CREATE TABLE IF NOT EXISTS only, no backfills,
-- no constraint validation, safe inside the single-transaction runner.

CREATE TABLE IF NOT EXISTS youtube_invalid_input_quarantine (
  input_kind TEXT NOT NULL,
  input_value TEXT NOT NULL,
  operation TEXT NOT NULL DEFAULT '',
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  hits INTEGER NOT NULL DEFAULT 1,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (input_kind, input_value)
);

CREATE TABLE IF NOT EXISTS youtube_provider_suspension (
  key_fingerprint TEXT PRIMARY KEY,
  key_index INTEGER NOT NULL DEFAULT 0,
  env_name TEXT NOT NULL DEFAULT '',
  quota_group TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'SUSPENDED',
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retry_after TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason TEXT NOT NULL DEFAULT '',
  probe_count INTEGER NOT NULL DEFAULT 0
);
