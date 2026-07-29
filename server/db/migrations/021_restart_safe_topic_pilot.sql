-- Phase 6 expands the passive ledger into one tightly bounded pilot controller.
-- Existing jobs and the autonomous scheduler remain valid and authoritative unless
-- an explicitly assigned canary cohort is enabled.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE research_programs DROP CONSTRAINT IF EXISTS research_programs_mode_check;
ALTER TABLE research_programs ADD CONSTRAINT research_programs_mode_check CHECK (mode IN ('SHADOW','CANARY')) NOT VALID;
ALTER TABLE research_programs VALIDATE CONSTRAINT research_programs_mode_check;
ALTER TABLE research_programs DROP CONSTRAINT IF EXISTS research_programs_activation_enabled_check;

ALTER TABLE frontier_actions DROP CONSTRAINT IF EXISTS frontier_actions_mode_check;
ALTER TABLE frontier_actions ADD CONSTRAINT frontier_actions_mode_check CHECK (mode IN ('SHADOW','CANARY')) NOT VALID;
ALTER TABLE frontier_actions VALIDATE CONSTRAINT frontier_actions_mode_check;
ALTER TABLE frontier_actions DROP CONSTRAINT IF EXISTS frontier_actions_lifecycle_check;
ALTER TABLE frontier_actions ADD CONSTRAINT frontier_actions_lifecycle_check
  CHECK (lifecycle IN ('PROPOSED','ESTIMATED','RESERVED','MATERIALIZED','EXECUTING','OBSERVED','COMPLETED','FAILED','CANCELLED')) NOT VALID;
ALTER TABLE frontier_actions VALIDATE CONSTRAINT frontier_actions_lifecycle_check;
ALTER TABLE frontier_actions ADD COLUMN IF NOT EXISTS payload_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (payload_schema_version = 1);
ALTER TABLE frontier_actions ADD COLUMN IF NOT EXISTS reserved_provider_cost INTEGER NOT NULL DEFAULT 0 CHECK (reserved_provider_cost >= 0);
ALTER TABLE frontier_actions ADD COLUMN IF NOT EXISTS actual_provider_cost INTEGER CHECK (actual_provider_cost >= 0);

ALTER TABLE frontier_action_attempts DROP CONSTRAINT IF EXISTS frontier_action_attempts_status_check;
ALTER TABLE frontier_action_attempts ADD CONSTRAINT frontier_action_attempts_status_check
  CHECK (status IN ('RESERVED','MATERIALIZED','EXECUTING','COMPLETED','FAILED','CANCELLED')) NOT VALID;
ALTER TABLE frontier_action_attempts VALIDATE CONSTRAINT frontier_action_attempts_status_check;
ALTER TABLE frontier_action_attempts ALTER COLUMN completed_at DROP NOT NULL;

CREATE TABLE IF NOT EXISTS research_controller_checkpoints (
  program_id UUID PRIMARY KEY REFERENCES research_programs(id) ON DELETE RESTRICT,
  checkpoint_version BIGINT NOT NULL DEFAULT 0 CHECK (checkpoint_version >= 0),
  cursor JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(cursor)='object'),
  lease_owner TEXT,
  lease_token UUID,
  leased_until TIMESTAMPTZ,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  circuit_open_until TIMESTAMPTZ,
  last_completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((lease_owner IS NULL AND lease_token IS NULL AND leased_until IS NULL) OR
         (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND leased_until IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS research_pilot_cohorts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id UUID NOT NULL REFERENCES research_programs(id) ON DELETE RESTRICT,
  country TEXT NOT NULL,
  block_start TIMESTAMPTZ NOT NULL,
  block_end TIMESTAMPTZ NOT NULL,
  owner TEXT NOT NULL CHECK (owner IN ('LEGACY','PILOT')),
  policy_version TEXT NOT NULL,
  assigned_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (block_end > block_start),
  EXCLUDE USING gist (program_id WITH =, lower(country) WITH =, tstzrange(block_start,block_end,'[)') WITH &&)
);

CREATE TABLE IF NOT EXISTS research_pilot_controls (
  program_id UUID PRIMARY KEY REFERENCES research_programs(id) ON DELETE RESTRICT,
  kill_switch BOOLEAN NOT NULL DEFAULT true,
  daily_youtube_cap INTEGER NOT NULL DEFAULT 0 CHECK (daily_youtube_cap >= 0),
  total_youtube_cap INTEGER NOT NULL DEFAULT 0 CHECK (total_youtube_cap >= 0),
  consumed_youtube_units INTEGER NOT NULL DEFAULT 0 CHECK (consumed_youtube_units >= 0),
  configuration_version BIGINT NOT NULL DEFAULT 1 CHECK (configuration_version > 0),
  updated_by TEXT NOT NULL DEFAULT 'migration',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (consumed_youtube_units <= total_youtube_cap)
);

CREATE INDEX IF NOT EXISTS idx_frontier_actions_eligible
  ON frontier_actions(program_id, validity_start, created_at, id)
  WHERE lifecycle IN ('PROPOSED','ESTIMATED','RESERVED');
CREATE UNIQUE INDEX IF NOT EXISTS idx_frontier_attempt_one_active
  ON frontier_action_attempts(action_id) WHERE status IN ('RESERVED','MATERIALIZED','EXECUTING');
CREATE INDEX IF NOT EXISTS idx_pilot_cohorts_lookup ON research_pilot_cohorts(program_id,country,block_start,block_end);

INSERT INTO research_controller_checkpoints(program_id)
SELECT id FROM research_programs WHERE program_key='price-action-trading' ON CONFLICT DO NOTHING;
INSERT INTO research_pilot_controls(program_id)
SELECT id FROM research_programs WHERE program_key='price-action-trading' ON CONFLICT DO NOTHING;

COMMENT ON TABLE research_controller_checkpoints IS 'Short controller leases; workers remain the sole provider executors.';
COMMENT ON TABLE research_pilot_cohorts IS 'Exclusive country/time ownership prevents pilot and legacy double spend.';
COMMENT ON TABLE research_pilot_controls IS 'Fail-closed Phase 6 caps and kill switch; defaults permit zero execution.';
