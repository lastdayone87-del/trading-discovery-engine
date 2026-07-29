-- Phase 15: expand-first portfolio policy, allocation, and replay evidence.
CREATE TABLE IF NOT EXISTS portfolio_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), policy_key TEXT NOT NULL, version INTEGER NOT NULL,
  policy_type TEXT NOT NULL CHECK(policy_type IN ('FIXED_BEST_FIRST','CONTEXTUAL_BANDIT')),
  status TEXT NOT NULL CHECK(status IN ('DRAFT','APPROVED','CANARY','PAUSED','RETIRED')) DEFAULT 'DRAFT',
  configuration JSONB NOT NULL CHECK(jsonb_typeof(configuration)='object'), configuration_checksum TEXT NOT NULL,
  approved_by TEXT, approved_at TIMESTAMPTZ, created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(policy_key,version), UNIQUE(configuration_checksum)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_portfolio_policy ON portfolio_policies((status)) WHERE status='CANARY';

CREATE TABLE IF NOT EXISTS portfolio_policy_evaluations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), policy_id UUID NOT NULL REFERENCES portfolio_policies(id) ON DELETE RESTRICT,
  evaluation_key TEXT NOT NULL UNIQUE, dataset_version TEXT NOT NULL, estimator_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('PASS','FAIL','ABSTAIN')),
  metrics JSONB NOT NULL CHECK(jsonb_typeof(metrics)='object'), artifact_checksum TEXT NOT NULL,
  evaluated_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER portfolio_policy_evaluations_immutable BEFORE UPDATE OR DELETE ON portfolio_policy_evaluations FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation();

CREATE TABLE IF NOT EXISTS portfolio_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), policy_id UUID NOT NULL REFERENCES portfolio_policies(id) ON DELETE RESTRICT,
  allocation_key TEXT NOT NULL UNIQUE, validity_start TIMESTAMPTZ NOT NULL, validity_end TIMESTAMPTZ NOT NULL,
  provider_capacity JSONB NOT NULL CHECK(jsonb_typeof(provider_capacity)='object'),
  review_capacity INTEGER NOT NULL CHECK(review_capacity>=0), created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK(validity_end>validity_start)
);

CREATE TABLE IF NOT EXISTS portfolio_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), allocation_id UUID NOT NULL REFERENCES portfolio_allocations(id) ON DELETE RESTRICT,
  program_id UUID NOT NULL REFERENCES research_programs(id) ON DELETE RESTRICT,
  action_id UUID NOT NULL REFERENCES frontier_actions(id) ON DELETE RESTRICT,
  decision_key TEXT NOT NULL UNIQUE, selected BOOLEAN NOT NULL, selection_rank INTEGER,
  propensity_basis_points INTEGER NOT NULL CHECK(propensity_basis_points BETWEEN 0 AND 10000),
  context_snapshot JSONB NOT NULL CHECK(jsonb_typeof(context_snapshot)='object'), score_components JSONB NOT NULL CHECK(jsonb_typeof(score_components)='object'),
  constraints_snapshot JSONB NOT NULL CHECK(jsonb_typeof(constraints_snapshot)='object'), opportunity_cost JSONB NOT NULL CHECK(jsonb_typeof(opportunity_cost)='object'),
  policy_version INTEGER NOT NULL, decided_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(allocation_id,action_id)
);
CREATE INDEX IF NOT EXISTS idx_portfolio_decisions_replay ON portfolio_decisions(allocation_id,selection_rank,decision_key);
CREATE TRIGGER portfolio_decisions_immutable BEFORE UPDATE OR DELETE ON portfolio_decisions FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation();

CREATE TABLE IF NOT EXISTS portfolio_policy_transitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), policy_id UUID NOT NULL REFERENCES portfolio_policies(id) ON DELETE RESTRICT,
  transition_key TEXT NOT NULL UNIQUE, from_status TEXT NOT NULL, to_status TEXT NOT NULL,
  actor TEXT NOT NULL, reason TEXT NOT NULL, occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER portfolio_policy_transitions_immutable BEFORE UPDATE OR DELETE ON portfolio_policy_transitions FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation();

COMMENT ON TABLE portfolio_decisions IS 'Immutable Phase 15 selection evidence; workers execute pinned actions and never choose policy.';
