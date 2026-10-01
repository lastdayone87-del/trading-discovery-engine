-- Migration 134: global site-inspection deduplication (non-destructive).
--
-- Two additive tables, no changes to existing tables:
--
-- 1. site_inspections is the global site-level inspection cache keyed by
--    site identity (registrable domain / full host / host+path per the
--    tiered site-identity policy), never by creator. It stores site-facts
--    only: what a crawl of the site learned (outcome, Discord candidates
--    found ON the site, fetch metadata). It carries NO channel_id column
--    by design: a cache hit must never import another creator's ownership
--    attribution. Per-creator observations, Discord candidates, and
--    ownership verdicts stay in their existing channel-scoped tables.
--
-- 2. creator_site_links records the creator -> site relationship
--    (reference, never ownership): which creator linked which site, from
--    which surface. Written on every inspection whether the crawl ran or
--    was served from cache.
--
-- Operational safety: CREATE TABLE IF NOT EXISTS only, no backfills,
-- no constraint validation, safe inside the single-transaction runner.

CREATE TABLE IF NOT EXISTS site_inspections (
  site_identity TEXT PRIMARY KEY,
  identity_tier TEXT NOT NULL DEFAULT 'A',
  identity_basis TEXT NOT NULL DEFAULT '',
  canonical_url TEXT NOT NULL,
  final_url TEXT,
  outcome TEXT NOT NULL DEFAULT 'INSPECTED_NO_MATCH',
  retryable BOOLEAN NOT NULL DEFAULT FALSE,
  http_status INTEGER,
  failure_class TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  payload_checksum TEXT,
  candidates JSONB NOT NULL DEFAULT '[]',
  observations JSONB NOT NULL DEFAULT '[]',
  rendered_covered BOOLEAN NOT NULL DEFAULT FALSE,
  provenance JSONB NOT NULL DEFAULT '{}',
  first_observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  observed_count INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_site_inspections_observed ON site_inspections(last_observed_at);

CREATE TABLE IF NOT EXISTS creator_site_links (
  channel_id TEXT NOT NULL,
  site_identity TEXT NOT NULL,
  source_surface TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, site_identity, source_surface)
);
CREATE INDEX IF NOT EXISTS idx_creator_site_links_site ON creator_site_links(site_identity);
