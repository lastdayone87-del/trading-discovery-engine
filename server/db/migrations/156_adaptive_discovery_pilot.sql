-- Migration 156: adaptive country-aware discovery pilot assignment ledger.
--
-- Additive and inert until adaptive_discovery_pilot_enabled=true. One row per
-- country and Pacific quota day records the deterministic randomized arm that
-- governed proposal materialization for that country-day. The immutable row is
-- the audit anchor for later net-new, relevance, duplicate, reliability and
-- resource metrics; it does not grant scheduling or serving authority.
CREATE TABLE IF NOT EXISTS adaptive_discovery_pilot_assignments (
  assignment_key TEXT PRIMARY KEY,
  country TEXT NOT NULL,
  quota_day TEXT NOT NULL,
  arm TEXT NOT NULL CHECK (arm IN ('TREATMENT', 'CONTROL')),
  treatment_percent INTEGER NOT NULL CHECK (treatment_percent BETWEEN 0 AND 100),
  assignment_seed TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (window_end > window_start),
  -- One assignment per country-Pacific-day. policy_version records which
  -- policy governed the day; a later policy release must not rerandomize an
  -- already-assigned day and split it between arms.
  UNIQUE(country, quota_day)
);

CREATE INDEX IF NOT EXISTS adaptive_pilot_assignment_window_idx
  ON adaptive_discovery_pilot_assignments(window_start, window_end, arm);

CREATE INDEX IF NOT EXISTS adaptive_pilot_assignment_country_idx
  ON adaptive_discovery_pilot_assignments(country, quota_day);

COMMENT ON TABLE adaptive_discovery_pilot_assignments IS
  'Immutable country-day randomized assignments for the opt-in adaptive discovery pilot. Assignment is audit evidence, not scheduling authority.';
