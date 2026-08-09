-- Phase 3.5 is an informational shadow plane. It cannot schedule, enqueue,
-- select queries, execute providers, or grant serving authority.
CREATE TABLE IF NOT EXISTS creator_readiness_shadow_control (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton),
  enabled BOOLEAN NOT NULL DEFAULT false,
  mode TEXT NOT NULL DEFAULT 'SHADOW' CHECK(mode='SHADOW'),
  minimum_sample_size INTEGER NOT NULL DEFAULT 30 CHECK(minimum_sample_size>0),
  maximum_evidence_age_hours INTEGER NOT NULL DEFAULT 48 CHECK(maximum_evidence_age_hours>0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT NOT NULL DEFAULT 'system:migration'
);
INSERT INTO creator_readiness_shadow_control(singleton) VALUES(true) ON CONFLICT(singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS creator_program_allocation_shadow_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_key TEXT NOT NULL UNIQUE,
  cutoff_at TIMESTAMPTZ NOT NULL,
  projection_version TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  input_checksum TEXT NOT NULL CHECK(input_checksum~'^[a-f0-9]{64}$'),
  output_checksum TEXT NOT NULL CHECK(output_checksum~'^[a-f0-9]{64}$'),
  opportunity_count INTEGER NOT NULL CHECK(opportunity_count>=0),
  decision_count INTEGER NOT NULL CHECK(decision_count=opportunity_count),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS creator_program_allocation_shadow_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  allocation_key TEXT NOT NULL,
  allocation_run_id UUID NOT NULL REFERENCES creator_program_allocation_shadow_runs(id) ON DELETE RESTRICT,
  scheduling_opportunity_key TEXT NOT NULL,
  actual_query_run_id UUID NOT NULL REFERENCES query_runs(id) ON DELETE RESTRICT,
  country TEXT NOT NULL,
  program_id UUID REFERENCES research_programs(id) ON DELETE RESTRICT,
  objective_key TEXT,
  objective_version INTEGER CHECK(objective_version IS NULL OR objective_version>0),
  hypothesis_id UUID REFERENCES discovery_hypotheses(id) ON DELETE RESTRICT,
  disposition TEXT NOT NULL CHECK(disposition IN('ALLOCATED','ABSTAIN')),
  reason_codes JSONB NOT NULL CHECK(jsonb_typeof(reason_codes)='array'),
  supporting_evidence JSONB NOT NULL CHECK(jsonb_typeof(supporting_evidence)='array'),
  eligible_program_keys JSONB NOT NULL CHECK(jsonb_typeof(eligible_program_keys)='array'),
  behavior_propensity_basis_points INTEGER NOT NULL CHECK(behavior_propensity_basis_points BETWEEN 1 AND 10000),
  target_propensity_basis_points INTEGER NOT NULL CHECK(target_propensity_basis_points BETWEEN 0 AND 10000),
  randomization_value INTEGER NOT NULL CHECK(randomization_value BETWEEN 0 AND 9999),
  policy_version TEXT NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL,
  serving_authority BOOLEAN NOT NULL DEFAULT false CHECK(serving_authority=false),
  CHECK((disposition='ALLOCATED' AND program_id IS NOT NULL AND objective_key IS NOT NULL AND objective_version IS NOT NULL AND hypothesis_id IS NOT NULL) OR
        (disposition='ABSTAIN' AND program_id IS NULL AND objective_key IS NULL AND objective_version IS NULL AND hypothesis_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS creator_allocation_one_decision_per_opportunity
  ON creator_program_allocation_shadow_decisions(allocation_run_id,scheduling_opportunity_key);
CREATE UNIQUE INDEX IF NOT EXISTS creator_allocation_run_key_unique
  ON creator_program_allocation_shadow_decisions(allocation_run_id,allocation_key);

CREATE TABLE IF NOT EXISTS creator_assignment_shadow_lineage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lineage_key TEXT NOT NULL UNIQUE,
  allocation_id UUID NOT NULL REFERENCES creator_program_allocation_shadow_decisions(id) ON DELETE RESTRICT,
  actual_query_run_id UUID NOT NULL REFERENCES query_runs(id) ON DELETE RESTRICT,
  outcome_projection_run_id UUID REFERENCES creator_outcome_projection_runs(id) ON DELETE RESTRICT,
  outcome_ids JSONB NOT NULL CHECK(jsonb_typeof(outcome_ids)='array'),
  coverage_projection_run_ids JSONB NOT NULL CHECK(jsonb_typeof(coverage_projection_run_ids)='array'),
  coverage_snapshot_ids JSONB NOT NULL CHECK(jsonb_typeof(coverage_snapshot_ids)='array'),
  coverage_changes JSONB NOT NULL CHECK(jsonb_typeof(coverage_changes)='array'),
  expected_outcome_count INTEGER NOT NULL CHECK(expected_outcome_count>=0),
  attributed_outcome_count INTEGER NOT NULL CHECK(attributed_outcome_count>=0 AND attributed_outcome_count<=expected_outcome_count),
  attribution_completeness DOUBLE PRECISION NOT NULL CHECK(attribution_completeness BETWEEN 0 AND 1),
  source_checksum TEXT NOT NULL CHECK(source_checksum~'^[a-f0-9]{64}$'),
  policy_version TEXT NOT NULL,
  as_of TIMESTAMPTZ NOT NULL,
  serving_authority BOOLEAN NOT NULL DEFAULT false CHECK(serving_authority=false)
);

CREATE TABLE IF NOT EXISTS creator_guardrail_shadow_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_key TEXT NOT NULL UNIQUE,
  allocation_run_id UUID NOT NULL REFERENCES creator_program_allocation_shadow_runs(id) ON DELETE RESTRICT,
  metric TEXT NOT NULL CHECK(metric IN('COUNTRY_PRECISION','TRADING_PRECISION','VERIFIED_CREATOR_YIELD','ACTIVE_VERIFIED_CREATOR_YIELD','REVIEW_BURDEN','INACTIVE_CREATOR_RATE','PROVIDER_COST','QUOTA_CONSUMPTION')),
  numerator DOUBLE PRECISION NOT NULL CHECK(numerator>=0),
  denominator DOUBLE PRECISION NOT NULL CHECK(denominator>=0),
  metric_value DOUBLE PRECISION,
  attribution_completeness DOUBLE PRECISION NOT NULL CHECK(attribution_completeness BETWEEN 0 AND 1),
  maturity_policy TEXT NOT NULL,
  observation_from TIMESTAMPTZ NOT NULL,
  observation_to TIMESTAMPTZ NOT NULL CHECK(observation_to>=observation_from),
  latest_evidence_at TIMESTAMPTZ,
  sample_size INTEGER NOT NULL CHECK(sample_size>=0),
  effective_sample_size DOUBLE PRECISION NOT NULL CHECK(effective_sample_size>=0),
  confidence_lower DOUBLE PRECISION,
  confidence_upper DOUBLE PRECISION,
  result TEXT NOT NULL CHECK(result IN('PASS','FAIL','ABSTAIN')),
  reason_codes JSONB NOT NULL CHECK(jsonb_typeof(reason_codes)='array'),
  policy_version TEXT NOT NULL,
  serving_authority BOOLEAN NOT NULL DEFAULT false CHECK(serving_authority=false),
  UNIQUE(allocation_run_id,metric)
);

CREATE TABLE IF NOT EXISTS creator_readiness_shadow_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  readiness_key TEXT NOT NULL UNIQUE,
  cutoff_at TIMESTAMPTZ NOT NULL,
  outcome_projection_run_id UUID REFERENCES creator_outcome_projection_runs(id) ON DELETE RESTRICT,
  allocation_run_id UUID REFERENCES creator_program_allocation_shadow_runs(id) ON DELETE RESTRICT,
  result TEXT NOT NULL CHECK(result IN('PASS','FAIL','ABSTAIN')),
  reason_codes JSONB NOT NULL CHECK(jsonb_typeof(reason_codes)='array'),
  checks JSONB NOT NULL CHECK(jsonb_typeof(checks)='object'),
  input_checksum TEXT NOT NULL CHECK(input_checksum~'^[a-f0-9]{64}$'),
  output_checksum TEXT NOT NULL CHECK(output_checksum~'^[a-f0-9]{64}$'),
  policy_version TEXT NOT NULL,
  serving_authority BOOLEAN NOT NULL DEFAULT false CHECK(serving_authority=false),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS creator_readiness_shadow_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key TEXT NOT NULL UNIQUE,
  cutoff_at TIMESTAMPTZ NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN('RUN_COMPLETED','RUN_ABSTAINED')),
  result TEXT NOT NULL CHECK(result IN('PASS','FAIL','ABSTAIN')),
  reason_codes JSONB NOT NULL CHECK(jsonb_typeof(reason_codes)='array'),
  detail JSONB NOT NULL CHECK(jsonb_typeof(detail)='object'),
  policy_version TEXT NOT NULL,
  serving_authority BOOLEAN NOT NULL DEFAULT false CHECK(serving_authority=false),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY[
    'creator_program_allocation_shadow_runs','creator_program_allocation_shadow_decisions',
    'creator_assignment_shadow_lineage','creator_guardrail_shadow_snapshots',
    'creator_readiness_shadow_runs','creator_readiness_shadow_events'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation()',t,t);
  END LOOP;
END $$;

COMMENT ON TABLE creator_readiness_shadow_runs IS 'Informational Phase 3.5 readiness only; PASS cannot activate or authorize production behavior.';
