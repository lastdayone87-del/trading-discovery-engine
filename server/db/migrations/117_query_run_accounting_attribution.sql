-- Durable exactly-once attribution marker for completed query runs.
-- This is additive only: historical query_runs and query_library counters are untouched.
CREATE TABLE IF NOT EXISTS query_run_accounting_attributions (
  query_run_id UUID PRIMARY KEY REFERENCES query_runs(id) ON DELETE CASCADE,
  query_id INTEGER NOT NULL REFERENCES query_library(id) ON DELETE CASCADE,
  attribution_version TEXT NOT NULL,
  performance_score REAL NOT NULL DEFAULT 0,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  attributed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(query_run_id, attribution_version)
);

CREATE INDEX IF NOT EXISTS idx_query_run_accounting_query
  ON query_run_accounting_attributions(query_id, attributed_at DESC);

-- Preserve the legacy execution-log surface while making autonomous logs linkable
-- and idempotent by durable query-run identity.
ALTER TABLE query_execution_logs
  ADD COLUMN IF NOT EXISTS query_run_id UUID REFERENCES query_runs(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_query_execution_logs_query_run
  ON query_execution_logs(query_run_id)
  WHERE query_run_id IS NOT NULL;
