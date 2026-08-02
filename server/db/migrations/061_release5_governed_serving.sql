-- Release 5 / Phases 8-9: governed dashboard and review-eligibility serving cutover.
CREATE TABLE IF NOT EXISTS release5_rollout_activations (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), activation_key TEXT NOT NULL UNIQUE,
 capability TEXT NOT NULL CHECK(capability IN('DASHBOARD_CORPUS','REVIEW_ELIGIBILITY')),
 mode TEXT NOT NULL CHECK(mode IN('CANARY','ACTIVE')), canary_basis_points INTEGER NOT NULL CHECK(canary_basis_points BETWEEN 0 AND 10000),
 promotion_gate_id UUID NOT NULL REFERENCES decision_promotion_gates(id) ON DELETE RESTRICT,
 corpus_policy_version TEXT, eligibility_policy_version TEXT, status TEXT NOT NULL CHECK(status IN('APPROVED','REVOKED')),
 prior_activation_id UUID REFERENCES release5_rollout_activations(id) ON DELETE RESTRICT,
 reason TEXT NOT NULL CHECK(length(trim(reason))>0), activated_by TEXT NOT NULL CHECK(length(trim(activated_by))>0),
 definition_checksum TEXT NOT NULL UNIQUE, activated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_release5_activations_capability ON release5_rollout_activations(capability,activated_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS release5_rollout_projection (
 capability TEXT PRIMARY KEY CHECK(capability IN('DASHBOARD_CORPUS','REVIEW_ELIGIBILITY')),
 activation_id UUID NOT NULL REFERENCES release5_rollout_activations(id) ON DELETE RESTRICT,
 mode TEXT NOT NULL CHECK(mode IN('OFF','CANARY','ACTIVE')), canary_basis_points INTEGER NOT NULL CHECK(canary_basis_points BETWEEN 0 AND 10000),
 promotion_gate_id UUID NOT NULL REFERENCES decision_promotion_gates(id) ON DELETE RESTRICT,
 version INTEGER NOT NULL CHECK(version>0), definition_checksum TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS release5_serving_assignments (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), assignment_key TEXT NOT NULL UNIQUE, capability TEXT NOT NULL,
 channel_id TEXT NOT NULL, activation_id UUID NOT NULL REFERENCES release5_rollout_activations(id) ON DELETE RESTRICT,
 assignment_basis_points INTEGER NOT NULL CHECK(assignment_basis_points BETWEEN 0 AND 10000),
 randomization_value INTEGER NOT NULL CHECK(randomization_value BETWEEN 0 AND 9999), assigned BOOLEAN NOT NULL,
 assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(capability,channel_id,activation_id)
);
CREATE INDEX IF NOT EXISTS idx_release5_assignments_channel ON release5_serving_assignments(capability,channel_id,assigned);
CREATE TABLE IF NOT EXISTS release5_review_materialization_events (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), event_key TEXT NOT NULL UNIQUE, channel_id TEXT NOT NULL,
 eligibility_decision_id UUID NOT NULL REFERENCES review_eligibility_decisions(id) ON DELETE RESTRICT,
 activation_id UUID NOT NULL REFERENCES release5_rollout_activations(id) ON DELETE RESTRICT,
 prior_review_state TEXT, resulting_review_state TEXT NOT NULL, review_version INTEGER NOT NULL CHECK(review_version>0),
 evidence_snapshot JSONB NOT NULL, policy_version TEXT NOT NULL, materialized_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK(jsonb_typeof(evidence_snapshot)='object')
);
CREATE TABLE IF NOT EXISTS release5_control_events (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), event_key TEXT NOT NULL UNIQUE,
 capability TEXT NOT NULL CHECK(capability IN('DASHBOARD_CORPUS','REVIEW_ELIGIBILITY')),
 prior_mode TEXT NOT NULL CHECK(prior_mode IN('OFF','CANARY','ACTIVE')), resulting_mode TEXT NOT NULL CHECK(resulting_mode IN('OFF','CANARY','ACTIVE')),
 activation_id UUID REFERENCES release5_rollout_activations(id) ON DELETE RESTRICT,
 reason TEXT NOT NULL CHECK(length(trim(reason))>0), changed_by TEXT NOT NULL CHECK(length(trim(changed_by))>0), changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
DO $$ DECLARE t TEXT; BEGIN FOREACH t IN ARRAY ARRAY['release5_rollout_activations','release5_serving_assignments','release5_review_materialization_events','release5_control_events'] LOOP
 EXECUTE format('CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation()',t,t);
END LOOP; END $$;
INSERT INTO app_settings(setting_key,setting_value) VALUES
 ('release5_dashboard_serving_mode','OFF'),('release5_review_serving_mode','OFF') ON CONFLICT(setting_key) DO NOTHING;
COMMENT ON TABLE release5_rollout_projection IS 'Repairable activation projection. OFF settings remain an independent emergency kill switch.';
