-- Prospective Phase B observation durability. This outbox is observational only:
-- production decisions never read it and failures never alter serving state.
ALTER TABLE production_classification_diagnostics
  ADD COLUMN IF NOT EXISTS observation_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_classification_diagnostics_observation_key
  ON production_classification_diagnostics(observation_key)
  WHERE observation_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS phase_b_observation_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_key TEXT NOT NULL UNIQUE,
  observation_type TEXT NOT NULL CHECK(observation_type IN('RETRIEVAL_ASSIGNMENT','PRODUCTION_DIAGNOSTIC')),
  channel_id TEXT NOT NULL,
  payload JSONB NOT NULL CHECK(jsonb_typeof(payload)='object'),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN('PENDING','PROCESSING','COMPLETED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  run_after TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  result_reference TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_phase_b_outbox_pending
  ON phase_b_observation_outbox(status,run_after,created_at)
  WHERE status<>'COMPLETED';
CREATE INDEX IF NOT EXISTS idx_phase_b_outbox_channel
  ON phase_b_observation_outbox(channel_id,observation_type,created_at DESC);

COMMENT ON TABLE phase_b_observation_outbox IS
  'Repairable, idempotent completion queue for non-authoritative Phase B observations; never read by production decision paths.';
