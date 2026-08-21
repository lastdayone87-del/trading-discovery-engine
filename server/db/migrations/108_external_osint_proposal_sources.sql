CREATE TABLE IF NOT EXISTS external_osint_observations (
  observation_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  source_family TEXT NOT NULL CHECK (source_family IN ('PUBLIC_COMMUNITY','PUBLICATION','EDUCATOR_DIRECTORY','BROKER_TERMINOLOGY','TREND_SURFACE')),
  source_url TEXT, external_id TEXT, fetched_at TIMESTAMPTZ NOT NULL, observed_at TIMESTAMPTZ NOT NULL,
  country TEXT NOT NULL, locale TEXT, language TEXT NOT NULL, script TEXT NOT NULL,
  original_surface TEXT NOT NULL CHECK (length(original_surface) BETWEEN 1 AND 160), canonical_concept TEXT NOT NULL,
  extraction_method TEXT NOT NULL, extraction_version TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL CHECK (confidence BETWEEN 0 AND 1), reliability DOUBLE PRECISION NOT NULL CHECK (reliability BETWEEN 0 AND 1), relevance DOUBLE PRECISION NOT NULL CHECK (relevance BETWEEN 0 AND 1),
  supporting_evidence JSONB NOT NULL, content_checksum TEXT NOT NULL, correlation_key TEXT,
  inserted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS external_osint_concept_evidence_idx ON external_osint_observations(canonical_concept,country,language,observed_at DESC);
CREATE INDEX IF NOT EXISTS external_osint_source_idx ON external_osint_observations(source_family,source_id,observed_at DESC);
CREATE TABLE IF NOT EXISTS external_osint_performance_attribution (
  attribution_key TEXT PRIMARY KEY, proposal_id UUID REFERENCES frontier_discovery_proposals(proposal_id) ON DELETE SET NULL,
  allocation_decision_id TEXT REFERENCES frontier_allocation_decisions(decision_id) ON DELETE SET NULL,
  query_run_id UUID REFERENCES query_runs(id) ON DELETE SET NULL, source_families JSONB NOT NULL, canonical_concept TEXT NOT NULL,
  country TEXT NOT NULL, evidence_snapshot JSONB NOT NULL, quota_consumed INTEGER NOT NULL DEFAULT 0,
  raw_results INTEGER NOT NULL DEFAULT 0, distinct_creators INTEGER NOT NULL DEFAULT 0, new_creators INTEGER NOT NULL DEFAULT 0,
  relevant_new_creators INTEGER NOT NULL DEFAULT 0, quality_new_creators INTEGER NOT NULL DEFAULT 0, confirmed_creators INTEGER NOT NULL DEFAULT 0,
  wrong_country_results INTEGER NOT NULL DEFAULT 0, coverage_expansion DOUBLE PRECISION NOT NULL DEFAULT 0, yield_score DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE frontier_discovery_proposals DROP CONSTRAINT IF EXISTS frontier_discovery_proposals_proposal_family_check;
ALTER TABLE frontier_discovery_proposals ADD CONSTRAINT frontier_discovery_proposals_proposal_family_check CHECK (proposal_family IN ('LEARNED','CREATOR_DERIVED','CREATOR_NEIGHBORHOOD','PLAYLIST_TOPIC','COUNTRY_NATIVE','COVERAGE_GAP','TEMPORAL','EXTERNAL_OSINT')) NOT VALID;
ALTER TABLE frontier_discovery_proposals VALIDATE CONSTRAINT frontier_discovery_proposals_proposal_family_check;
INSERT INTO app_settings(setting_key,setting_value) VALUES('external_osint_materialization_enabled','false') ON CONFLICT(setting_key) DO NOTHING;
