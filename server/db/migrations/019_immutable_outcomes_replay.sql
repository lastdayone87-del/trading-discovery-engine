-- Phase 4 expands the measurement plane without changing any authoritative read.
CREATE TABLE IF NOT EXISTS decision_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key TEXT NOT NULL UNIQUE,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_version SMALLINT NOT NULL CHECK (event_version > 0),
  source_event_key TEXT,
  query_id INTEGER REFERENCES query_library(id) ON DELETE SET NULL,
  query_run_id UUID REFERENCES query_runs(id) ON DELETE SET NULL,
  job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
  country TEXT,
  retrieval_lane TEXT,
  policy_version TEXT NOT NULL,
  feature_version TEXT NOT NULL,
  event_time TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  CHECK (jsonb_typeof(payload) = 'object')
);

CREATE TABLE IF NOT EXISTS outcome_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key TEXT NOT NULL UNIQUE,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN
    ('QUERY_FUNNEL_RECORDED','CHANNEL_OBSERVED','REVIEW_VERIFIED','REVIEW_CORRECTED','QUOTA_FINALIZED')),
  event_version SMALLINT NOT NULL CHECK (event_version > 0),
  source_event_key TEXT,
  query_id INTEGER REFERENCES query_library(id) ON DELETE SET NULL,
  query_run_id UUID REFERENCES query_runs(id) ON DELETE SET NULL,
  job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
  country TEXT,
  retrieval_lane TEXT,
  verification_status TEXT NOT NULL CHECK (verification_status IN ('PROVISIONAL','VERIFIED','CORRECTIVE')),
  policy_version TEXT NOT NULL,
  feature_version TEXT NOT NULL,
  event_time TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_decision_events_lineage ON decision_events(query_run_id, event_time, event_key);
CREATE INDEX IF NOT EXISTS idx_decision_events_segment ON decision_events(country, retrieval_lane, event_time);
CREATE INDEX IF NOT EXISTS idx_outcome_events_lineage ON outcome_events(query_run_id, event_time, event_key);
CREATE INDEX IF NOT EXISTS idx_outcome_events_subject ON outcome_events(subject_type, subject_id, recorded_at, event_key);
CREATE INDEX IF NOT EXISTS idx_outcome_events_segment ON outcome_events(country, retrieval_lane, event_time);

-- The database, not application convention, enforces append-only evidence.
CREATE OR REPLACE FUNCTION reject_immutable_event_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS decision_events_immutable ON decision_events;
CREATE TRIGGER decision_events_immutable BEFORE UPDATE OR DELETE ON decision_events
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation();
DROP TRIGGER IF EXISTS outcome_events_immutable ON outcome_events;
CREATE TRIGGER outcome_events_immutable BEFORE UPDATE OR DELETE ON outcome_events
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation();

CREATE TABLE IF NOT EXISTS benchmark_datasets (
  version TEXT PRIMARY KEY,
  artifact_checksum TEXT NOT NULL CHECK (artifact_checksum ~ '^[a-f0-9]{64}$'),
  policy_version TEXT NOT NULL,
  feature_version TEXT NOT NULL,
  acceptance_tolerance NUMERIC(8,6) NOT NULL CHECK (acceptance_tolerance >= 0),
  frozen_at TIMESTAMPTZ NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE TABLE IF NOT EXISTS replay_runs (
  id UUID PRIMARY KEY,
  dataset_version TEXT NOT NULL REFERENCES benchmark_datasets(version),
  code_version TEXT NOT NULL,
  configuration_checksum TEXT NOT NULL CHECK (configuration_checksum ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('PASS','FAIL')),
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  report JSONB NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  CHECK (window_end >= window_start AND completed_at >= started_at),
  CHECK (jsonb_typeof(report) = 'object')
);
CREATE INDEX IF NOT EXISTS idx_replay_runs_dataset_completed ON replay_runs(dataset_version, completed_at DESC);
DROP TRIGGER IF EXISTS benchmark_datasets_immutable ON benchmark_datasets;
CREATE TRIGGER benchmark_datasets_immutable BEFORE UPDATE OR DELETE ON benchmark_datasets
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation();
DROP TRIGGER IF EXISTS replay_runs_immutable ON replay_runs;
CREATE TRIGGER replay_runs_immutable BEFORE UPDATE OR DELETE ON replay_runs
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation();

COMMENT ON TABLE decision_events IS 'Immutable Phase 4 decision context; minimal metadata only, never provider payloads or credentials.';
COMMENT ON TABLE outcome_events IS 'Immutable provisional, verified, and corrective outcomes. Corrections append rather than update.';
