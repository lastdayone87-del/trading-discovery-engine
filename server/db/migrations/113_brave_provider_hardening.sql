-- Provider 2 hardening: independent provider accounting, distributed controls,
-- canonical candidate identity, discovery observations, and durable resolution metadata.

ALTER TABLE discovery_provider_registry
  ADD COLUMN IF NOT EXISTS cost_unit TEXT NOT NULL DEFAULT 'USD_PER_REQUEST',
  ADD COLUMN IF NOT EXISTS pricing_version TEXT NOT NULL DEFAULT 'UNVERSIONED';

ALTER TABLE query_runs
  ADD COLUMN IF NOT EXISTS provider_reservation_id TEXT,
  ADD COLUMN IF NOT EXISTS provider_reserved_amount BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS provider_cost_usd NUMERIC(18,8) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS provider_pricing_version TEXT NOT NULL DEFAULT 'UNVERSIONED',
  ADD COLUMN IF NOT EXISTS provider_requests_attempted INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS provider_requests_succeeded INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS provider_requests_failed INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS provider_rate_limited INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS provider_pages_retrieved INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS provider_budget_ledger (
  provider_key TEXT NOT NULL REFERENCES discovery_provider_registry(provider_key) ON DELETE RESTRICT,
  budget_day DATE NOT NULL,
  cycle_key TEXT NOT NULL,
  reserved_cents BIGINT NOT NULL DEFAULT 0 CHECK(reserved_cents >= 0),
  consumed_cents BIGINT NOT NULL DEFAULT 0 CHECK(consumed_cents >= 0),
  requests_attempted INTEGER NOT NULL DEFAULT 0 CHECK(requests_attempted >= 0),
  requests_succeeded INTEGER NOT NULL DEFAULT 0 CHECK(requests_succeeded >= 0),
  requests_failed INTEGER NOT NULL DEFAULT 0 CHECK(requests_failed >= 0),
  rate_limited INTEGER NOT NULL DEFAULT 0 CHECK(rate_limited >= 0),
  active_requests INTEGER NOT NULL DEFAULT 0 CHECK(active_requests >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(provider_key, budget_day, cycle_key)
);

CREATE TABLE IF NOT EXISTS provider_request_ledger (
  request_id TEXT PRIMARY KEY,
  provider_key TEXT NOT NULL REFERENCES discovery_provider_registry(provider_key) ON DELETE RESTRICT,
  query_run_id UUID REFERENCES query_runs(id) ON DELETE SET NULL,
  reservation_id TEXT NOT NULL,
  budget_day DATE NOT NULL,
  cycle_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('RESERVED','SUCCEEDED','FAILED','RATE_LIMITED','RELEASED')),
  reserved_cents BIGINT NOT NULL DEFAULT 0 CHECK(reserved_cents >= 0),
  consumed_cents BIGINT NOT NULL DEFAULT 0 CHECK(consumed_cents >= 0),
  pricing_version TEXT NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at TIMESTAMPTZ,
  error_code TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS provider_request_ledger_run_idx ON provider_request_ledger(query_run_id, attempted_at);
CREATE INDEX IF NOT EXISTS provider_request_ledger_provider_day_idx ON provider_request_ledger(provider_key, budget_day, status);

ALTER TABLE discovery_candidate_staging
  ADD COLUMN IF NOT EXISTS canonical_candidate_key TEXT,
  ADD COLUMN IF NOT EXISTS resolution_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_resolution_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_resolution_error TEXT,
  ADD COLUMN IF NOT EXISTS resolution_job_id UUID REFERENCES jobs(id) ON DELETE SET NULL;

UPDATE discovery_candidate_staging
SET canonical_candidate_key = encode(digest(candidate_type || ':' || lower(trim(normalized_identity)), 'sha256'), 'hex')
WHERE canonical_candidate_key IS NULL;

-- Keep the earliest canonical row and retain all discovery surfaces as observations.
CREATE TABLE IF NOT EXISTS discovery_candidate_observations (
  observation_key TEXT PRIMARY KEY,
  staging_id UUID NOT NULL REFERENCES discovery_candidate_staging(id) ON DELETE CASCADE,
  canonical_candidate_key TEXT NOT NULL,
  provider_key TEXT NOT NULL REFERENCES discovery_provider_registry(provider_key) ON DELETE RESTRICT,
  retrieval_surface TEXT NOT NULL,
  provider_capability TEXT NOT NULL,
  candidate_type TEXT NOT NULL,
  normalized_identity TEXT NOT NULL,
  raw_locator TEXT NOT NULL,
  query_run_id UUID REFERENCES query_runs(id) ON DELETE SET NULL,
  opportunity_key TEXT,
  country TEXT NOT NULL,
  language TEXT,
  neighborhood_key TEXT,
  discovery_mode TEXT NOT NULL,
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(staging_id, observation_key)
);
CREATE INDEX IF NOT EXISTS candidate_observations_canonical_idx ON discovery_candidate_observations(canonical_candidate_key, observed_at);
CREATE INDEX IF NOT EXISTS candidate_observations_query_idx ON discovery_candidate_observations(query_run_id, observed_at);

INSERT INTO discovery_candidate_observations(
  observation_key, staging_id, canonical_candidate_key, provider_key, retrieval_surface,
  provider_capability, candidate_type, normalized_identity, raw_locator, query_run_id,
  opportunity_key, country, language, neighborhood_key, discovery_mode, provenance, metadata, observed_at
)
SELECT encode(digest('legacy:' || s.id::text, 'sha256'), 'hex'), s.id,
       s.canonical_candidate_key, s.provider_key, s.retrieval_surface, s.provider_capability,
       s.candidate_type, s.normalized_identity, s.raw_locator, s.query_run_id, s.opportunity_key,
       s.country, s.language, s.neighborhood_key, s.discovery_mode, s.provenance, s.metadata, s.discovered_at
FROM discovery_candidate_staging s
WHERE NOT EXISTS (
  SELECT 1 FROM discovery_candidate_observations o WHERE o.staging_id=s.id
);

-- Re-parent duplicate observations to the earliest canonical row before deleting
-- duplicate staging rows; provenance must survive deduplication.
WITH ranked AS (
  SELECT id, canonical_candidate_key,
         FIRST_VALUE(id) OVER (PARTITION BY canonical_candidate_key ORDER BY discovered_at ASC, id ASC) AS keeper_id,
         ROW_NUMBER() OVER (PARTITION BY canonical_candidate_key ORDER BY discovered_at ASC, id ASC) AS rn
  FROM discovery_candidate_staging
), duplicate_map AS (
  SELECT id AS duplicate_id, keeper_id
  FROM ranked
  WHERE rn>1
)
UPDATE discovery_candidate_observations o
SET staging_id=m.keeper_id
FROM duplicate_map m
WHERE o.staging_id=m.duplicate_id;

WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY canonical_candidate_key ORDER BY discovered_at ASC, id ASC) AS rn
  FROM discovery_candidate_staging
)
DELETE FROM discovery_candidate_staging s
USING ranked r
WHERE s.id=r.id AND r.rn>1;

