-- Migration 136: frontier manager + coverage ledger persistence (non-destructive).
--
-- Two additive tables, no changes to existing tables:
--
-- 1. site_frontier is the per-site ordered candidate queue: nominated URLs
--    with expected evidence value, politeness state, attempt history, and
--    the weight version that scored them. Bounded per site by policy; the
--    manager, never the nominator, enforces the bound. Rows are working
--    state (mutable lifecycle), fully described by the decision log each
--    dequeue writes.
--
-- 2. page_coverage is the per-page terminal-state ledger: one row per
--    inspected page with its terminal outcome, acquisition method, and the
--    policy/weight versions in force. Terminal states are never rewritten
--    to a different state (a re-inspection appends a new row superseding by
--    timestamp); NOT_FOUND requires processed evidence by contract.
--
-- Operational safety: CREATE TABLE IF NOT EXISTS only, no backfills,
-- no constraint validation, safe inside the single-transaction runner.
-- No CHECK constraint on state/outcome text columns: new terminal states
-- must never fail at the database layer (code validates instead).

CREATE TABLE IF NOT EXISTS site_frontier (
  site_identity TEXT NOT NULL,
  url_key TEXT NOT NULL,
  url TEXT NOT NULL,
  expected_value DOUBLE PRECISION NOT NULL DEFAULT 0,
  politeness_not_before TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'QUEUED',
  nominating_source TEXT NOT NULL DEFAULT '',
  source_detail JSONB NOT NULL DEFAULT '{}',
  weight_version TEXT NOT NULL DEFAULT '',
  scorer_inputs JSONB NOT NULL DEFAULT '{}',
  decision_log JSONB NOT NULL DEFAULT '[]',
  first_observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (site_identity, url_key)
);
CREATE INDEX IF NOT EXISTS idx_site_frontier_priority ON site_frontier(site_identity, state, expected_value DESC, url_key);

CREATE TABLE IF NOT EXISTS page_coverage (
  site_identity TEXT NOT NULL,
  page_key TEXT NOT NULL,
  page_url TEXT NOT NULL,
  terminal_state TEXT NOT NULL DEFAULT 'NOT_INSPECTED',
  acquisition_method TEXT NOT NULL DEFAULT '',
  evidence_units INTEGER NOT NULL DEFAULT 0,
  policy_version TEXT NOT NULL DEFAULT '',
  weight_version TEXT NOT NULL DEFAULT '',
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (site_identity, page_key, observed_at)
);
CREATE INDEX IF NOT EXISTS idx_page_coverage_site ON page_coverage(site_identity, observed_at DESC);
