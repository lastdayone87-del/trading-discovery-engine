-- Migration 135: site profiler persistence (non-destructive).
--
-- One additive table, no changes to existing tables:
--
-- site_profiles stores the deterministic inventory a Site Profiler run
-- produces for one site identity: robots state, sitemap/feed inventory,
-- structured-data presence, homepage page-type prior, and politeness
-- baseline. Every field carries its own source URL, fetch timestamp, and
-- method inside the profile JSONB so inventory is attributable without a
-- second fetch. Profiles are advisory input to later phases (frontier,
-- ladder); nothing serving reads them until an explicit phase flag admits
-- a consumer. Unknown profiles fail open toward normal acquisition.
--
-- Operational safety: CREATE TABLE IF NOT EXISTS only, no backfills,
-- no constraint validation, safe inside the single-transaction runner.
-- No CHECK constraint on state/profile text columns: new profiler states
-- must never fail at the database layer (code validates instead).

CREATE TABLE IF NOT EXISTS site_profiles (
  site_identity TEXT PRIMARY KEY,
  identity_tier TEXT NOT NULL DEFAULT '',
  robots_state TEXT NOT NULL DEFAULT 'UNKNOWN',
  robots_fetched_at TIMESTAMPTZ,
  sitemap_inventory JSONB NOT NULL DEFAULT '[]',
  feed_inventory JSONB NOT NULL DEFAULT '[]',
  structured_data JSONB NOT NULL DEFAULT '{}',
  page_type TEXT NOT NULL DEFAULT 'UNKNOWN',
  politeness JSONB NOT NULL DEFAULT '{}',
  profile JSONB NOT NULL DEFAULT '{}',
  policy_version TEXT NOT NULL DEFAULT '',
  first_observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  observed_count INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_site_profiles_observed ON site_profiles(last_observed_at);