ALTER TABLE discovery_candidate_staging
  ALTER COLUMN canonical_candidate_key SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS discovery_candidate_staging_canonical_key_uq
  ON discovery_candidate_staging(canonical_candidate_key);
CREATE INDEX IF NOT EXISTS discovery_candidate_staging_resolution_due_idx
  ON discovery_candidate_staging(resolution_status, next_resolution_at, discovered_at);

INSERT INTO app_settings(setting_key, setting_value) VALUES
  ('brave_cost_per_request_usd', '0.005'),
  ('brave_pricing_version', 'search-api-2026-02'),
  ('brave_daily_cost_cap_usd', '5'),
  ('brave_concurrency_cap', '1'),
  ('brave_pagination_max_pages', '3'),
  ('brave_cooldown_until', ''),
  ('brave_cycle_key', 'default')
ON CONFLICT (setting_key) DO NOTHING;

UPDATE discovery_provider_registry
SET cost_unit='USD_PER_REQUEST', pricing_version=COALESCE(NULLIF((SELECT setting_value FROM app_settings WHERE setting_key='brave_pricing_version'), ''), pricing_version)
WHERE provider_key='brave-search';

ALTER TABLE query_runs
  ADD CONSTRAINT query_run_provider_cost_nonnegative CHECK(provider_reserved_amount>=0 AND provider_cost_usd>=0);
