-- Phase B collection epoch declarations. Observational only: pins versions for a
-- prospective evaluation window and never grants serving or production authority.
ALTER TABLE phase_b_shadow_control_events
  DROP CONSTRAINT IF EXISTS phase_b_shadow_control_events_control_check;
ALTER TABLE phase_b_shadow_control_events
  ADD CONSTRAINT phase_b_shadow_control_events_control_check
  CHECK(control IN(
    'EVALUATION_SAMPLING',
    'EVIDENCE_DOCUMENTS',
    'EVIDENCE_ASSERTIONS',
    'CREATOR_FOCUS_SHADOW',
    'COLLECTION_EPOCH'
  ));

CREATE TABLE IF NOT EXISTS phase_b_collection_epochs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  epoch_key TEXT NOT NULL UNIQUE,
  validation_run_id UUID NOT NULL REFERENCES evidence_projection_validation_runs(id) ON DELETE RESTRICT,
  started_at TIMESTAMPTZ NOT NULL,
  sampling_policy_key TEXT NOT NULL,
  sampling_policy_version INTEGER NOT NULL CHECK(sampling_policy_version > 0),
  sampling_salt_fingerprint TEXT NOT NULL,
  coverage_policy_version TEXT NOT NULL,
  creator_focus_policy_version TEXT NOT NULL,
  classifier_version TEXT NOT NULL,
  shadow_policy_version TEXT NOT NULL,
  dual_write_version TEXT NOT NULL,
  assertion_dual_write_enabled BOOLEAN NOT NULL CHECK(assertion_dual_write_enabled = true),
  creator_focus_mode TEXT NOT NULL CHECK(creator_focus_mode = 'SHADOW'),
  serving_authority BOOLEAN NOT NULL DEFAULT false CHECK(serving_authority = false),
  automatic_promotion BOOLEAN NOT NULL DEFAULT false CHECK(automatic_promotion = false),
  minimum_bundle_availability_bps INTEGER NOT NULL DEFAULT 9000 CHECK(minimum_bundle_availability_bps BETWEEN 0 AND 10000),
  declared_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  definition JSONB NOT NULL CHECK(jsonb_typeof(definition) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_phase_b_collection_epochs_started
  ON phase_b_collection_epochs(started_at DESC, created_at DESC);

DO $$ BEGIN
  CREATE TRIGGER phase_b_collection_epochs_immutable
    BEFORE UPDATE OR DELETE ON phase_b_collection_epochs
    FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON TABLE phase_b_collection_epochs IS
  'Immutable Phase B collection epoch pins. Observational only; serving_authority is forced false.';
