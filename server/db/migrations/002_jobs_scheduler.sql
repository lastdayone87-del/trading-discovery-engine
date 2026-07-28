CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  priority INTEGER NOT NULL DEFAULT 0,
  payload JSONB NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_after TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_by TEXT,
  locked_at TIMESTAMPTZ,
  last_error TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_jobs_status_run_after ON jobs(status, run_after);
CREATE INDEX IF NOT EXISTS idx_jobs_locked_at ON jobs(locked_at);
CREATE INDEX IF NOT EXISTS idx_jobs_type ON jobs(type);

CREATE TABLE IF NOT EXISTS job_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL,
  error TEXT,
  logs JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE TABLE IF NOT EXISTS scheduler_state (
  name TEXT PRIMARY KEY,
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  is_running BOOLEAN NOT NULL DEFAULT false,
  locked_by TEXT,
  locked_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  last_report JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
