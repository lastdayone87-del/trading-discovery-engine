-- Phase 6 counterfactual non-query proposals only. No proposal can be assigned,
-- scheduled, enqueued, materialized, or executed.
CREATE TABLE IF NOT EXISTS creator_non_query_shadow_control (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton),
  enabled BOOLEAN NOT NULL DEFAULT false,
  mode TEXT NOT NULL DEFAULT 'SHADOW' CHECK(mode='SHADOW'),
  maximum_readiness_age_hours INTEGER NOT NULL DEFAULT 24 CHECK(maximum_readiness_age_hours>0),
  policy_version TEXT NOT NULL DEFAULT 'creator-non-query-shadow-v1',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT NOT NULL DEFAULT 'system:migration'
);
INSERT INTO creator_non_query_shadow_control(singleton) VALUES(true) ON CONFLICT(singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS creator_non_query_shadow_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_key TEXT NOT NULL UNIQUE,
  cutoff_at TIMESTAMPTZ NOT NULL,
  readiness_run_id UUID REFERENCES creator_readiness_shadow_runs(id) ON DELETE RESTRICT,
  source_allocation_run_id UUID REFERENCES creator_program_allocation_shadow_runs(id) ON DELETE RESTRICT,
  disposition TEXT NOT NULL CHECK(disposition IN('COMPLETED','ABSTAIN')),
  reason_codes JSONB NOT NULL CHECK(jsonb_typeof(reason_codes)='array'),
  input_checksum TEXT NOT NULL CHECK(input_checksum~'^[a-f0-9]{64}$'),
  output_checksum TEXT NOT NULL CHECK(output_checksum~'^[a-f0-9]{64}$'),
  input_count INTEGER NOT NULL CHECK(input_count>=0),
  proposal_count INTEGER NOT NULL CHECK(proposal_count>=0),
  policy_version TEXT NOT NULL,
  serving_authority BOOLEAN NOT NULL DEFAULT false CHECK(serving_authority=false),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS creator_non_query_shadow_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_key TEXT NOT NULL UNIQUE,
  projection_run_id UUID NOT NULL REFERENCES creator_non_query_shadow_runs(id) ON DELETE RESTRICT,
  program_id UUID NOT NULL REFERENCES research_programs(id) ON DELETE RESTRICT,
  objective_key TEXT NOT NULL,
  objective_version INTEGER NOT NULL CHECK(objective_version>0),
  hypothesis_id UUID NOT NULL REFERENCES discovery_hypotheses(id) ON DELETE RESTRICT,
  acquisition_type TEXT NOT NULL CHECK(acquisition_type IN('INSPECT_PLAYLIST','INSPECT_FEATURED_CHANNELS','INSPECT_COLLABORATOR','INSPECT_WEBSITE_AUTHOR','RESOLVE_EXTERNAL_ENTITY')),
  provider_key TEXT NOT NULL,
  normalized_target TEXT NOT NULL,
  expected_creator_value DOUBLE PRECISION NOT NULL CHECK(expected_creator_value>=0),
  expected_coverage_gain DOUBLE PRECISION NOT NULL CHECK(expected_coverage_gain>=0),
  expected_information_gain DOUBLE PRECISION NOT NULL CHECK(expected_information_gain>=0),
  expected_uncertainty_reduction DOUBLE PRECISION NOT NULL CHECK(expected_uncertainty_reduction>=0),
  estimated_provider_cost DOUBLE PRECISION NOT NULL CHECK(estimated_provider_cost>=0),
  estimated_review_cost DOUBLE PRECISION NOT NULL CHECK(estimated_review_cost>=0),
  confidence DOUBLE PRECISION NOT NULL CHECK(confidence BETWEEN 0 AND 1),
  supporting_evidence JSONB NOT NULL CHECK(jsonb_typeof(supporting_evidence)='array'),
  provenance JSONB NOT NULL CHECK(jsonb_typeof(provenance)='object'),
  execution_propensity_basis_points INTEGER NOT NULL DEFAULT 0 CHECK(execution_propensity_basis_points=0),
  policy_version TEXT NOT NULL,
  serving_authority BOOLEAN NOT NULL DEFAULT false CHECK(serving_authority=false),
  proposed_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS creator_non_query_shadow_lineage (
  proposal_id UUID PRIMARY KEY REFERENCES creator_non_query_shadow_proposals(id) ON DELETE RESTRICT,
  readiness_run_id UUID NOT NULL REFERENCES creator_readiness_shadow_runs(id) ON DELETE RESTRICT,
  source_allocation_run_id UUID NOT NULL REFERENCES creator_program_allocation_shadow_runs(id) ON DELETE RESTRICT,
  guardrail_snapshot_ids JSONB NOT NULL CHECK(jsonb_typeof(guardrail_snapshot_ids)='array'),
  source_assignment_ids JSONB NOT NULL CHECK(jsonb_typeof(source_assignment_ids)='array'),
  creator_outcome_ids JSONB NOT NULL CHECK(jsonb_typeof(creator_outcome_ids)='array'),
  coverage_snapshot_ids JSONB NOT NULL CHECK(jsonb_typeof(coverage_snapshot_ids)='array'),
  source_event_keys JSONB NOT NULL CHECK(jsonb_typeof(source_event_keys)='array'),
  lineage_checksum TEXT NOT NULL CHECK(lineage_checksum~'^[a-f0-9]{64}$'),
  policy_version TEXT NOT NULL
);

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['creator_non_query_shadow_runs','creator_non_query_shadow_proposals','creator_non_query_shadow_lineage'] LOOP
    EXECUTE format('CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation()',t,t);
  END LOOP;
END $$;

COMMENT ON TABLE creator_non_query_shadow_proposals IS 'Phase 6 counterfactual proposals only; execution propensity and serving authority are permanently zero.';
