-- Fenced bootstrap arming for research_control. The provisional bootstrap may
-- only allocate while explicitly armed: bootstrap_armed=true bound to a
-- single ACTIVE research_bootstrap_runs row. Arming flips the serving fields
-- to CANARY/enabled/unpaused/kill-off through the governed
-- configureBootstrapArming path (validated run, eligible candidate, budget
-- check, configuration event); the allocator auto-disarms back to the dormant
-- safe state when the run terminates, so an armed control can never outlive
-- its run. Normal CANARY governance (PASS-backed active policy) is untouched:
-- without a fenced arm AND an ACTIVE run, bootstrap allocation refuses.
ALTER TABLE research_control
  ADD COLUMN IF NOT EXISTS bootstrap_armed BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS bootstrap_run_id UUID REFERENCES research_bootstrap_runs(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS bootstrap_armed_by TEXT,
  ADD COLUMN IF NOT EXISTS bootstrap_armed_reason TEXT,
  ADD COLUMN IF NOT EXISTS bootstrap_armed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS bootstrap_armed_config_version INTEGER;
