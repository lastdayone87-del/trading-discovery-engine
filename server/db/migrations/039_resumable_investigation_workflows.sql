-- Idempotent, resumable investigation workflow for long-running evidence work.
-- Jobs remain the transactional outbox and existing workers remain compatible.

CREATE TABLE IF NOT EXISTS investigations (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), investigation_key TEXT NOT NULL UNIQUE,
 subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, purpose TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN('ACTIVE','COMPLETED','NEEDS_REVIEW','FAILED','SUPERSEDED')),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), current_step_id UUID,
 policy_version TEXT NOT NULL, utility_contract_version TEXT NOT NULL,
 initial_context JSONB NOT NULL, context_checksum TEXT NOT NULL,
 deadline_at TIMESTAMPTZ NOT NULL, started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 completed_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_investigations_subject ON investigations(subject_type,subject_id,started_at DESC);
CREATE INDEX IF NOT EXISTS idx_investigations_active ON investigations(updated_at) WHERE state='ACTIVE';

CREATE TABLE IF NOT EXISTS investigation_steps (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), investigation_id UUID NOT NULL REFERENCES investigations(id) ON DELETE RESTRICT,
 classification_diagnostic_id UUID REFERENCES production_classification_diagnostics(id) ON DELETE RESTRICT,
 step_key TEXT NOT NULL UNIQUE, sequence_number INTEGER NOT NULL CHECK(sequence_number>0),
 action_type TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN('PENDING','RUNNING','RETRYING','COMPLETED','FAILED','SKIPPED')),
 job_id UUID NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE RESTRICT,
 input_snapshot JSONB NOT NULL, input_checksum TEXT NOT NULL, policy_version TEXT NOT NULL,
 attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0), worker_id TEXT,
 lease_expires_at TIMESTAMPTZ, started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ,
 resulting_status TEXT, output_checksum TEXT, failure_class TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(investigation_id,sequence_number)
);
ALTER TABLE investigations DROP CONSTRAINT IF EXISTS investigations_current_step_fk;
ALTER TABLE investigations ADD CONSTRAINT investigations_current_step_fk FOREIGN KEY(current_step_id) REFERENCES investigation_steps(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX IF NOT EXISTS idx_investigation_steps_recovery ON investigation_steps(state,lease_expires_at) WHERE state IN('RUNNING','RETRYING');

CREATE TABLE IF NOT EXISTS investigation_events (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), event_key TEXT NOT NULL UNIQUE,
 investigation_id UUID NOT NULL REFERENCES investigations(id) ON DELETE RESTRICT,
 step_id UUID REFERENCES investigation_steps(id) ON DELETE RESTRICT,
 event_type TEXT NOT NULL CHECK(event_type IN('INVESTIGATION_STARTED','STEP_SCHEDULED','STEP_STARTED','STEP_HEARTBEAT','STEP_RETRYING','STEP_COMPLETED','STEP_FAILED','STEP_SKIPPED','INVESTIGATION_COMPLETED','INVESTIGATION_REVIEW','INVESTIGATION_RECOVERED','INVESTIGATION_SUPERSEDED')),
 event_version INTEGER NOT NULL DEFAULT 1, payload JSONB NOT NULL,
 policy_version TEXT NOT NULL, occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_investigation_events_timeline ON investigation_events(investigation_id,occurred_at,id);
CREATE TRIGGER investigation_events_immutable BEFORE UPDATE OR DELETE ON investigation_events FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation();

INSERT INTO app_settings(setting_key,setting_value) VALUES('investigation_workflow_enabled','false') ON CONFLICT(setting_key) DO NOTHING;
INSERT INTO app_settings(setting_key,setting_value) VALUES('investigation_deadline_minutes','30') ON CONFLICT(setting_key) DO NOTHING;

COMMENT ON TABLE investigations IS 'Repairable current projection; authoritative history is investigation_events plus immutable classification/evidence ledgers.';
COMMENT ON TABLE investigation_steps IS 'Idempotent workflow steps. jobs is the transactional outbox and job_attempts is the execution-attempt ledger.';
COMMENT ON TABLE investigation_events IS 'Immutable workflow history used for replay, diagnosis, and projection repair.';
