ALTER TABLE query_library ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMPTZ;
ALTER TABLE query_library ADD COLUMN IF NOT EXISTS reserved_until TIMESTAMPTZ;
ALTER TABLE query_library ADD COLUMN IF NOT EXISTS reserved_by TEXT;
ALTER TABLE query_library ADD COLUMN IF NOT EXISTS last_queued_at TIMESTAMPTZ;
ALTER TABLE query_library ADD COLUMN IF NOT EXISTS next_eligible_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS query_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query_id INTEGER NOT NULL REFERENCES query_library(id) ON DELETE CASCADE,
  job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
  country TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'SCHEDULED',
  selection_strategy TEXT NOT NULL,
  selection_reason TEXT NOT NULL,
  raw_results INTEGER NOT NULL DEFAULT 0,
  unique_channels INTEGER NOT NULL DEFAULT 0,
  quality_channels INTEGER NOT NULL DEFAULT 0,
  communities_discovered INTEGER NOT NULL DEFAULT 0,
  quota_reserved INTEGER NOT NULL DEFAULT 0,
  quota_used INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS quota_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_type TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  allocation TEXT NOT NULL,
  units INTEGER NOT NULL CHECK (units > 0),
  status TEXT NOT NULL DEFAULT 'RESERVED',
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  UNIQUE(operation_type, operation_id)
);

CREATE INDEX IF NOT EXISTS idx_query_reservation
  ON query_library(status, reserved_until, next_eligible_at, last_executed);
CREATE INDEX IF NOT EXISTS idx_query_runs_status ON query_runs(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_quota_reservations_active
  ON quota_reservations(allocation, expires_at) WHERE status = 'RESERVED';
CREATE INDEX IF NOT EXISTS idx_jobs_discovery_claim
  ON jobs(type, status, priority DESC, run_after, created_at);
