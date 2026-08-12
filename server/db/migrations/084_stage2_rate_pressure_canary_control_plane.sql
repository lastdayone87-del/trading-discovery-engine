CREATE TABLE IF NOT EXISTS stage2_rate_pressure_canary_control (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  mode TEXT NOT NULL DEFAULT 'OFF' CHECK (mode IN ('OFF','CANARY')),
  generation BIGINT NOT NULL DEFAULT 0,
  last_actor TEXT,
  last_reason TEXT,
  aborted_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO stage2_rate_pressure_canary_control(singleton, mode)
VALUES (TRUE, 'OFF')
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS stage2_rate_pressure_canary_subjects (
  canary_generation BIGINT NOT NULL,
  subject_key TEXT NOT NULL,
  treatment_slot SMALLINT NOT NULL CHECK (treatment_slot BETWEEN 1 AND 50),
  allocation_basis_points INTEGER NOT NULL CHECK (allocation_basis_points = 500),
  randomization_value INTEGER NOT NULL CHECK (randomization_value BETWEEN 0 AND 9999),
  evidence_snapshot_checksum TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ABORTED','COMPLETED')),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (canary_generation, subject_key),
  UNIQUE (canary_generation, treatment_slot)
);

CREATE TABLE IF NOT EXISTS stage2_rate_pressure_canary_events (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL,
  canary_generation BIGINT,
  subject_key TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('OFF','CANARY')),
  actor TEXT,
  reason TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stage2_rate_pressure_canary_events_created_idx
  ON stage2_rate_pressure_canary_events(created_at DESC);
CREATE INDEX IF NOT EXISTS stage2_rate_pressure_canary_events_subject_idx
  ON stage2_rate_pressure_canary_events(canary_generation, subject_key, created_at DESC);
