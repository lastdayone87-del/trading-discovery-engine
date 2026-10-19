-- Migration 146: Evidence-first discovery Phase 2 — bounded probe ledger.
--
-- Ledger decision (recon, read-only over migrations 002/027/043/048):
-- `terminology_trial_assignments` is NOT repurposed as the probe ledger.
-- It cannot carry the required lifecycle without destructive changes:
--   * it is append-only by trigger (BEFORE UPDATE OR DELETE raises), so an
--     outcome could never be recorded on the reserved row;
--   * hypothesis_id/action_id are NOT NULL FKs into the persistent-research
--     program graph, which a bounded evidence probe does not own;
--   * arm is CHECK-constrained to TERMINOLOGY/BASELINE_CONTROL and there are
--     no candidate/term/country/route/units/attempt/outcome/results columns.
-- Adding those columns would still leave the immutable trigger blocking the
-- reserve -> execute -> record lifecycle. `terminology_trial_controls` is a
-- singleton kill switch, `discovery_actions` is a program-scoped planner row
-- (no attempt/idempotency/outcome shape), `discovery_provider_registry` is a
-- provider catalog, and `jobs` is a queue. None is a probe ledger.
-- Therefore this additive migration creates a dedicated ledger.
--
-- Additive only: no existing table/column is dropped or rewritten, no
-- app_settings row is created, and no eligibility/gate state is touched.
-- The ledger is inert until `discovery_probe_enabled` is exactly 'true' AND
-- an approved caller invokes runApprovedProbe; absent => OFF.

CREATE TABLE IF NOT EXISTS discovery_probe_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Candidate identity is the existing canonical_candidate_key (staging key).
  candidate_key TEXT NOT NULL,
  probe_key TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  term TEXT NOT NULL,
  country TEXT NOT NULL,
  route TEXT NOT NULL CHECK (route IN ('youtube-innertube', 'youtube-data-api')),
  provider_key TEXT NOT NULL DEFAULT 'youtube-innertube',
  -- Quota accounting: InnerTube is quota-free, so every probe records units=0.
  units INTEGER NOT NULL DEFAULT 0 CHECK (units >= 0),
  attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
  status TEXT NOT NULL DEFAULT 'RESERVED'
    CHECK (status IN ('RESERVED', 'RUNNING', 'COMPLETED', 'FAILED', 'EXPIRED')),
  outcome TEXT CHECK (outcome IN ('SUCCESS', 'EMPTY', 'FAILED', 'INCONCLUSIVE', 'EXPIRED')),
  results_count INTEGER NOT NULL DEFAULT 0 CHECK (results_count >= 0),
  new_creators INTEGER NOT NULL DEFAULT 0 CHECK (new_creators >= 0),
  reasons JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(reasons) = 'array'),
  details JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  evidence_version TEXT,
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Idempotency: one row per candidate attempt; duplicate reserves return it.
  UNIQUE (candidate_key, attempt_no)
);

CREATE INDEX IF NOT EXISTS discovery_probe_ledger_candidate_idx
  ON discovery_probe_ledger(candidate_key, attempt_no);
CREATE INDEX IF NOT EXISTS discovery_probe_ledger_reserved_idx
  ON discovery_probe_ledger(reserved_at);
CREATE INDEX IF NOT EXISTS discovery_probe_ledger_country_reserved_idx
  ON discovery_probe_ledger(country, reserved_at);
CREATE INDEX IF NOT EXISTS discovery_probe_ledger_inflight_idx
  ON discovery_probe_ledger(expires_at)
  WHERE status IN ('RESERVED', 'RUNNING');

COMMENT ON TABLE discovery_probe_ledger IS
  'Bounded evidence-probe lifecycle ledger. Inert unless discovery_probe_enabled=true; never a serving/eligibility source.';
COMMENT ON COLUMN discovery_probe_ledger.evidence_version IS
  'Evidence version at reservation time; INCONCLUSIVE retries require a different value.';
