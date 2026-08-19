-- Phase 8: Neighborhood-Level Resource Allocation

CREATE TABLE IF NOT EXISTS frontier_allocation_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id TEXT UNIQUE NOT NULL,
  opportunity_key TEXT NOT NULL,
  allocation_origin TEXT NOT NULL CHECK(allocation_origin IN ('LEGACY', 'FRONTIER_SHADOW', 'FRONTIER_CANARY')),
  decision_status TEXT NOT NULL DEFAULT 'RESERVED' CHECK(decision_status IN ('RESERVED', 'COMMITTED', 'RELEASED', 'DEFERRED')),
  legacy_target_country TEXT,
  legacy_target_neighborhood_key TEXT REFERENCES discovery_neighborhoods(neighborhood_key) ON DELETE SET NULL,
  selected_neighborhood_key TEXT REFERENCES discovery_neighborhoods(neighborhood_key) ON DELETE SET NULL,
  selected_country TEXT NOT NULL,
  frontier_state TEXT NOT NULL,
  expected_marginal_value REAL NOT NULL DEFAULT 0,
  uncertainty REAL NOT NULL DEFAULT 0,
  coverage_gain REAL NOT NULL DEFAULT 0,
  saturation_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  proposal_id UUID REFERENCES frontier_discovery_proposals(proposal_id) ON DELETE SET NULL,
  selection_score REAL NOT NULL DEFAULT 0,
  score_components JSONB NOT NULL DEFAULT '{}'::jsonb,
  candidate_neighborhood_count INTEGER NOT NULL DEFAULT 0,
  rejection_reasons JSONB NOT NULL DEFAULT '{}'::jsonb,
  agreed_with_legacy BOOLEAN NOT NULL DEFAULT FALSE,
  deferred BOOLEAN NOT NULL DEFAULT FALSE,
  query_run_id UUID REFERENCES query_runs(id) ON DELETE SET NULL,
  quota_reserved INTEGER NOT NULL DEFAULT 100,
  quota_consumed INTEGER NOT NULL DEFAULT 0,
  quota_day TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_frontier_alloc_origin ON frontier_allocation_decisions(allocation_origin);
CREATE INDEX IF NOT EXISTS idx_frontier_alloc_status ON frontier_allocation_decisions(decision_status);
CREATE INDEX IF NOT EXISTS idx_frontier_alloc_created ON frontier_allocation_decisions(created_at);
CREATE INDEX IF NOT EXISTS idx_frontier_alloc_quota_day ON frontier_allocation_decisions(quota_day);
CREATE INDEX IF NOT EXISTS idx_frontier_alloc_neighborhood ON frontier_allocation_decisions(selected_neighborhood_key);
CREATE INDEX IF NOT EXISTS idx_frontier_alloc_query_run ON frontier_allocation_decisions(query_run_id);

ALTER TABLE frontier_allocation_decisions
  DROP CONSTRAINT IF EXISTS chk_frontier_alloc_quota_reserved,
  DROP CONSTRAINT IF EXISTS chk_frontier_alloc_quota_consumed;

ALTER TABLE frontier_allocation_decisions
  ADD CONSTRAINT chk_frontier_alloc_quota_reserved CHECK (quota_reserved BETWEEN 0 AND 100),
  ADD CONSTRAINT chk_frontier_alloc_quota_consumed CHECK (quota_consumed >= 0);

ALTER TABLE query_runs
  ADD COLUMN IF NOT EXISTS allocation_origin TEXT DEFAULT 'LEGACY';
