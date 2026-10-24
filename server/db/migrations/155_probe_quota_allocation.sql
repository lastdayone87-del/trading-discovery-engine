-- Migration 155: independent probe-origin official YouTube allocation.
--
-- The #533 per-key hard cap is global and default-OFF. Probe-origin work needs
-- a separate, explicit budget that is enforced even while the global cap is
-- OFF, and that remains additive when the global cap is ON. This migration is
-- additive: existing lease rows become NORMAL, the probe allocation tables are
-- empty, and no app_settings row is created. Both probe flags are absent => no
-- probe-origin official calls are admitted.

-- Bound the lock wait on the live lease table so a blocked deployment cannot
-- queue every later migration behind it. Scoped by the migration transaction.
SET LOCAL lock_timeout = '10s';

ALTER TABLE youtube_key_cap_shadow_leases
  ADD COLUMN IF NOT EXISTS allocation TEXT NOT NULL DEFAULT 'NORMAL';

ALTER TABLE youtube_key_cap_shadow_leases
  DROP CONSTRAINT IF EXISTS youtube_key_cap_shadow_leases_allocation_check;
ALTER TABLE youtube_key_cap_shadow_leases
  ADD CONSTRAINT youtube_key_cap_shadow_leases_allocation_check
  CHECK (allocation IN ('NORMAL', 'PROBE'));

CREATE INDEX IF NOT EXISTS youtube_key_cap_shadow_leases_probe_idx
  ON youtube_key_cap_shadow_leases (quota_day, expires_at)
  WHERE allocation = 'PROBE';

-- Settled probe units are separate from normal usage so the probe bucket can
-- never be diluted by, or borrow from, ordinary discovery/enrichment traffic.
CREATE TABLE IF NOT EXISTS youtube_probe_quota_usage (
  quota_day TEXT PRIMARY KEY,
  units_used INTEGER NOT NULL DEFAULT 0 CHECK (units_used >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN youtube_key_cap_shadow_leases.allocation IS
  'NORMAL = ordinary/global cap lease; PROBE = probe-origin allocation lease. Probe leases also count toward the #533 per-key cap when it is enabled.';
COMMENT ON TABLE youtube_probe_quota_usage IS
  'Settled official YouTube units charged to the independent probe-origin daily allocation. No rows or flags are created by migration.';
