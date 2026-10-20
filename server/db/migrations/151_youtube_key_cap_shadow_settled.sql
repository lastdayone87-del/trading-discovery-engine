-- Migration 151: settlement fence for shadow-only YouTube cap observations.
--
-- A provider response can settle its official quota charge before the optional
-- shadow observation has finished (or after it has been cancelled by the
-- caller's small observation budget). This table records the exact settled
-- operation so a late observation cannot recreate an in-flight lease or write
-- a false WOULD_DEFER/WOULD_REJECT event.
--
-- Rows are inert tombstones: they hold no reserved units and are excluded from
-- every projection. The sweep removes them after expiry. Additive-only, safe
-- inside the single-transaction migration runner.

CREATE TABLE IF NOT EXISTS youtube_key_cap_shadow_settled (
  quota_day TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL,
  settled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (quota_day, operation_id)
);

CREATE INDEX IF NOT EXISTS youtube_key_cap_shadow_settled_expiry_idx
  ON youtube_key_cap_shadow_settled (expires_at);
