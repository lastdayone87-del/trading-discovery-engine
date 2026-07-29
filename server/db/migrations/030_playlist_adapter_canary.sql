-- Phase 14b: expand-only outcome ledger for the separately gated playlist canary.
CREATE TABLE IF NOT EXISTS acquisition_adapter_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), adapter_type TEXT NOT NULL CHECK(adapter_type='INSPECT_PLAYLIST'),
  action_id UUID NOT NULL REFERENCES frontier_actions(id) ON DELETE RESTRICT,
  job_id UUID REFERENCES jobs(id) ON DELETE RESTRICT, program_id UUID NOT NULL REFERENCES research_programs(id) ON DELETE RESTRICT,
  semantic_action_key TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('SUCCEEDED','FAILED','POLICY_REJECTED')),
  quota_reserved INTEGER NOT NULL CHECK(quota_reserved>=0), quota_consumed INTEGER NOT NULL CHECK(quota_consumed>=0 AND quota_consumed<=quota_reserved),
  provider_request_key TEXT NOT NULL, policy_version TEXT NOT NULL, payload_schema_version INTEGER NOT NULL CHECK(payload_schema_version=1),
  observed_at TIMESTAMPTZ NOT NULL, outcome JSONB NOT NULL CHECK(jsonb_typeof(outcome)='object'), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(adapter_type,action_id), UNIQUE(provider_request_key)
);
CREATE INDEX IF NOT EXISTS idx_adapter_runs_program_time ON acquisition_adapter_runs(program_id,created_at DESC);
CREATE TRIGGER acquisition_adapter_runs_immutable BEFORE UPDATE OR DELETE ON acquisition_adapter_runs
FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation();
COMMENT ON TABLE acquisition_adapter_runs IS 'Immutable replay ledger; retained when a canary is killed or rolled back.';
