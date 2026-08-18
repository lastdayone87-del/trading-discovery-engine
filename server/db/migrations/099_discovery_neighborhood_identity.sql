CREATE TABLE IF NOT EXISTS discovery_neighborhoods (
  neighborhood_key TEXT PRIMARY KEY,
  neighborhood_checksum TEXT NOT NULL,
  country TEXT NOT NULL,
  language TEXT,
  query_intent TEXT NOT NULL,
  primary_term_family TEXT NOT NULL,
  retrieval_lane TEXT NOT NULL,
  search_ordering TEXT NOT NULL,
  instrument_or_theme TEXT,
  source_family TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_observed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_discovery_neighborhoods_country ON discovery_neighborhoods(country);
CREATE INDEX IF NOT EXISTS idx_discovery_neighborhoods_intent ON discovery_neighborhoods(query_intent);
CREATE INDEX IF NOT EXISTS idx_discovery_neighborhoods_checksum ON discovery_neighborhoods(neighborhood_checksum);

CREATE TABLE IF NOT EXISTS retrieval_action_neighborhoods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query_run_id UUID NOT NULL REFERENCES query_runs(id) ON DELETE CASCADE,
  query_id INTEGER REFERENCES query_library(id) ON DELETE SET NULL,
  neighborhood_key TEXT NOT NULL REFERENCES discovery_neighborhoods(neighborhood_key) ON DELETE CASCADE,
  retrieval_action_key TEXT UNIQUE NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_retrieval_action_neighborhoods_run ON retrieval_action_neighborhoods(query_run_id);
CREATE INDEX IF NOT EXISTS idx_retrieval_action_neighborhoods_key ON retrieval_action_neighborhoods(neighborhood_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_retrieval_action_neighborhoods_action_key ON retrieval_action_neighborhoods(retrieval_action_key);
