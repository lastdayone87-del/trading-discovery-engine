-- Phase 6: sealed offline replay, causal evaluation and atomic activation governance.
ALTER TABLE research_control ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS research_configuration_events (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), event_key TEXT NOT NULL UNIQUE,
 configuration_version INTEGER NOT NULL, prior_configuration JSONB NOT NULL, next_configuration JSONB NOT NULL,
 actor TEXT NOT NULL, reason TEXT NOT NULL, occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS research_replay_datasets (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), dataset_key TEXT NOT NULL UNIQUE,
 cutoff TIMESTAMPTZ NOT NULL, action_snapshots JSONB NOT NULL, outcome_snapshots JSONB NOT NULL,
 dataset_checksum TEXT NOT NULL, sealed BOOLEAN NOT NULL DEFAULT true CHECK(sealed),
 created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS research_replay_action_decisions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), decision_key TEXT NOT NULL UNIQUE,
 replay_run_id UUID NOT NULL REFERENCES research_policy_replay_runs(id) ON DELETE RESTRICT,
 policy_arm TEXT NOT NULL CHECK(policy_arm IN('CANDIDATE','BASELINE')),
 action_id UUID NOT NULL REFERENCES discovery_actions(id) ON DELETE RESTRICT,
 selected BOOLEAN NOT NULL, propensity_basis_points INTEGER NOT NULL CHECK(propensity_basis_points BETWEEN 1 AND 10000),
 utility DOUBLE PRECISION NOT NULL, reward DOUBLE PRECISION NOT NULL, overlap_correction DOUBLE PRECISION NOT NULL,
 coordinates JSONB NOT NULL, reason_codes JSONB NOT NULL
);
ALTER TABLE research_policy_replay_runs ADD COLUMN IF NOT EXISTS dataset_id UUID REFERENCES research_replay_datasets(id) ON DELETE RESTRICT;
ALTER TABLE research_policy_replay_runs ADD COLUMN IF NOT EXISTS confidence_interval JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE research_policy_replay_runs ADD COLUMN IF NOT EXISTS segment_guardrails JSONB NOT NULL DEFAULT '{}'::jsonb;
DO $$ DECLARE t TEXT; BEGIN FOREACH t IN ARRAY ARRAY['research_configuration_events','research_replay_datasets','research_replay_action_decisions'] LOOP EXECUTE format('CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation()',t,t); END LOOP; END $$;
