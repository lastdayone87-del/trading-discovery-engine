-- Release 3 / Phase 4: creator-focus classifier v4 shadow control plane.
CREATE TABLE IF NOT EXISTS creator_focus_policy_versions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), policy_key TEXT NOT NULL, version INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN('DRAFT','APPROVED','RETIRED')), definition JSONB NOT NULL,
 definition_checksum TEXT NOT NULL UNIQUE, calibration_artifact_id UUID REFERENCES calibration_artifacts(id) ON DELETE RESTRICT,
 created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(policy_key,version)
);
CREATE TABLE IF NOT EXISTS creator_focus_classification_snapshots (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), snapshot_key TEXT NOT NULL UNIQUE,
 channel_id TEXT NOT NULL, subject_entity_id UUID NOT NULL,
 classification_diagnostic_id UUID NOT NULL REFERENCES production_classification_diagnostics(id) ON DELETE RESTRICT,
 evidence_coverage_snapshot_id UUID REFERENCES evidence_coverage_snapshots(id) ON DELETE RESTRICT,
 input_checksum TEXT NOT NULL, document_keys JSONB NOT NULL, assertion_keys JSONB NOT NULL,
 document_assertions JSONB NOT NULL, creator_focus_distribution JSONB NOT NULL,
 stage_report JSONB NOT NULL, proposed_status TEXT NOT NULL CHECK(proposed_status IN('TRADING_CONFIRMED','NON_TRADING','UNCERTAIN')),
 effective_status TEXT NOT NULL CHECK(effective_status='UNCERTAIN'), probability DOUBLE PRECISION NOT NULL CHECK(probability BETWEEN 0 AND 1),
 lower_confidence_bound DOUBLE PRECISION NOT NULL CHECK(lower_confidence_bound BETWEEN 0 AND 1),
 admission_recommendation JSONB NOT NULL, reason_codes JSONB NOT NULL,
 classifier_version TEXT NOT NULL, policy_version TEXT NOT NULL,
 calibration_artifact_id UUID REFERENCES calibration_artifacts(id) ON DELETE RESTRICT,
 mode TEXT NOT NULL CHECK(mode IN('SHADOW','CANARY')), assignment_basis_points INTEGER NOT NULL CHECK(assignment_basis_points BETWEEN 0 AND 10000),
 randomization_value INTEGER NOT NULL CHECK(randomization_value BETWEEN 0 AND 9999), assigned BOOLEAN NOT NULL,
 observed_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK(jsonb_typeof(document_keys)='array'), CHECK(jsonb_typeof(assertion_keys)='array'),
 CHECK(jsonb_typeof(document_assertions)='array'), CHECK(jsonb_typeof(creator_focus_distribution)='object'),
 CHECK(jsonb_typeof(stage_report)='object'), CHECK(jsonb_typeof(admission_recommendation)='object'), CHECK(jsonb_typeof(reason_codes)='array')
);
CREATE INDEX IF NOT EXISTS idx_creator_focus_channel ON creator_focus_classification_snapshots(channel_id,observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_creator_focus_proposed ON creator_focus_classification_snapshots(proposed_status,observed_at DESC);
DO $$ DECLARE t TEXT; BEGIN FOREACH t IN ARRAY ARRAY['creator_focus_policy_versions','creator_focus_classification_snapshots'] LOOP
 EXECUTE format('CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation()',t,t);
END LOOP; END $$;
INSERT INTO creator_focus_policy_versions(policy_key,version,status,definition,definition_checksum,created_by)
VALUES('creator-focus-v4',1,'DRAFT','{"automaticTerminalAuthority":false,"minimumIndependentFamilies":2,"minimumRecentDocuments":2,"precisionFirst":true}','creator-focus-policy-v4-draft-1','migration-057') ON CONFLICT DO NOTHING;
INSERT INTO app_settings(setting_key,setting_value) VALUES
 ('creator_focus_classifier_mode','OFF'),('creator_focus_classifier_canary_basis_points','0')
ON CONFLICT(setting_key) DO NOTHING;
COMMENT ON TABLE creator_focus_classification_snapshots IS 'Immutable classifier-v4 shadow output. effective_status is forced UNCERTAIN until a later governed serving release.';
