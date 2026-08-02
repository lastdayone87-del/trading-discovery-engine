-- Provider-neutral persistent research control plane.  All serving is fail-closed:
-- programs and providers start in SHADOW, actions require explicit allocation, and
-- immutable observations/outcomes are never rewritten by a later policy.
ALTER TABLE research_programs
  ADD COLUMN IF NOT EXISTS objective JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS coverage_definition JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS hypothesis_version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS discovery_provider_registry (
  provider_key TEXT PRIMARY KEY,
  provider_family TEXT NOT NULL,
  provider_kind TEXT NOT NULL CHECK(provider_kind IN('RETRIEVAL','EVIDENCE','GENERATOR','RESOLVER','EVALUATOR')),
  capabilities JSONB NOT NULL,
  locale_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  quota_domain TEXT NOT NULL,
  terms_reference TEXT,
  mode TEXT NOT NULL DEFAULT 'SHADOW' CHECK(mode IN('SHADOW','CANARY','ACTIVE','PAUSED','RETIRED')),
  daily_cost_cap INTEGER NOT NULL DEFAULT 0 CHECK(daily_cost_cap>=0),
  configuration_version INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS discovery_hypotheses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), hypothesis_key TEXT NOT NULL UNIQUE,
  program_id UUID NOT NULL REFERENCES research_programs(id) ON DELETE RESTRICT,
  hypothesis_type TEXT NOT NULL CHECK(hypothesis_type IN('QUERY_SURFACE','CREATOR_NETWORK','SEMANTIC_NEIGHBORHOOD','EXTERNAL_NOMINATION','COVERAGE_GAP','STALE_REFRESH')),
  statement TEXT NOT NULL, coordinates JSONB NOT NULL, provenance JSONB NOT NULL,
  source_family_ids JSONB NOT NULL, confidence_basis_points INTEGER NOT NULL CHECK(confidence_basis_points BETWEEN 0 AND 10000),
  lifecycle TEXT NOT NULL DEFAULT 'PROPOSED' CHECK(lifecycle IN('PROPOSED','VALIDATED','TRIAL','PROVEN','SLEEPING','REJECTED','SUPERSEDED')),
  policy_version TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS discovery_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), action_key TEXT NOT NULL UNIQUE,
  program_id UUID NOT NULL REFERENCES research_programs(id) ON DELETE RESTRICT,
  hypothesis_id UUID REFERENCES discovery_hypotheses(id) ON DELETE RESTRICT,
  action_type TEXT NOT NULL CHECK(action_type IN('SEARCH_YOUTUBE','SEARCH_CHANNEL','INSPECT_PLAYLIST','INSPECT_FEATURED_CHANNELS','INSPECT_COLLABORATOR','RESOLVE_EXTERNAL_ENTITY','INSPECT_WEBSITE_AUTHOR','MINE_TRANSCRIPT_KEYPHRASES','MINE_CHANNEL_CORPUS','PROBE_COVERAGE_CELL','TEST_CROSS_LANGUAGE_SURFACE','REFRESH_STALE_FRONTIER','HUMAN_NOMINATION')),
  provider_key TEXT REFERENCES discovery_provider_registry(provider_key) ON DELETE RESTRICT,
  normalized_target TEXT NOT NULL, context JSONB NOT NULL, provenance JSONB NOT NULL,
  source_family_ids JSONB NOT NULL, parent_action_id UUID REFERENCES discovery_actions(id) ON DELETE RESTRICT,
  depth INTEGER NOT NULL DEFAULT 0 CHECK(depth BETWEEN 0 AND 3), cluster_key TEXT NOT NULL,
  expected_incremental_creators DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK(expected_incremental_creators>=0),
  expected_information_gain DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK(expected_information_gain>=0),
  expected_coverage_gain DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK(expected_coverage_gain>=0),
  uncertainty DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK(uncertainty BETWEEN 0 AND 1),
  provider_cost INTEGER NOT NULL DEFAULT 0 CHECK(provider_cost>=0), review_cost INTEGER NOT NULL DEFAULT 0 CHECK(review_cost>=0),
  overlap_penalty DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK(overlap_penalty BETWEEN 0 AND 1),
  lifecycle TEXT NOT NULL DEFAULT 'PROPOSED' CHECK(lifecycle IN('PROPOSED','ALLOCATED','QUEUED','RUNNING','COMPLETED','SLEEPING','REJECTED','EXPIRED')),
  policy_version TEXT NOT NULL, expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS discovery_actions_frontier_idx ON discovery_actions(program_id,lifecycle,created_at);

