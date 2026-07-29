-- Phase 2 is expand-only: provider telemetry is independent of existing logs and
-- can be disabled without changing discovery reads or queue payloads.
CREATE TABLE IF NOT EXISTS provider_call_events (
  id UUID PRIMARY KEY,
  provider TEXT NOT NULL,
  operation TEXT NOT NULL,
  request_id TEXT,
  run_id TEXT,
  job_id TEXT,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  status TEXT NOT NULL CHECK (status IN ('SUCCESS','TIMEOUT','CANCELLED','RATE_LIMITED','TRANSIENT_ERROR','PERMANENT_ERROR')),
  latency_ms INTEGER NOT NULL CHECK (latency_ms >= 0),
  reserved_cost NUMERIC(14,4) NOT NULL DEFAULT 0,
  actual_cost NUMERIC(14,4) NOT NULL DEFAULT 0,
  error_class TEXT,
  policy_version TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_provider_events_time ON provider_call_events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_provider_events_provider_operation_time ON provider_call_events(provider, operation, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_provider_events_job ON provider_call_events(job_id) WHERE job_id IS NOT NULL;

INSERT INTO app_settings(setting_key, setting_value) VALUES
  ('provider_deadlines_enabled','false'),
  ('youtube_provider_timeout_ms','30000'),
  ('gemini_provider_timeout_ms','45000')
ON CONFLICT(setting_key) DO NOTHING;
