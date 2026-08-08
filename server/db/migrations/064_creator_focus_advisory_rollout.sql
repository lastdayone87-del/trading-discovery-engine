-- Phase C: extend the existing Release 5 rollout plane with a non-authoritative
-- Creator Focus advisory canary. Production classification remains unchanged.
ALTER TABLE release5_rollout_activations DROP CONSTRAINT IF EXISTS release5_rollout_activations_capability_check;
ALTER TABLE release5_rollout_activations ADD CONSTRAINT release5_rollout_activations_capability_check
 CHECK(capability IN('DASHBOARD_CORPUS','REVIEW_ELIGIBILITY','CREATOR_FOCUS_ADVISORY'));
ALTER TABLE release5_rollout_projection DROP CONSTRAINT IF EXISTS release5_rollout_projection_capability_check;
ALTER TABLE release5_rollout_projection ADD CONSTRAINT release5_rollout_projection_capability_check
 CHECK(capability IN('DASHBOARD_CORPUS','REVIEW_ELIGIBILITY','CREATOR_FOCUS_ADVISORY'));
ALTER TABLE release5_control_events DROP CONSTRAINT IF EXISTS release5_control_events_capability_check;
ALTER TABLE release5_control_events ADD CONSTRAINT release5_control_events_capability_check
 CHECK(capability IN('DASHBOARD_CORPUS','REVIEW_ELIGIBILITY','CREATOR_FOCUS_ADVISORY'));

CREATE TABLE IF NOT EXISTS creator_focus_advisory_events (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), event_key TEXT NOT NULL UNIQUE,
 channel_id TEXT NOT NULL, classification_diagnostic_id UUID NOT NULL REFERENCES production_classification_diagnostics(id) ON DELETE RESTRICT,
 creator_focus_snapshot_id UUID NOT NULL REFERENCES creator_focus_classification_snapshots(id) ON DELETE RESTRICT,
 activation_id UUID NOT NULL REFERENCES release5_rollout_activations(id) ON DELETE RESTRICT,
 production_status TEXT NOT NULL, creator_focus_status TEXT NOT NULL,
 disagrees BOOLEAN NOT NULL, investigation_priority_delta INTEGER NOT NULL DEFAULT 0,
 review_priority_delta INTEGER NOT NULL DEFAULT 0, reason_codes JSONB NOT NULL,
 policy_version TEXT NOT NULL, recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK(jsonb_typeof(reason_codes)='array'),
 CHECK(investigation_priority_delta BETWEEN 0 AND 100), CHECK(review_priority_delta BETWEEN 0 AND 100)
);
CREATE INDEX IF NOT EXISTS idx_creator_focus_advisory_channel ON creator_focus_advisory_events(channel_id,recorded_at DESC);
CREATE TRIGGER creator_focus_advisory_events_immutable BEFORE UPDATE OR DELETE ON creator_focus_advisory_events
 FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation();

INSERT INTO app_settings(setting_key,setting_value) VALUES
 ('release5_creator_focus_advisory_mode','OFF') ON CONFLICT(setting_key) DO NOTHING;
COMMENT ON TABLE creator_focus_advisory_events IS 'Canary-only advisory prioritization; never classification, admission, or serving authority.';
