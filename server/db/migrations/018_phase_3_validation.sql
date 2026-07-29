-- Phase 3 is expand-only. Validation evidence is append-only and contains no
-- backup payloads, provider responses, or credentials.
CREATE TABLE IF NOT EXISTS validation_runs (
  id UUID PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('MIGRATION','RESTORE','RESTART','QUOTA','CLASSIFIER','BASELINE','PROVIDER')),
  environment TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PASS','FAIL','INCOMPLETE')),
  policy_version TEXT,
  dataset_version TEXT,
  artifact_checksum TEXT NOT NULL CHECK (artifact_checksum ~ '^[a-f0-9]{64}$'),
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (completed_at >= started_at)
);

CREATE INDEX IF NOT EXISTS idx_validation_runs_kind_created
  ON validation_runs(kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_validation_runs_status_created
  ON validation_runs(status, created_at DESC);

COMMENT ON TABLE validation_runs IS
  'Append-only Phase 3 validation evidence metadata; artifacts remain in controlled external storage.';
