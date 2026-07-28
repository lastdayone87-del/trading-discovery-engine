ALTER TABLE query_runs ADD COLUMN IF NOT EXISTS distinct_results INTEGER NOT NULL DEFAULT 0;
ALTER TABLE query_runs ADD COLUMN IF NOT EXISTS duplicate_results INTEGER NOT NULL DEFAULT 0;
ALTER TABLE query_runs ADD COLUMN IF NOT EXISTS known_channels INTEGER NOT NULL DEFAULT 0;
ALTER TABLE query_runs ADD COLUMN IF NOT EXISTS new_channels INTEGER NOT NULL DEFAULT 0;
ALTER TABLE query_runs ADD COLUMN IF NOT EXISTS country_rejected INTEGER NOT NULL DEFAULT 0;
ALTER TABLE query_runs ADD COLUMN IF NOT EXISTS non_trading INTEGER NOT NULL DEFAULT 0;
ALTER TABLE query_runs ADD COLUMN IF NOT EXISTS uncertain INTEGER NOT NULL DEFAULT 0;
ALTER TABLE query_runs ADD COLUMN IF NOT EXISTS needs_review INTEGER NOT NULL DEFAULT 0;
ALTER TABLE query_runs ADD COLUMN IF NOT EXISTS trading_confirmed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE query_runs ADD COLUMN IF NOT EXISTS performance_details JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS channel_sightings (
  id BIGSERIAL PRIMARY KEY,
  query_run_id UUID NOT NULL REFERENCES query_runs(id) ON DELETE CASCADE,
  query_id INTEGER NOT NULL REFERENCES query_library(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  result_rank INTEGER NOT NULL CHECK (result_rank > 0),
  search_lane TEXT NOT NULL DEFAULT 'CHANNEL',
  page_number INTEGER NOT NULL DEFAULT 1 CHECK (page_number > 0),
  was_known BOOLEAN NOT NULL,
  persisted BOOLEAN NOT NULL,
  country_outcome TEXT NOT NULL,
  trading_outcome TEXT NOT NULL,
  funnel_outcome TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(query_run_id, channel_id, search_lane, page_number)
);

CREATE TABLE IF NOT EXISTS query_run_components (
  query_run_id UUID NOT NULL REFERENCES query_runs(id) ON DELETE CASCADE,
  component_type TEXT NOT NULL,
  term TEXT NOT NULL,
  normalized_term TEXT NOT NULL,
  knowledge_tier SMALLINT NOT NULL CHECK (knowledge_tier BETWEEN 1 AND 3),
  position INTEGER NOT NULL DEFAULT 0,
  performance_details JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY(query_run_id, component_type, normalized_term)
);

CREATE INDEX IF NOT EXISTS idx_channel_sightings_channel ON channel_sightings(channel_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_channel_sightings_query ON channel_sightings(query_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_query_run_components_term ON query_run_components(normalized_term, knowledge_tier);
