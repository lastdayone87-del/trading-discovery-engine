-- Migration 187: query-surface novelty arms and page-level overlap evidence.
--
-- A query surface can be evaluated through multiple (lane, ordering) arms.
-- Actual channel overlap decides whether an arm is productive or redundant;
-- channel IDs are recorded per page so the same query can be retried later
-- without permanent exclusion.

ALTER TABLE query_library
  ADD COLUMN IF NOT EXISTS novelty_cooldown_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS novelty_state TEXT;

ALTER TABLE autonomous_query_page_observations
  ADD COLUMN IF NOT EXISTS novelty JSONB;

CREATE TABLE IF NOT EXISTS query_discovery_arms (
  query_id INTEGER NOT NULL REFERENCES query_library(id) ON DELETE CASCADE,
  retrieval_lane TEXT NOT NULL,
  search_ordering TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'UNPROBED',
  probe_runs INTEGER NOT NULL DEFAULT 0,
  completed_runs INTEGER NOT NULL DEFAULT 0,
  fresh_candidates INTEGER NOT NULL DEFAULT 0,
  fresh_confirmed INTEGER NOT NULL DEFAULT 0,
  quota_units INTEGER NOT NULL DEFAULT 0,
  last_global_seen_share NUMERIC,
  last_fresh_share NUMERIC,
  last_run_at TIMESTAMPTZ,
  cooldown_until TIMESTAMPTZ,
  last_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (query_id, retrieval_lane, search_ordering),
  CHECK (status IN ('UNPROBED','PROBING','PRODUCTIVE','LOW_NOVELTY','EMPTY')),
  CHECK (retrieval_lane IN ('VIDEO','CHANNEL')),
  CHECK (search_ordering IN ('RELEVANCE','DATE')),
  CHECK (retrieval_lane = 'VIDEO' OR search_ordering = 'RELEVANCE')
);

CREATE TABLE IF NOT EXISTS query_discovery_arm_runs (
  query_run_id UUID PRIMARY KEY REFERENCES query_runs(id) ON DELETE CASCADE,
  query_id INTEGER NOT NULL REFERENCES query_library(id) ON DELETE CASCADE,
  retrieval_lane TEXT NOT NULL,
  search_ordering TEXT NOT NULL,
  fresh_candidates INTEGER NOT NULL DEFAULT 0,
  fresh_confirmed INTEGER NOT NULL DEFAULT 0,
  quota_units INTEGER NOT NULL DEFAULT 0,
  distinct_creators INTEGER NOT NULL DEFAULT 0,
  global_seen_creators INTEGER NOT NULL DEFAULT 0,
  novelty_observed BOOLEAN NOT NULL DEFAULT true,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Recheck rotation is independent from evidence time: an unchanged run is
  -- still periodically revisited for delayed classifications without making
  -- the arm look newer than it is.
  last_checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (retrieval_lane IN ('VIDEO','CHANNEL')),
  CHECK (search_ordering IN ('RELEVANCE','DATE')),
  CHECK (retrieval_lane = 'VIDEO' OR search_ordering = 'RELEVANCE')
);

CREATE INDEX IF NOT EXISTS idx_query_discovery_arm_runs_query
  ON query_discovery_arm_runs(query_id, retrieval_lane, search_ordering);
CREATE INDEX IF NOT EXISTS idx_query_discovery_arms_status
  ON query_discovery_arms(status, cooldown_until);
CREATE INDEX IF NOT EXISTS idx_query_discovery_arms_query
  ON query_discovery_arms(query_id, updated_at DESC);

-- Existing materialized generated queries are normal query surfaces. Their
-- target neighborhood key retains the original generation dimensions for
-- audit; laneAgnostic allows the selector to run the surface through another
-- lane/order without treating that as a frontier-allocation mismatch.
UPDATE query_library
SET generation_metadata = jsonb_set(
  generation_metadata,
  '{countryNativeAllocation,laneAgnostic}',
  'true'::jsonb,
  true
)
WHERE generation_metadata->'countryNativeAllocation'->>'materialized' = 'true';
