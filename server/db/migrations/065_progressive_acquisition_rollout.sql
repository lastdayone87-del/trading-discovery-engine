-- Phase D extends the existing Release 5 rollout plane. Both capabilities are
-- disabled until an operator activates a passing promotion gate and kill switch.
ALTER TABLE release5_rollout_activations DROP CONSTRAINT IF EXISTS release5_rollout_activations_capability_check;
ALTER TABLE release5_rollout_activations ADD CONSTRAINT release5_rollout_activations_capability_check CHECK(capability IN
 ('DASHBOARD_CORPUS','REVIEW_ELIGIBILITY','CREATOR_FOCUS_ADVISORY','INVESTIGATION_WORKFLOW','VOI_EVIDENCE_ACTIONS'));
ALTER TABLE release5_rollout_projection DROP CONSTRAINT IF EXISTS release5_rollout_projection_capability_check;
ALTER TABLE release5_rollout_projection ADD CONSTRAINT release5_rollout_projection_capability_check CHECK(capability IN
 ('DASHBOARD_CORPUS','REVIEW_ELIGIBILITY','CREATOR_FOCUS_ADVISORY','INVESTIGATION_WORKFLOW','VOI_EVIDENCE_ACTIONS'));
ALTER TABLE release5_control_events DROP CONSTRAINT IF EXISTS release5_control_events_capability_check;
ALTER TABLE release5_control_events ADD CONSTRAINT release5_control_events_capability_check CHECK(capability IN
 ('DASHBOARD_CORPUS','REVIEW_ELIGIBILITY','CREATOR_FOCUS_ADVISORY','INVESTIGATION_WORKFLOW','VOI_EVIDENCE_ACTIONS'));

CREATE TABLE IF NOT EXISTS voi_calibration_runs (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), calibration_key TEXT NOT NULL UNIQUE,
 cutoff_at TIMESTAMPTZ NOT NULL, window_start TIMESTAMPTZ NOT NULL,
 segment_definition JSONB NOT NULL, action_metrics JSONB NOT NULL,
 minimum_outcomes INTEGER NOT NULL CHECK(minimum_outcomes>0), outcome_count INTEGER NOT NULL CHECK(outcome_count>=0),
 status TEXT NOT NULL CHECK(status IN('APPROVED','INSUFFICIENT_EVIDENCE')),
 policy_version TEXT NOT NULL, created_by TEXT NOT NULL CHECK(length(trim(created_by))>0), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK(window_start<cutoff_at), CHECK(jsonb_typeof(segment_definition)='object'), CHECK(jsonb_typeof(action_metrics)='object')
);
CREATE TRIGGER voi_calibration_runs_immutable BEFORE UPDATE OR DELETE ON voi_calibration_runs
 FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation();

INSERT INTO app_settings(setting_key,setting_value) VALUES
 ('release5_investigation_workflow_mode','OFF'),('release5_voi_evidence_actions_mode','OFF')
ON CONFLICT(setting_key) DO NOTHING;
COMMENT ON TABLE voi_calibration_runs IS 'Immutable observed-outcome calibration; cannot activate VOI or make classification decisions.';
