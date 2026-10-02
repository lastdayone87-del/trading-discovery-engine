-- Migration 137: domain memory persistence (non-destructive).
--
-- Two additive tables, no changes to existing tables:
--
-- 1. domain_route_stats accumulates per-site, per-route-pattern acquisition
--    outcomes: attempts, evidence-bearing successes, and last observation
--    time. Counters only — weights are computed offline into snapshots, so
--    this table never stores a routing decision, only its raw material.
--
-- 2. domain_weight_snapshots stores versioned, reproducible learner output:
--    one immutable row per training run with the full training window,
--    metrics, and code version that produced it. Status starts DRAFT and
--    advances to APPROVED only through an explicit human approval record
--    (approved_by + approved_at); only APPROVED snapshots are consumable,
--    and consumption itself requires an explicit admission flag elsewhere.
--    Rejected snapshots stay queryable for audit and are never deleted by
--    the learner.
--
-- Operational safety: CREATE TABLE IF NOT EXISTS only, no backfills,
-- no constraint validation, safe inside the single-transaction runner.

CREATE TABLE IF NOT EXISTS domain_route_stats (
  site_identity TEXT NOT NULL,
  route_pattern TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  evidence_hits INTEGER NOT NULL DEFAULT 0,
  evidence_units INTEGER NOT NULL DEFAULT 0,
  first_observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (site_identity, route_pattern)
);
CREATE INDEX IF NOT EXISTS idx_domain_route_stats_observed ON domain_route_stats(last_observed_at);

CREATE TABLE IF NOT EXISTS domain_weight_snapshots (
  version TEXT PRIMARY KEY,
  site_identity TEXT NOT NULL,
  weights JSONB NOT NULL DEFAULT '{}',
  training_window JSONB NOT NULL DEFAULT '{}',
  metrics JSONB NOT NULL DEFAULT '{}',
  code_version TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'DRAFT',
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_domain_weight_snapshots_site ON domain_weight_snapshots(site_identity, created_at DESC);
