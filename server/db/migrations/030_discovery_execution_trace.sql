CREATE TABLE IF NOT EXISTS discovery_execution_trace (
  id BIGSERIAL PRIMARY KEY,
  trace_id UUID NOT NULL,
  stage TEXT NOT NULL,
  outcome TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_discovery_execution_trace_lookup
  ON discovery_execution_trace(trace_id, occurred_at, id);
