-- Phase 12: read-only trust and evaluation materialization. Phase 8/9 remain the
-- only allocation and execution authorities; these rows are derived observations.
CREATE TABLE IF NOT EXISTS discovery_evaluation_snapshots (
  snapshot_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_key TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  evaluation_version TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  source_watermark TIMESTAMPTZ NOT NULL,
  source_checksum TEXT NOT NULL,
  cohort_definition JSONB NOT NULL CHECK (jsonb_typeof(cohort_definition)='object'),
  metrics JSONB NOT NULL CHECK (jsonb_typeof(metrics)='object'),
  evaluation_status TEXT NOT NULL CHECK (evaluation_status IN ('INSUFFICIENT_EVIDENCE','HEALTHY','WATCH','DEGRADED')),
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (window_end > window_start),
  UNIQUE(cohort_key,window_start,window_end,evaluation_version,revision)
);
CREATE INDEX IF NOT EXISTS discovery_evaluation_window_idx
  ON discovery_evaluation_snapshots(window_end DESC,cohort_key);

-- One immutable outcome observation per completed run. Allocation provenance is
-- copied exclusively from the allocation-time snapshot; current classification is
-- explicitly timestamped and may be captured in a later snapshot revision.
CREATE TABLE IF NOT EXISTS discovery_evaluation_run_observations (
  query_run_id UUID PRIMARY KEY REFERENCES query_runs(id) ON DELETE RESTRICT,
  allocation_decision_id TEXT REFERENCES frontier_allocation_decisions(decision_id) ON DELETE RESTRICT,
  allocation_origin TEXT NOT NULL,
  proposal_family TEXT NOT NULL,
  evidence_family TEXT,
  source_families JSONB NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(source_families)='array'),
  country TEXT NOT NULL,
  language TEXT,
  locale TEXT,
  script TEXT,
  canonical_concept TEXT,
  provider TEXT NOT NULL,
  rollout_cohort TEXT NOT NULL,
  allocation_snapshot JSONB NOT NULL CHECK(jsonb_typeof(allocation_snapshot)='object'),
  allocation_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  classification_observed_at TIMESTAMPTZ NOT NULL,
  quota_reserved INTEGER NOT NULL CHECK(quota_reserved>=0),
  quota_consumed INTEGER NOT NULL CHECK(quota_consumed>=0),
  provider_requests INTEGER NOT NULL DEFAULT 1 CHECK(provider_requests>=0),
  execution_ms BIGINT NOT NULL DEFAULT 0 CHECK(execution_ms>=0),
  raw_results INTEGER NOT NULL CHECK(raw_results>=0),
  distinct_creators INTEGER NOT NULL CHECK(distinct_creators>=0),
  known_creators INTEGER NOT NULL CHECK(known_creators>=0),
  new_creators INTEGER NOT NULL CHECK(new_creators>=0),
  relevant_new_creators INTEGER NOT NULL CHECK(relevant_new_creators>=0),
  quality_new_creators INTEGER NOT NULL CHECK(quality_new_creators>=0),
  confirmed_new_creators INTEGER NOT NULL CHECK(confirmed_new_creators>=0),
  wrong_country_results INTEGER NOT NULL DEFAULT 0 CHECK(wrong_country_results>=0),
  irrelevant_results INTEGER NOT NULL DEFAULT 0 CHECK(irrelevant_results>=0),
  provider_failed BOOLEAN NOT NULL DEFAULT false,
  invalid_query BOOLEAN NOT NULL DEFAULT false,
  outcome_checksum TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS discovery_eval_run_window_idx ON discovery_evaluation_run_observations(completed_at,query_run_id);
CREATE INDEX IF NOT EXISTS discovery_eval_run_family_idx ON discovery_evaluation_run_observations(proposal_family,completed_at);
CREATE INDEX IF NOT EXISTS discovery_eval_run_country_idx ON discovery_evaluation_run_observations(country,completed_at);

CREATE OR REPLACE FUNCTION phase12_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Phase 12 historical observation is immutable'; END $$;
DROP TRIGGER IF EXISTS discovery_eval_run_immutable ON discovery_evaluation_run_observations;
CREATE TRIGGER discovery_eval_run_immutable BEFORE UPDATE ON discovery_evaluation_run_observations
FOR EACH ROW EXECUTE FUNCTION phase12_immutable_guard();
