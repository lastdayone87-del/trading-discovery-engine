-- Migration 148: YouTube per-key daily cap — SHADOW accounting (inert).
--
-- Observational only. The guard flag `youtube_key_cap_shadow_enabled` is
-- operator-managed and ABSENT => OFF; this migration creates no app_settings
-- row and no hard-enforcement path. When enabled, hooks record in-flight
-- leases and WOULD_DEFER/WOULD_REJECT events for a projected 9,000-unit/day
-- per-key cap. They never block, defer, retry or alter official API traffic,
-- key configuration or provider dispatch. Hard enforcement remains gated on
-- explicit operator approval.
--
-- quota_day is TEXT for parity with youtube_key_quota_usage.quota_day.

CREATE TABLE IF NOT EXISTS youtube_key_cap_shadow_leases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quota_day TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL,
  reserved_units INTEGER NOT NULL CHECK (reserved_units > 0),
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE (quota_day, operation_id)
);

CREATE INDEX IF NOT EXISTS youtube_key_cap_shadow_leases_key_idx
  ON youtube_key_cap_shadow_leases (quota_day, key_fingerprint, expires_at);
CREATE INDEX IF NOT EXISTS youtube_key_cap_shadow_leases_expiry_idx
  ON youtube_key_cap_shadow_leases (expires_at);

CREATE TABLE IF NOT EXISTS youtube_key_cap_shadow_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quota_day TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('WOULD_DEFER', 'WOULD_REJECT')),
  projected_units INTEGER NOT NULL CHECK (projected_units >= 0),
  request_units INTEGER NOT NULL CHECK (request_units > 0),
  cap_units INTEGER NOT NULL CHECK (cap_units > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One observation per operation; retries never duplicate projections.
  UNIQUE (quota_day, operation_id)
);

CREATE INDEX IF NOT EXISTS youtube_key_cap_shadow_events_day_key_idx
  ON youtube_key_cap_shadow_events (quota_day, key_fingerprint, event);
CREATE INDEX IF NOT EXISTS youtube_key_cap_shadow_events_created_idx
  ON youtube_key_cap_shadow_events (created_at);

COMMENT ON TABLE youtube_key_cap_shadow_leases IS
  'In-flight YouTube per-key quota leases for shadow cap accounting. Inert unless youtube_key_cap_shadow_enabled=true; never blocks traffic.';
COMMENT ON TABLE youtube_key_cap_shadow_events IS
  'Projected WOULD_DEFER/WOULD_REJECT observations for a 9000-unit/day per-key YouTube cap. Observational only; no enforcement.';