CREATE TABLE IF NOT EXISTS discovery_action_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), assignment_key TEXT NOT NULL UNIQUE,
  action_id UUID NOT NULL REFERENCES discovery_actions(id) ON DELETE RESTRICT,
  policy_key TEXT NOT NULL, policy_version TEXT NOT NULL, selected BOOLEAN NOT NULL,
  rank INTEGER, propensity_basis_points INTEGER NOT NULL CHECK(propensity_basis_points BETWEEN 0 AND 10000),
  utility DOUBLE PRECISION NOT NULL, reason_codes JSONB NOT NULL, context_snapshot JSONB NOT NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS discovery_action_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), outcome_key TEXT NOT NULL UNIQUE,
  action_id UUID NOT NULL REFERENCES discovery_actions(id) ON DELETE RESTRICT,
  assignment_id UUID REFERENCES discovery_action_assignments(id) ON DELETE RESTRICT,
  subject_entity_id UUID REFERENCES canonical_entities(id) ON DELETE RESTRICT,
  outcome_type TEXT NOT NULL CHECK(outcome_type IN('NOMINATED','UNIQUE_ENTITY','KNOWN_ENTITY','TRADING_CONFIRMED','QUALITY_CREATOR','COMMUNITY_DISCOVERED','WRONG_COUNTRY','NON_TRADING','UNCERTAIN','PROVIDER_FAILED')),
  incremental BOOLEAN NOT NULL DEFAULT false, provider_cost INTEGER NOT NULL DEFAULT 0 CHECK(provider_cost>=0),
  review_cost INTEGER NOT NULL DEFAULT 0 CHECK(review_cost>=0), confirmation_latency_ms BIGINT CHECK(confirmation_latency_ms>=0),
  source_event_key TEXT, evidence JSONB NOT NULL, observed_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS discovery_action_outcomes_attribution_idx ON discovery_action_outcomes(action_id,outcome_type,observed_at);

CREATE TABLE IF NOT EXISTS hierarchical_coverage_cells (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), cell_key TEXT NOT NULL UNIQUE,
  dimension_version TEXT NOT NULL, coordinates JSONB NOT NULL, parent_cell_key TEXT,
  reachable BOOLEAN NOT NULL DEFAULT true, provider_reachability JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_creators INTEGER NOT NULL DEFAULT 0 CHECK(observed_creators>=0), estimated_unseen DOUBLE PRECISION CHECK(estimated_unseen>=0),
  posterior_uncertainty DOUBLE PRECISION NOT NULL DEFAULT 1 CHECK(posterior_uncertainty BETWEEN 0 AND 1),
  marginal_yield DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK(marginal_yield>=0), last_probed_at TIMESTAMPTZ,
  lifecycle TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(lifecycle IN('ACTIVE','SLEEPING','PAUSED')),
  policy_version TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS research_control (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton), mode TEXT NOT NULL DEFAULT 'SHADOW' CHECK(mode IN('SHADOW','CANARY')),
  paused BOOLEAN NOT NULL DEFAULT false, kill_switch BOOLEAN NOT NULL DEFAULT true,
  daily_provider_cost_cap INTEGER NOT NULL DEFAULT 0 CHECK(daily_provider_cost_cap>=0), daily_review_cost_cap INTEGER NOT NULL DEFAULT 0 CHECK(daily_review_cost_cap>=0),
  exploration_basis_points INTEGER NOT NULL DEFAULT 2000 CHECK(exploration_basis_points BETWEEN 0 AND 5000),
  max_actions_per_cycle INTEGER NOT NULL DEFAULT 5 CHECK(max_actions_per_cycle BETWEEN 1 AND 50),
  configuration_version INTEGER NOT NULL DEFAULT 1, updated_by TEXT NOT NULL DEFAULT 'system:migration', updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO research_control(singleton) VALUES(true) ON CONFLICT DO NOTHING;

INSERT INTO discovery_provider_registry(provider_key,provider_family,provider_kind,capabilities,quota_domain,mode,daily_cost_cap,updated_by) VALUES
 ('youtube-search','youtube','RETRIEVAL','["SEARCH_YOUTUBE","SEARCH_CHANNEL"]','YOUTUBE_DATA_API','ACTIVE',0,'system:migration'),
 ('youtube-playlist','youtube','RETRIEVAL','["INSPECT_PLAYLIST"]','YOUTUBE_DATA_API','SHADOW',0,'system:migration'),
 ('youtube-corpus','youtube-cached','GENERATOR','["MINE_CHANNEL_CORPUS","MINE_TRANSCRIPT_KEYPHRASES"]','LOCAL_COMPUTE','SHADOW',0,'system:migration'),
 ('temporal-entity-graph','governed-graph','GENERATOR','["INSPECT_FEATURED_CHANNELS","INSPECT_COLLABORATOR","REFRESH_STALE_FRONTIER"]','LOCAL_COMPUTE','SHADOW',0,'system:migration'),
 ('structured-external-nominations','allowlisted-external','RETRIEVAL','["RESOLVE_EXTERNAL_ENTITY","INSPECT_WEBSITE_AUTHOR","HUMAN_NOMINATION"]','EXTERNAL_NOMINATION','PAUSED',0,'system:migration')
ON CONFLICT(provider_key) DO NOTHING;

INSERT INTO app_settings(setting_key,setting_value) VALUES
 ('persistent_research_enabled','false'),('persistent_research_scheduler_interval_minutes','15')
ON CONFLICT(setting_key) DO NOTHING;

DO $$ DECLARE t TEXT; BEGIN FOREACH t IN ARRAY ARRAY['discovery_action_assignments','discovery_action_outcomes'] LOOP
 EXECUTE format('CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation()',t,t);
END LOOP; END $$;

COMMENT ON TABLE discovery_provider_registry IS 'Allowlisted provider capabilities; arbitrary crawling is not a registered capability.';
COMMENT ON TABLE discovery_action_outcomes IS 'Immutable delayed and incremental attribution ledger; discovery never changes classification authority.';
