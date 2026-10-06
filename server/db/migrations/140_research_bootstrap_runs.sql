-- Provisional evidence-gathering CANARY bootstrap runs. Each row is an
-- explicitly authorized, bounded allocation window whose SOLE purpose is
-- producing the first genuine behavior samples for policy evaluation. It is
-- not an efficacy claim, grants no promotion, and never relaxes the
-- evaluator's minimum-sample requirement. At most one ACTIVE run may exist;
-- completion/abort is terminal. See allocateBootstrapAssignments: the run is
-- marked COMPLETED automatically when its ceilings are reached, ABORTED
-- (with aborted_by/abort_reason) when it expires, when research is disarmed,
-- or when its candidate policy becomes ineligible. Normal CANARY allocation
-- (allocateCanonical, PASS-gated) is untouched.
CREATE TABLE IF NOT EXISTS research_bootstrap_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_policy_id UUID NOT NULL REFERENCES portfolio_policies(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','COMPLETED','ABORTED')),
  max_assignments INTEGER NOT NULL CHECK(max_assignments BETWEEN 1 AND 30),
  max_provider_cost INTEGER NOT NULL CHECK(max_provider_cost >= 0),
  starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  aborted_by TEXT,
  abort_reason TEXT,
  reason TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK(expires_at > starts_at AND expires_at <= starts_at + interval '30 days')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_research_bootstrap_single_active
  ON research_bootstrap_runs (status) WHERE status = 'ACTIVE';
