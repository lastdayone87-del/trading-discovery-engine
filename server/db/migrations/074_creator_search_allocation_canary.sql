-- Phase 4 grants only bounded Creator Program allocation authority. Query
-- compilation, selection, lane, ordering, execution, pagination and quota
-- reservation remain in their existing owners.
CREATE TABLE IF NOT EXISTS creator_search_canary_control (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton),
  enabled BOOLEAN NOT NULL DEFAULT false,
  kill_switch BOOLEAN NOT NULL DEFAULT true,
  serving_authority_enabled BOOLEAN NOT NULL DEFAULT false,
  rollout_basis_points INTEGER NOT NULL DEFAULT 0 CHECK(rollout_basis_points BETWEEN 0 AND 10000),
  global_daily_allocation_cap INTEGER NOT NULL DEFAULT 0 CHECK(global_daily_allocation_cap>=0),
  global_daily_quota_cap INTEGER NOT NULL DEFAULT 0 CHECK(global_daily_quota_cap>=0),
  maximum_readiness_age_hours INTEGER NOT NULL DEFAULT 24 CHECK(maximum_readiness_age_hours>0),
  minimum_attribution_completeness DOUBLE PRECISION NOT NULL DEFAULT 1 CHECK(minimum_attribution_completeness BETWEEN 0 AND 1),
  readiness_policy_version TEXT NOT NULL DEFAULT 'creator-readiness-shadow-v1',
  policy_version TEXT NOT NULL DEFAULT 'creator-search-allocation-canary-v1',
  configuration_version INTEGER NOT NULL DEFAULT 1 CHECK(configuration_version>0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT NOT NULL DEFAULT 'system:migration',
  CHECK(NOT serving_authority_enabled OR (enabled AND NOT kill_switch AND rollout_basis_points>0 AND global_daily_allocation_cap>0 AND global_daily_quota_cap>0))
);
INSERT INTO creator_search_canary_control(singleton) VALUES(true) ON CONFLICT(singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS creator_search_canary_country_limits (
  country TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT false,
  daily_allocation_cap INTEGER NOT NULL CHECK(daily_allocation_cap>0),
  daily_quota_cap INTEGER NOT NULL CHECK(daily_quota_cap>0),
  policy_version TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS creator_search_canary_program_limits (
  program_id UUID PRIMARY KEY REFERENCES research_programs(id) ON DELETE RESTRICT,
  enabled BOOLEAN NOT NULL DEFAULT false,
  daily_allocation_cap INTEGER NOT NULL CHECK(daily_allocation_cap>0),
  daily_quota_cap INTEGER NOT NULL CHECK(daily_quota_cap>0),
  policy_version TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS creator_search_canary_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_key TEXT NOT NULL UNIQUE,
  opportunity_key TEXT NOT NULL UNIQUE,
  country TEXT NOT NULL,
  arm TEXT NOT NULL CHECK(arm IN('CONTROL','TREATMENT')),
  assignment_status TEXT NOT NULL CHECK(assignment_status IN('LEGACY_FALLBACK','CANARY_ALLOCATED')),
  program_id UUID REFERENCES research_programs(id) ON DELETE RESTRICT,
  objective_key TEXT,
  objective_version INTEGER CHECK(objective_version IS NULL OR objective_version>0),
  hypothesis_id UUID REFERENCES discovery_hypotheses(id) ON DELETE RESTRICT,
  readiness_run_id UUID REFERENCES creator_readiness_shadow_runs(id) ON DELETE RESTRICT,
  action_type TEXT NOT NULL CHECK(action_type='SEARCH_YOUTUBE'),
  rollout_basis_points INTEGER NOT NULL CHECK(rollout_basis_points BETWEEN 0 AND 10000),
  behavior_propensity_basis_points INTEGER NOT NULL CHECK(behavior_propensity_basis_points BETWEEN 1 AND 10000),
  treatment_propensity_basis_points INTEGER NOT NULL CHECK(treatment_propensity_basis_points BETWEEN 0 AND 10000),
  randomization_value INTEGER NOT NULL CHECK(randomization_value BETWEEN 0 AND 9999),
  estimated_quota_units INTEGER NOT NULL CHECK(estimated_quota_units>=0),
  eligibility_checksum TEXT NOT NULL CHECK(eligibility_checksum~'^[a-f0-9]{64}$'),
  reason_codes JSONB NOT NULL CHECK(jsonb_typeof(reason_codes)='array'),
  provenance JSONB NOT NULL CHECK(jsonb_typeof(provenance)='object'),
  policy_version TEXT NOT NULL,
  configuration_version INTEGER NOT NULL CHECK(configuration_version>0),
  serving_authority BOOLEAN NOT NULL,
  assigned_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK((assignment_status='CANARY_ALLOCATED' AND arm='TREATMENT' AND serving_authority=true AND program_id IS NOT NULL AND objective_key IS NOT NULL AND objective_version IS NOT NULL AND hypothesis_id IS NOT NULL AND readiness_run_id IS NOT NULL) OR
        (assignment_status='LEGACY_FALLBACK' AND arm='CONTROL' AND serving_authority=false AND program_id IS NULL AND objective_key IS NULL AND objective_version IS NULL AND hypothesis_id IS NULL))
);
CREATE INDEX IF NOT EXISTS creator_search_canary_daily_country_idx ON creator_search_canary_assignments(country,assigned_at) WHERE assignment_status='CANARY_ALLOCATED';
CREATE INDEX IF NOT EXISTS creator_search_canary_daily_program_idx ON creator_search_canary_assignments(program_id,assigned_at) WHERE assignment_status='CANARY_ALLOCATED';

CREATE TABLE IF NOT EXISTS creator_search_canary_query_run_bindings (
  binding_key TEXT PRIMARY KEY,
  assignment_id UUID NOT NULL UNIQUE REFERENCES creator_search_canary_assignments(id) ON DELETE RESTRICT,
  query_run_id UUID NOT NULL UNIQUE REFERENCES query_runs(id) ON DELETE RESTRICT,
  query_id INTEGER NOT NULL REFERENCES query_library(id) ON DELETE RESTRICT,
  selection_strategy TEXT NOT NULL,
  query_intelligence_authority BOOLEAN NOT NULL DEFAULT true CHECK(query_intelligence_authority=true),
  bound_at TIMESTAMPTZ NOT NULL,
  policy_version TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS creator_search_canary_control_events (
  event_key TEXT PRIMARY KEY,
  prior_configuration JSONB NOT NULL CHECK(jsonb_typeof(prior_configuration)='object'),
  resulting_configuration JSONB NOT NULL CHECK(jsonb_typeof(resulting_configuration)='object'),
  reason TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['creator_search_canary_assignments','creator_search_canary_query_run_bindings','creator_search_canary_control_events'] LOOP
    EXECUTE format('CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation()',t,t);
  END LOOP;
END $$;

COMMENT ON TABLE creator_search_canary_assignments IS 'Bounded SEARCH_YOUTUBE program allocation only; Query Intelligence remains query authority and every unsafe condition records legacy fallback.';
