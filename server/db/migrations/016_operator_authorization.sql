CREATE TABLE IF NOT EXISTS operator_audit_events (
  id BIGSERIAL PRIMARY KEY,
  actor_identifier TEXT,
  actor_hash TEXT,
  role TEXT,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  request_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('ALLOWED','DENIED')),
  safe_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (request_id, action, target, outcome)
);
CREATE INDEX IF NOT EXISTS idx_operator_audit_events_created_at ON operator_audit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_operator_audit_events_actor_hash ON operator_audit_events(actor_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_operator_audit_events_action ON operator_audit_events(action, created_at DESC);
