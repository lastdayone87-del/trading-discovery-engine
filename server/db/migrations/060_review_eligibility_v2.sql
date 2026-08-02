-- Release 4 / Phase 7: immutable, replayable review eligibility v2.
CREATE TABLE IF NOT EXISTS review_eligibility_decisions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), decision_key TEXT NOT NULL UNIQUE,
 channel_id TEXT NOT NULL, classification_diagnostic_id UUID REFERENCES production_classification_diagnostics(id) ON DELETE RESTRICT,
 investigation_id UUID REFERENCES investigations(id) ON DELETE RESTRICT,
 creator_focus_snapshot_id UUID REFERENCES creator_focus_classification_snapshots(id) ON DELETE RESTRICT,
 status TEXT NOT NULL CHECK(status IN('ELIGIBLE','NOT_ELIGIBLE','DEFERRED')),
 reason_codes JSONB NOT NULL, input_snapshot JSONB NOT NULL, input_checksum TEXT NOT NULL,
 policy_version TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN('SHADOW','CANARY')),
 assignment_basis_points INTEGER NOT NULL CHECK(assignment_basis_points BETWEEN 0 AND 10000),
 randomization_value INTEGER NOT NULL CHECK(randomization_value BETWEEN 0 AND 9999), assigned BOOLEAN NOT NULL,
 serving_authority BOOLEAN NOT NULL CHECK(serving_authority=false), decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK(jsonb_typeof(reason_codes)='array'), CHECK(jsonb_typeof(input_snapshot)='object')
);
CREATE INDEX IF NOT EXISTS idx_review_eligibility_channel ON review_eligibility_decisions(channel_id,decided_at DESC);
CREATE TABLE IF NOT EXISTS review_eligibility_events (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), event_key TEXT NOT NULL UNIQUE, channel_id TEXT NOT NULL,
 decision_id UUID NOT NULL REFERENCES review_eligibility_decisions(id) ON DELETE RESTRICT,
 expected_projection_version INTEGER NOT NULL CHECK(expected_projection_version>=0), payload JSONB NOT NULL,
 policy_version TEXT NOT NULL, occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(), CHECK(jsonb_typeof(payload)='object')
);
CREATE INDEX IF NOT EXISTS idx_review_eligibility_events_replay ON review_eligibility_events(channel_id,occurred_at,id);
CREATE TABLE IF NOT EXISTS review_eligibility_projection (
 channel_id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN('ELIGIBLE','NOT_ELIGIBLE','DEFERRED')),
 version INTEGER NOT NULL CHECK(version>0), decision_id UUID NOT NULL REFERENCES review_eligibility_decisions(id) ON DELETE RESTRICT,
 reason_codes JSONB NOT NULL, evidence_checksum TEXT NOT NULL, policy_version TEXT NOT NULL,
 decided_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), CHECK(jsonb_typeof(reason_codes)='array')
);
CREATE INDEX IF NOT EXISTS idx_review_eligibility_projection_status ON review_eligibility_projection(status,updated_at DESC);
DO $$ DECLARE t TEXT; BEGIN FOREACH t IN ARRAY ARRAY['review_eligibility_decisions','review_eligibility_events'] LOOP
 EXECUTE format('CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation()',t,t);
END LOOP; END $$;
INSERT INTO app_settings(setting_key,setting_value) VALUES
 ('review_eligibility_v2_mode','OFF'),('review_eligibility_v2_canary_basis_points','0') ON CONFLICT(setting_key) DO NOTHING;
COMMENT ON TABLE review_eligibility_projection IS 'Repairable v2 shadow projection; it cannot create or mutate channel_reviews in Release 4.';
