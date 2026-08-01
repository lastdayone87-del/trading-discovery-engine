-- Shared utility contract and value-of-information evidence acquisition.
-- OFF by default; SHADOW records counterfactual choices; CANARY may choose only
-- the registered enrichment actions already supported by the production worker.

CREATE TABLE IF NOT EXISTS utility_policy_versions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), policy_key TEXT NOT NULL, version INTEGER NOT NULL,
 contract_version TEXT NOT NULL, definition JSONB NOT NULL, checksum TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL CHECK(status IN('APPROVED','RETIRED')), created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(policy_key,version)
);
CREATE TABLE IF NOT EXISTS evidence_action_definitions (
 action_key TEXT PRIMARY KEY, version INTEGER NOT NULL, enrichment_stage SMALLINT,
 provider_cost INTEGER NOT NULL CHECK(provider_cost>=0), review_cost INTEGER NOT NULL CHECK(review_cost>=0),
 latency_ms INTEGER NOT NULL CHECK(latency_ms>=0), resolves JSONB NOT NULL, governed BOOLEAN NOT NULL,
 definition_checksum TEXT NOT NULL UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS evidence_acquisition_decisions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), decision_key TEXT NOT NULL UNIQUE, channel_id TEXT NOT NULL,
 classification_diagnostic_id UUID REFERENCES production_classification_diagnostics(id) ON DELETE RESTRICT,
 mode TEXT NOT NULL CHECK(mode IN('SHADOW','CANARY')), policy_version TEXT NOT NULL, utility_contract_version TEXT NOT NULL,
 gaps JSONB NOT NULL, eligible_actions JSONB NOT NULL, selected_action TEXT NOT NULL REFERENCES evidence_action_definitions(action_key),
 legacy_action TEXT NOT NULL REFERENCES evidence_action_definitions(action_key), applied_action TEXT NOT NULL REFERENCES evidence_action_definitions(action_key),
 assignment_basis_points INTEGER NOT NULL CHECK(assignment_basis_points BETWEEN 0 AND 10000), randomization_value INTEGER NOT NULL CHECK(randomization_value BETWEEN 0 AND 9999), controller_assigned BOOLEAN NOT NULL,
 reason_codes JSONB NOT NULL, decision_checksum TEXT NOT NULL, decided_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_evidence_acquisition_decisions_channel ON evidence_acquisition_decisions(channel_id,decided_at DESC);
CREATE TABLE IF NOT EXISTS evidence_acquisition_outcomes (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), outcome_key TEXT NOT NULL UNIQUE,
 decision_id UUID NOT NULL REFERENCES evidence_acquisition_decisions(id) ON DELETE RESTRICT,
 job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT, attempt INTEGER NOT NULL CHECK(attempt>=0),
 status TEXT NOT NULL CHECK(status IN('SUCCEEDED','FAILED','SKIPPED')), resulting_status TEXT,
 provider_cost INTEGER NOT NULL CHECK(provider_cost>=0), latency_ms INTEGER NOT NULL CHECK(latency_ms>=0), reason_code TEXT NOT NULL,
 completed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
DO $$ DECLARE t TEXT; BEGIN FOREACH t IN ARRAY ARRAY['utility_policy_versions','evidence_action_definitions','evidence_acquisition_decisions','evidence_acquisition_outcomes'] LOOP EXECUTE format('CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation()',t,t); END LOOP; END $$;
INSERT INTO utility_policy_versions(policy_key,version,contract_version,definition,checksum,status,created_by) VALUES('evidence-acquisition',1,'utility-constraints-v1','{"precisionIsConstraint":true,"caseQuotaCap":303,"latencyDeadlineMs":10000}','voi-utility-policy-v1','APPROVED','migration-038') ON CONFLICT DO NOTHING;
INSERT INTO evidence_action_definitions(action_key,version,enrichment_stage,provider_cost,review_cost,latency_ms,resolves,governed,definition_checksum) VALUES
('CHANNEL_RECENT_METADATA',1,1,101,0,2500,'["METADATA_MISSING","METADATA_SPARSE","PROVIDER_DEGRADED","SEMANTIC_CANDIDATE_MISSING"]',true,'action-channel-recent-v1'),
('VIDEO_PLAYLIST_CORROBORATION',1,2,202,0,5000,'["CORROBORATION_MISSING","SEMANTIC_CANDIDATE_MISSING","UNSUPPORTED_LANGUAGE","DECISION_AMBIGUOUS"]',true,'action-video-playlist-v1'),
('HUMAN_REVIEW',1,NULL,0,1,0,'["METADATA_MISSING","METADATA_SPARSE","PROVIDER_DEGRADED","SEMANTIC_CANDIDATE_MISSING","CORROBORATION_MISSING","UNSUPPORTED_LANGUAGE","DECISION_AMBIGUOUS"]',true,'action-review-v1') ON CONFLICT DO NOTHING;
INSERT INTO app_settings(setting_key,setting_value) VALUES('voi_evidence_controller_mode','OFF') ON CONFLICT(setting_key) DO NOTHING;
INSERT INTO app_settings(setting_key,setting_value) VALUES('voi_evidence_canary_basis_points','0') ON CONFLICT(setting_key) DO NOTHING;
