-- Phase 2: Neighborhood Overlap & Saturation Observations
CREATE TABLE IF NOT EXISTS neighborhood_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  neighborhood_key TEXT NOT NULL REFERENCES discovery_neighborhoods(neighborhood_key) ON DELETE CASCADE,
  query_run_id UUID UNIQUE REFERENCES query_runs(id) ON DELETE CASCADE,
  total_results INTEGER NOT NULL DEFAULT 0,
  duplicate_ratio REAL NOT NULL DEFAULT 0,
  known_creator_ratio REAL NOT NULL DEFAULT 0,
  new_creator_ratio REAL NOT NULL DEFAULT 0,
  relevant_new_creator_ratio REAL NOT NULL DEFAULT 0,
  quality_new_creator_ratio REAL NOT NULL DEFAULT 0,
  jaccard_similarity REAL,
  result_set_overlap REAL,
  quota_consumed INTEGER NOT NULL DEFAULT 0,
  retrieval_depth INTEGER NOT NULL DEFAULT 1,
  search_ordering TEXT NOT NULL DEFAULT 'RELEVANCE',
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_neighborhood_obs_key ON neighborhood_observations(neighborhood_key);
CREATE INDEX IF NOT EXISTS idx_neighborhood_obs_run ON neighborhood_observations(query_run_id);
CREATE INDEX IF NOT EXISTS idx_neighborhood_obs_time ON neighborhood_observations(observed_at);

-- Phase 3: Marginal Discovery Value (Shadow Only)
CREATE TABLE IF NOT EXISTS neighborhood_marginal_values (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  neighborhood_key TEXT NOT NULL REFERENCES discovery_neighborhoods(neighborhood_key) ON DELETE CASCADE,
  query_run_id UUID UNIQUE REFERENCES query_runs(id) ON DELETE CASCADE,
  expected_marginal_value REAL NOT NULL DEFAULT 0,
  observed_marginal_value REAL NOT NULL DEFAULT 0,
  coverage_gain REAL NOT NULL DEFAULT 0,
  information_gain REAL NOT NULL DEFAULT 0,
  frontier_expansion_gain REAL NOT NULL DEFAULT 0,
  uncertainty_reduction REAL NOT NULL DEFAULT 0,
  quota_cost INTEGER NOT NULL DEFAULT 0,
  review_cost INTEGER NOT NULL DEFAULT 0,
  redundancy_penalty REAL NOT NULL DEFAULT 0,
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_neighborhood_mv_key ON neighborhood_marginal_values(neighborhood_key);
CREATE INDEX IF NOT EXISTS idx_neighborhood_mv_run ON neighborhood_marginal_values(query_run_id);
CREATE INDEX IF NOT EXISTS idx_neighborhood_mv_time ON neighborhood_marginal_values(calculated_at);

-- Phase 4: Segmented Discovery Health Diagnostics
CREATE TABLE IF NOT EXISTS neighborhood_health_diagnostics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  segment_type TEXT NOT NULL,
  segment_key TEXT NOT NULL,
  valuable_new_creators INTEGER NOT NULL DEFAULT 0,
  quota_consumed INTEGER NOT NULL DEFAULT 0,
  yield_per_1000_quota REAL NOT NULL DEFAULT 0,
  saturation_score REAL NOT NULL DEFAULT 0,
  frontier_expansion_rate REAL NOT NULL DEFAULT 0,
  underexplored_quota_percent REAL NOT NULL DEFAULT 0,
  provenance_diversity REAL NOT NULL DEFAULT 0,
  coverage_gap_identified BOOLEAN NOT NULL DEFAULT false,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT unq_health_diag_segment UNIQUE(segment_type, segment_key)
);

CREATE INDEX IF NOT EXISTS idx_health_diag_segment ON neighborhood_health_diagnostics(segment_type, segment_key);
CREATE INDEX IF NOT EXISTS idx_health_diag_time ON neighborhood_health_diagnostics(calculated_at);
