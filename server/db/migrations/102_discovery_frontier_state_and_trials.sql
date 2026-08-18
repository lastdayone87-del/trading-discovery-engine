-- Phase 5: Discovery Neighborhood Frontier States
CREATE TABLE IF NOT EXISTS discovery_neighborhood_frontier_states (
  neighborhood_key TEXT PRIMARY KEY REFERENCES discovery_neighborhoods(neighborhood_key) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('UNEXPLORED','PROBING','PRODUCTIVE','PARTIALLY_OBSERVED','SATURATING','SATURATED','MAINTENANCE','HARMFUL','UNKNOWN')),
  previous_state TEXT,
  transition_reason TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  observation_count INTEGER NOT NULL DEFAULT 0,
  last_observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_frontier_states_state ON discovery_neighborhood_frontier_states(state);
CREATE INDEX IF NOT EXISTS idx_frontier_states_updated ON discovery_neighborhood_frontier_states(updated_at);

CREATE TABLE IF NOT EXISTS discovery_neighborhood_state_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  neighborhood_key TEXT NOT NULL REFERENCES discovery_neighborhoods(neighborhood_key) ON DELETE CASCADE,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  transition_reason TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  transitioned_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_frontier_state_hist_key ON discovery_neighborhood_state_history(neighborhood_key);
CREATE INDEX IF NOT EXISTS idx_frontier_state_hist_time ON discovery_neighborhood_state_history(transitioned_at);

-- Phase 6: Independent Frontier Proposals
CREATE TABLE IF NOT EXISTS frontier_discovery_proposals (
  proposal_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dedup_key TEXT UNIQUE NOT NULL,
  proposal_family TEXT NOT NULL CHECK(proposal_family IN ('LEARNED','CREATOR_DERIVED','CREATOR_NEIGHBORHOOD','PLAYLIST_TOPIC','COUNTRY_NATIVE','COVERAGE_GAP','TEMPORAL')),
  country TEXT NOT NULL,
  language TEXT,
  concept TEXT NOT NULL,
  target_neighborhood_key TEXT REFERENCES discovery_neighborhoods(neighborhood_key) ON DELETE SET NULL,
  target_dimensions JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_provenance TEXT NOT NULL,
  supporting_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence REAL NOT NULL DEFAULT 0.5,
  novelty_rationale TEXT NOT NULL,
  trial_status TEXT NOT NULL DEFAULT 'PENDING' CHECK(trial_status IN ('PENDING','TRIED','EXPIRED','DISABLED')),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_frontier_props_family ON frontier_discovery_proposals(proposal_family);
CREATE INDEX IF NOT EXISTS idx_frontier_props_country ON frontier_discovery_proposals(country);
CREATE INDEX IF NOT EXISTS idx_frontier_props_status ON frontier_discovery_proposals(trial_status);
CREATE INDEX IF NOT EXISTS idx_frontier_props_dedup ON frontier_discovery_proposals(dedup_key);

-- Phase 7: Controlled Frontier Canary Trials
CREATE TABLE IF NOT EXISTS frontier_canary_trials (
  trial_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trial_key TEXT UNIQUE NOT NULL,
  proposal_id UUID NOT NULL REFERENCES frontier_discovery_proposals(proposal_id) ON DELETE CASCADE,
  query_run_id UUID REFERENCES query_runs(id) ON DELETE SET NULL,
  country TEXT NOT NULL,
  neighborhood_key TEXT REFERENCES discovery_neighborhoods(neighborhood_key) ON DELETE SET NULL,
  quota_reserved INTEGER NOT NULL DEFAULT 100,
  quota_consumed INTEGER NOT NULL DEFAULT 0,
  trial_status TEXT NOT NULL DEFAULT 'INITIATED' CHECK(trial_status IN ('INITIATED','COMPLETED','FAILED','KILLED')),
  outcome_state TEXT CHECK(outcome_state IN ('PRODUCTIVE','PROMISING','UNCERTAIN','SATURATED','NOISY','HARMFUL')),
  creators_returned INTEGER NOT NULL DEFAULT 0,
  distinct_creators INTEGER NOT NULL DEFAULT 0,
  new_creators INTEGER NOT NULL DEFAULT 0,
  relevant_new_creators INTEGER NOT NULL DEFAULT 0,
  quality_new_creators INTEGER NOT NULL DEFAULT 0,
  known_channel_overlap REAL NOT NULL DEFAULT 0,
  neighborhood_overlap REAL NOT NULL DEFAULT 0,
  marginal_discovery_value REAL NOT NULL DEFAULT 0,
  coverage_gain REAL NOT NULL DEFAULT 0,
  retrieval_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  initiated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_frontier_trials_proposal ON frontier_canary_trials(proposal_id);
CREATE INDEX IF NOT EXISTS idx_frontier_trials_run ON frontier_canary_trials(query_run_id);
CREATE INDEX IF NOT EXISTS idx_frontier_trials_status ON frontier_canary_trials(trial_status);
CREATE INDEX IF NOT EXISTS idx_frontier_trials_time ON frontier_canary_trials(initiated_at);
