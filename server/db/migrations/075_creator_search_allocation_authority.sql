-- Phase 5 transfers only top-level SEARCH_YOUTUBE Program allocation. Query
-- specification and every provider-facing responsibility remain external.
ALTER TABLE creator_search_canary_control
  ADD COLUMN IF NOT EXISTS top_level_authority_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE creator_search_canary_control
  ADD CONSTRAINT creator_search_top_level_authority_bounded CHECK(
    NOT top_level_authority_enabled OR
    (enabled AND serving_authority_enabled AND NOT kill_switch AND rollout_basis_points>0 AND global_daily_allocation_cap>0 AND global_daily_quota_cap>0)
  );

CREATE TABLE IF NOT EXISTS creator_search_program_authority_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_key TEXT NOT NULL UNIQUE,
  opportunity_key TEXT NOT NULL,
  program_id UUID NOT NULL REFERENCES research_programs(id) ON DELETE RESTRICT,
  objective_key TEXT NOT NULL,
  objective_version INTEGER NOT NULL CHECK(objective_version>0),
  hypothesis_id UUID NOT NULL REFERENCES discovery_hypotheses(id) ON DELETE RESTRICT,
  country TEXT NOT NULL,
  lifecycle_decision TEXT NOT NULL CHECK(lifecycle_decision IN('ACTIVE','SLEEP','STOP','REACTIVATE')),
  frontier_priority DOUBLE PRECISION NOT NULL,
  provider_budget_remaining INTEGER NOT NULL CHECK(provider_budget_remaining>=0),
  daily_allocation_remaining INTEGER NOT NULL CHECK(daily_allocation_remaining>=0),
  frontier_snapshot_id UUID NOT NULL REFERENCES creator_frontier_shadow_snapshots(id) ON DELETE RESTRICT,
  readiness_run_id UUID NOT NULL REFERENCES creator_readiness_shadow_runs(id) ON DELETE RESTRICT,
  evidence_checksum TEXT NOT NULL CHECK(evidence_checksum~'^[a-f0-9]{64}$'),
  reason_codes JSONB NOT NULL CHECK(jsonb_typeof(reason_codes)='array'),
  policy_version TEXT NOT NULL,
  serving_authority BOOLEAN NOT NULL DEFAULT false CHECK(serving_authority=false),
  decided_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS creator_search_authority_program_time_idx ON creator_search_program_authority_decisions(program_id,decided_at DESC);
CREATE INDEX IF NOT EXISTS creator_search_authority_opportunity_idx ON creator_search_program_authority_decisions(opportunity_key);

CREATE TABLE IF NOT EXISTS creator_search_authority_assignment_links (
  link_key TEXT PRIMARY KEY,
  authority_decision_id UUID NOT NULL UNIQUE REFERENCES creator_search_program_authority_decisions(id) ON DELETE RESTRICT,
  canary_assignment_id UUID NOT NULL UNIQUE REFERENCES creator_search_canary_assignments(id) ON DELETE RESTRICT,
  legacy_country TEXT NOT NULL,
  treatment_country TEXT NOT NULL,
  executed_country TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  linked_at TIMESTAMPTZ NOT NULL
);

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['creator_search_program_authority_decisions','creator_search_authority_assignment_links'] LOOP
    EXECUTE format('CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation()',t,t);
  END LOOP;
END $$;

COMMENT ON TABLE creator_search_program_authority_decisions IS 'Phase 5 Program/Objective/Hypothesis and lifecycle priority only; never a query specification or acquisition action.';
