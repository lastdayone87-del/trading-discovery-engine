-- Phase B: evaluation and creator-focus shadow activation. All decision and
-- serving authority remains with the existing production paths.
CREATE TABLE IF NOT EXISTS creator_type_adjudications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), adjudication_key TEXT NOT NULL UNIQUE,
  channel_id TEXT NOT NULL, review_decision_id UUID REFERENCES channel_review_decisions(id) ON DELETE RESTRICT,
  ground_truth_label_id UUID REFERENCES evaluation_ground_truth_labels(id) ON DELETE RESTRICT,
  creator_type TEXT NOT NULL CHECK(creator_type IN
   ('ACTIVE_TRADING_CREATOR','TRADING_EDUCATOR','INVESTING_EDUCATOR','FINANCIAL_NEWS','PERSONAL_FINANCE',
    'MARKET_INSTITUTION','CORPORATE_BRAND','GAMING_CREATOR','ENTERTAINMENT_CREATOR','TRADING_ADJACENT',
    'INCIDENTAL_TRADING_CONTENT','HYPE_OR_PROMOTION','UNRELATED_OTHER','INSUFFICIENT_EVIDENCE','IDENTITY_DISPUTED')),
  reason_codes JSONB NOT NULL, evidence_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  reviewer_count INTEGER NOT NULL DEFAULT 1 CHECK(reviewer_count>0), disagreement BOOLEAN NOT NULL DEFAULT false,
  label_policy_version TEXT NOT NULL, adjudicated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK(jsonb_typeof(reason_codes)='array'), CHECK(jsonb_array_length(reason_codes)>0), CHECK(jsonb_typeof(evidence_snapshot)='object')
);
CREATE INDEX IF NOT EXISTS idx_creator_type_adjudications_channel ON creator_type_adjudications(channel_id,adjudicated_at DESC);
CREATE INDEX IF NOT EXISTS idx_creator_type_adjudications_type ON creator_type_adjudications(creator_type,adjudicated_at DESC);

CREATE TABLE IF NOT EXISTS evidence_projection_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), observation_key TEXT NOT NULL UNIQUE,
  channel_id TEXT NOT NULL, classification_diagnostic_id UUID REFERENCES production_classification_diagnostics(id) ON DELETE RESTRICT,
  input_checksum TEXT NOT NULL, equivalent BOOLEAN NOT NULL, document_count INTEGER NOT NULL CHECK(document_count>=0),
  assertion_count INTEGER NOT NULL CHECK(assertion_count>=0), projected_evidence_count INTEGER NOT NULL CHECK(projected_evidence_count>=0),
  excluded_evidence_ids JSONB NOT NULL, coverage_persisted BOOLEAN NOT NULL, duration_ms INTEGER NOT NULL CHECK(duration_ms>=0),
  reason_codes JSONB NOT NULL, dual_write_version TEXT NOT NULL, observed_at TIMESTAMPTZ NOT NULL,
  CHECK(jsonb_typeof(excluded_evidence_ids)='array'), CHECK(jsonb_typeof(reason_codes)='array')
);
CREATE INDEX IF NOT EXISTS idx_evidence_projection_observations_diagnostic ON evidence_projection_observations(classification_diagnostic_id,observed_at DESC);

CREATE TABLE IF NOT EXISTS evidence_projection_validation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), validation_key TEXT NOT NULL UNIQUE,
  cutoff_at TIMESTAMPTZ NOT NULL, window_start TIMESTAMPTZ NOT NULL, diagnostic_count INTEGER NOT NULL CHECK(diagnostic_count>=0),
  observed_count INTEGER NOT NULL CHECK(observed_count>=0), equivalent_count INTEGER NOT NULL CHECK(equivalent_count>=0),
  complete_count INTEGER NOT NULL CHECK(complete_count>=0), lineage_count INTEGER NOT NULL CHECK(lineage_count>=0),
  p95_duration_ms INTEGER NOT NULL CHECK(p95_duration_ms>=0), status TEXT NOT NULL CHECK(status IN('PASS','FAIL','INSUFFICIENT_EVIDENCE')),
  metrics JSONB NOT NULL, reason_codes JSONB NOT NULL, policy_version TEXT NOT NULL, created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), CHECK(jsonb_typeof(metrics)='object'), CHECK(jsonb_typeof(reason_codes)='array')
);

CREATE TABLE IF NOT EXISTS phase_b_shadow_control_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), event_key TEXT NOT NULL UNIQUE,
  control TEXT NOT NULL CHECK(control IN('EVALUATION_SAMPLING','EVIDENCE_DOCUMENTS','EVIDENCE_ASSERTIONS','CREATOR_FOCUS_SHADOW')),
  prior_value TEXT NOT NULL, resulting_value TEXT NOT NULL, validation_run_id UUID REFERENCES evidence_projection_validation_runs(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL, changed_by TEXT NOT NULL, policy_version TEXT NOT NULL, changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ DECLARE t TEXT; BEGIN FOREACH t IN ARRAY ARRAY['creator_type_adjudications','evidence_projection_observations','evidence_projection_validation_runs','phase_b_shadow_control_events'] LOOP
 EXECUTE format('CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation()',t,t);
END LOOP; END $$;

INSERT INTO app_settings(setting_key,setting_value) VALUES
 ('decision_evaluation_sampling_enabled','true'),
 ('evidence_document_dual_write_enabled','true'),
 ('evidence_assertion_dual_write_enabled','false'),
 ('creator_focus_classifier_mode','SHADOW')
ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value;

INSERT INTO phase_b_shadow_control_events(event_key,control,prior_value,resulting_value,reason,changed_by,policy_version) VALUES
 ('phase-b:sampling:enabled','EVALUATION_SAMPLING','false','true','Approved Phase B propensity-aware evaluation sampling','migration-063','phase-b-shadow-v1'),
 ('phase-b:documents:enabled','EVIDENCE_DOCUMENTS','false','true','Approved Phase B evidence-document observational dual-write','migration-063','phase-b-shadow-v1'),
 ('phase-b:creator-focus:shadow','CREATOR_FOCUS_SHADOW','OFF','SHADOW','Approved Phase B non-authoritative Creator Focus observation','migration-063','phase-b-shadow-v1')
ON CONFLICT(event_key) DO NOTHING;

COMMENT ON TABLE creator_type_adjudications IS 'Immutable evaluation-only creator-type labels; no classification or serving authority.';
COMMENT ON TABLE evidence_projection_validation_runs IS 'Immutable Phase B document projection gates; PASS does not activate serving authority.';
