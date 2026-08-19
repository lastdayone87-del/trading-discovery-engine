-- Phase 9: Retrieval Strategy Learning

-- 1. Canonical lookup table for retrieval configurations
CREATE TABLE IF NOT EXISTS retrieval_configurations (
  config_key TEXT PRIMARY KEY,
  search_ordering TEXT NOT NULL CHECK (search_ordering IN ('RELEVANCE', 'DATE')),
  retrieval_lane TEXT NOT NULL CHECK (retrieval_lane IN ('VIDEO', 'CHANNEL')),
  requested_page_depth INTEGER NOT NULL CHECK (requested_page_depth BETWEEN 1 AND 3),
  continuation_mode TEXT NOT NULL,
  freshness_mode TEXT NOT NULL,
  maintenance_mode TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Phase 9 Treatment Reservations (Concurrency-safe Pacific quota-day cap tracking)
CREATE TABLE IF NOT EXISTS retrieval_canary_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id TEXT UNIQUE NOT NULL,
  opportunity_key TEXT NOT NULL,
  neighborhood_key TEXT REFERENCES discovery_neighborhoods(neighborhood_key) ON DELETE SET NULL,
  query_run_id UUID REFERENCES query_runs(id) ON DELETE SET NULL,
  reservation_status TEXT NOT NULL DEFAULT 'RESERVED' CHECK (reservation_status IN ('RESERVED', 'COMMITTED', 'RELEASED', 'DEFERRED')),
  quota_reserved INTEGER NOT NULL DEFAULT 100,
  quota_consumed INTEGER NOT NULL DEFAULT 0,
  quota_day TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  retrieval_config_key TEXT REFERENCES retrieval_configurations(config_key) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_retrieval_canary_quota_reserved CHECK (quota_reserved BETWEEN 0 AND 300),
  CONSTRAINT chk_retrieval_canary_quota_consumed CHECK (quota_consumed >= 0)
);

CREATE INDEX IF NOT EXISTS idx_retrieval_res_day ON retrieval_canary_reservations(quota_day);
CREATE INDEX IF NOT EXISTS idx_retrieval_res_status ON retrieval_canary_reservations(reservation_status);
CREATE INDEX IF NOT EXISTS idx_retrieval_res_run ON retrieval_canary_reservations(query_run_id);
CREATE INDEX IF NOT EXISTS idx_retrieval_res_neigh ON retrieval_canary_reservations(neighborhood_key);

-- 3. Shadow retrieval policy recommendations (Zero serving authority)
CREATE TABLE IF NOT EXISTS retrieval_policy_shadow_recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_key TEXT NOT NULL,
  query_run_id UUID REFERENCES query_runs(id) ON DELETE CASCADE,
  neighborhood_key TEXT REFERENCES discovery_neighborhoods(neighborhood_key) ON DELETE SET NULL,
  control_config_key TEXT NOT NULL REFERENCES retrieval_configurations(config_key),
  executed_config_key TEXT NOT NULL REFERENCES retrieval_configurations(config_key),
  recommended_config_key TEXT NOT NULL REFERENCES retrieval_configurations(config_key),
  expected_marginal_value REAL NOT NULL DEFAULT 0,
  uncertainty REAL NOT NULL DEFAULT 0,
  expected_quota_impact INTEGER NOT NULL DEFAULT 0,
  differs_from_control BOOLEAN NOT NULL DEFAULT FALSE,
  differs_from_executed BOOLEAN NOT NULL DEFAULT FALSE,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shadow_retrieval_rec_run ON retrieval_policy_shadow_recommendations(query_run_id);
CREATE INDEX IF NOT EXISTS idx_shadow_retrieval_rec_neigh ON retrieval_policy_shadow_recommendations(neighborhood_key);
CREATE INDEX IF NOT EXISTS idx_shadow_retrieval_rec_time ON retrieval_policy_shadow_recommendations(created_at);

-- 4. Derived, idempotent aggregate retrieval-policy neighborhood evidence table
CREATE TABLE IF NOT EXISTS retrieval_policy_neighborhood_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  neighborhood_key TEXT NOT NULL REFERENCES discovery_neighborhoods(neighborhood_key) ON DELETE CASCADE,
  config_key TEXT NOT NULL REFERENCES retrieval_configurations(config_key) ON DELETE CASCADE,
  execution_count INTEGER NOT NULL DEFAULT 0,
  recent_execution_count INTEGER NOT NULL DEFAULT 0,
  expected_marginal_value REAL NOT NULL DEFAULT 0,
  observed_marginal_value REAL NOT NULL DEFAULT 0,
  relevant_new_yield REAL NOT NULL DEFAULT 0,
  quality_new_yield REAL NOT NULL DEFAULT 0,
  duplicate_rate REAL NOT NULL DEFAULT 0,
  known_creator_rate REAL NOT NULL DEFAULT 0,
  page_level_yields JSONB NOT NULL DEFAULT '[]'::jsonb,
  quota_cost INTEGER NOT NULL DEFAULT 0,
  uncertainty REAL NOT NULL DEFAULT 0,
  exposure_count INTEGER NOT NULL DEFAULT 0,
  last_tested_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT unq_retrieval_neigh_evidence UNIQUE (neighborhood_key, config_key)
);

CREATE INDEX IF NOT EXISTS idx_retrieval_evidence_neigh ON retrieval_policy_neighborhood_evidence(neighborhood_key);
CREATE INDEX IF NOT EXISTS idx_retrieval_evidence_config ON retrieval_policy_neighborhood_evidence(config_key);

-- 5. Extend query_runs and autonomous_query_page_observations with config identity and treatment origin
ALTER TABLE query_runs
  ADD COLUMN IF NOT EXISTS retrieval_config_key TEXT,
  ADD COLUMN IF NOT EXISTS retrieval_treatment_origin TEXT DEFAULT 'CONTROL';

ALTER TABLE autonomous_query_page_observations
  ADD COLUMN IF NOT EXISTS retrieval_config_key TEXT,
  ADD COLUMN IF NOT EXISTS retrieval_treatment_origin TEXT DEFAULT 'CONTROL';

-- Add additive CHECK constraints for supported origin values
ALTER TABLE query_runs
  DROP CONSTRAINT IF EXISTS chk_query_runs_retrieval_treatment_origin;
ALTER TABLE query_runs
  ADD CONSTRAINT chk_query_runs_retrieval_treatment_origin
  CHECK (retrieval_treatment_origin IN ('CONTROL', 'CANARY_TREATMENT'));

ALTER TABLE autonomous_query_page_observations
  DROP CONSTRAINT IF EXISTS chk_page_obs_retrieval_treatment_origin;
ALTER TABLE autonomous_query_page_observations
  ADD CONSTRAINT chk_page_obs_retrieval_treatment_origin
  CHECK (retrieval_treatment_origin IN ('CONTROL', 'CANARY_TREATMENT'));
