-- Release 4 / Phase 6: separate dashboard corpora without changing legacy serving.
CREATE TABLE IF NOT EXISTS dashboard_corpus_decisions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), decision_key TEXT NOT NULL UNIQUE,
 channel_id TEXT NOT NULL, admission_decision_id UUID REFERENCES channel_admission_decisions(id) ON DELETE RESTRICT,
 admission_state TEXT NOT NULL, corpus TEXT NOT NULL CHECK(corpus IN
 ('DISCOVERY_CANDIDATES','INVESTIGATING','REVIEW','CONFIRMED','WITHHELD')),
 reason_codes JSONB NOT NULL, input_snapshot JSONB NOT NULL, input_checksum TEXT NOT NULL,
 policy_version TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN('SHADOW','CANARY')),
 assignment_basis_points INTEGER NOT NULL CHECK(assignment_basis_points BETWEEN 0 AND 10000),
 randomization_value INTEGER NOT NULL CHECK(randomization_value BETWEEN 0 AND 9999), assigned BOOLEAN NOT NULL,
 serving_authority BOOLEAN NOT NULL CHECK(serving_authority=false), decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK(jsonb_typeof(reason_codes)='array'), CHECK(jsonb_typeof(input_snapshot)='object')
);
CREATE INDEX IF NOT EXISTS idx_dashboard_corpus_decisions_channel ON dashboard_corpus_decisions(channel_id,decided_at DESC);
CREATE TABLE IF NOT EXISTS dashboard_corpus_events (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), event_key TEXT NOT NULL UNIQUE,
 channel_id TEXT NOT NULL, decision_id UUID NOT NULL REFERENCES dashboard_corpus_decisions(id) ON DELETE RESTRICT,
 expected_projection_version INTEGER NOT NULL CHECK(expected_projection_version>=0), payload JSONB NOT NULL,
 policy_version TEXT NOT NULL, occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(), CHECK(jsonb_typeof(payload)='object')
);
CREATE INDEX IF NOT EXISTS idx_dashboard_corpus_events_replay ON dashboard_corpus_events(channel_id,occurred_at,id);
CREATE TABLE IF NOT EXISTS dashboard_corpus_projection (
 channel_id TEXT PRIMARY KEY, corpus TEXT NOT NULL CHECK(corpus IN
 ('DISCOVERY_CANDIDATES','INVESTIGATING','REVIEW','CONFIRMED','WITHHELD')),
 version INTEGER NOT NULL CHECK(version>0), decision_id UUID NOT NULL REFERENCES dashboard_corpus_decisions(id) ON DELETE RESTRICT,
 admission_state TEXT NOT NULL, reason_codes JSONB NOT NULL, evidence_checksum TEXT NOT NULL,
 policy_version TEXT NOT NULL, decided_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK(jsonb_typeof(reason_codes)='array')
);
CREATE INDEX IF NOT EXISTS idx_dashboard_corpus_projection_corpus ON dashboard_corpus_projection(corpus,updated_at DESC);
DO $$ DECLARE t TEXT; BEGIN FOREACH t IN ARRAY ARRAY['dashboard_corpus_decisions','dashboard_corpus_events'] LOOP
 EXECUTE format('CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation()',t,t);
END LOOP; END $$;
INSERT INTO app_settings(setting_key,setting_value) VALUES
 ('dashboard_corpus_mode','OFF'),('dashboard_corpus_canary_basis_points','0') ON CONFLICT(setting_key) DO NOTHING;
COMMENT ON TABLE dashboard_corpus_projection IS 'Repairable shadow projection. Release 4 does not replace the legacy dashboard predicate.';
