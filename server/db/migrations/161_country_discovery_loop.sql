-- Migration 161: Country Discovery Loop (CDL)
--
-- Additive and idempotent. This migration:
--   1. separates promotion-eligible native evidence from observation-only noise;
--   2. adds page-level economics and run-level resumable progress;
--   3. adds the AI extraction budget ledger;
--   4. adds durable free-signal and optional paid-demand signal stores;
--   5. activates the approved core CDL/v2/extraction/continuation settings while
--      preserving explicit operator overrides and unrelated production settings.
--
-- It never drops a table/column, rewrites unrelated settings, changes country
-- scope, or enables the paid demand adapter.

-- ---------------------------------------------------------------------------
-- 1. Promotion eligibility (native evidence v2)
-- ---------------------------------------------------------------------------
ALTER TABLE terminology_observations
  ADD COLUMN IF NOT EXISTS promotion_eligible BOOLEAN NOT NULL DEFAULT false;

-- Idempotent backfill from CURRENT channel state. The backfill is deliberately
-- conservative: only rows that already look native (NATIVE_OBSERVED or null
-- status) and whose current creator still passes every gate become eligible.
-- Rows with no channel identity stay false. Null provenance is normalized to
-- CREATOR_METADATA only for rows that pass, matching the v2 writer contract.
UPDATE terminology_observations o
SET promotion_eligible = true,
    native_evidence_status = COALESCE(o.native_evidence_status, 'NATIVE_OBSERVED'),
    source_provenance_family = COALESCE(o.source_provenance_family, 'CREATOR_METADATA')
FROM channels c, canonical_trading_terms t
WHERE o.canonical_term_id = t.id
  AND o.source_channel_id = c.channel_id
  AND o.promotion_eligible = false
  AND c.country_status = 'CONFIRMED'
  AND c.trading_status = 'TRADING_CONFIRMED'
  AND COALESCE(c.quality_score, 0) >= 55
  AND c.country IS NOT NULL
  AND lower(c.country) = lower(t.country)
  AND (o.source_creator_country IS NULL OR lower(o.source_creator_country) = lower(t.country))
  AND (o.target_market_country IS NULL OR lower(o.target_market_country) = lower(t.country))
  AND (o.native_evidence_status IS NULL OR o.native_evidence_status = 'NATIVE_OBSERVED')
  AND (o.source_provenance_family IS NULL OR o.source_provenance_family = 'CREATOR_METADATA')
  AND COALESCE(o.is_code_switched, false) = false
  AND (o.term_language IS NULL OR o.native_language IS NULL OR lower(o.term_language) = lower(o.native_language));

CREATE INDEX IF NOT EXISTS idx_term_obs_promotion
  ON terminology_observations(canonical_term_id, promotion_eligible);

-- Page provenance for novelty attribution: a term observed while processing a
-- specific autonomous page belongs to that run/page, never to another run that
-- happens to share the channel or timestamp window.
ALTER TABLE terminology_observations
  ADD COLUMN IF NOT EXISTS query_run_id TEXT;
ALTER TABLE terminology_observations
  ADD COLUMN IF NOT EXISTS query_page_number INTEGER;
CREATE INDEX IF NOT EXISTS idx_term_obs_run_page
  ON terminology_observations(query_run_id, query_page_number)
  WHERE query_run_id IS NOT NULL;

-- External terminology corroboration is looked up by the local surface, not
-- only by country: filtering a country-wide LIMIT in JavaScript can drop a
-- term's valid evidence behind 1,000 newer rows for other terms. The stored
-- canonical_concept is application-normalized with the same NFKC, whitespace
-- collapse, trim, and English lowercase mapping as normalizeTerm. Matching it
-- avoids PostgreSQL lower(), whose case mapping follows the database collation
-- (for example Turkish I) and can discard valid observations before the
-- JavaScript evaluator sees them.
CREATE INDEX IF NOT EXISTS idx_external_osint_surface_country
  ON external_osint_observations(country, canonical_concept, observed_at DESC);

-- Promotion yield must count creators that are BOTH newly discovered and
-- trading-confirmed. The aggregate new/confirmed totals can describe different
-- creators, so min(confirmed,new) is not an upper bound on this intersection.
-- Attribution records the exact per-run intersection; legacy rows default to
-- zero (unknown), which can only HOLD a promotion, never inflate one.
ALTER TABLE terminology_performance
  ADD COLUMN IF NOT EXISTS fresh_confirmed_trading_creators INTEGER NOT NULL DEFAULT 0
    CHECK (fresh_confirmed_trading_creators >= 0);

-- ---------------------------------------------------------------------------
-- 2. Page economics and continuation audit
-- ---------------------------------------------------------------------------
ALTER TABLE autonomous_query_page_observations
  ADD COLUMN IF NOT EXISTS elapsed_ms INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS retrieval_ms INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS processing_ms INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS marginal_new_creators INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS marginal_confirmed_creators INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS marginal_quality_creators INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS marginal_non_trading_creators INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS novel_candidate_terms INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cross_page_repeat_creators INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cumulative_unique_creators INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS provider_page_cost_units INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS provider_page_cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS relevance JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS marginal_utility_v2 NUMERIC(8,5) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS continuation_decision_v2 JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS resume_mode TEXT NOT NULL DEFAULT 'NONE',
  ADD COLUMN IF NOT EXISTS deferred_reason TEXT;

ALTER TABLE autonomous_query_page_observations
  DROP CONSTRAINT IF EXISTS chk_page_obs_resume_mode;
ALTER TABLE autonomous_query_page_observations
  ADD CONSTRAINT chk_page_obs_resume_mode
  CHECK (resume_mode IN ('TOKEN', 'REWALK', 'OFFSET', 'NONE')) NOT VALID;
ALTER TABLE autonomous_query_page_observations
  VALIDATE CONSTRAINT chk_page_obs_resume_mode;

ALTER TABLE autonomous_query_page_observations
  DROP CONSTRAINT IF EXISTS chk_page_obs_deferred_reason;
ALTER TABLE autonomous_query_page_observations
  ADD CONSTRAINT chk_page_obs_deferred_reason
  CHECK (deferred_reason IS NULL OR deferred_reason IN ('QUOTA', 'TIME')) NOT VALID;
ALTER TABLE autonomous_query_page_observations
  VALIDATE CONSTRAINT chk_page_obs_deferred_reason;

CREATE INDEX IF NOT EXISTS idx_autonomous_pages_economics
  ON autonomous_query_page_observations(query_run_id, page_number, marginal_quality_creators);

-- ---------------------------------------------------------------------------
-- 3. Run-level resumable progress
-- ---------------------------------------------------------------------------
ALTER TABLE query_runs
  ADD COLUMN IF NOT EXISTS pages_completed INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_page_token TEXT,
  ADD COLUMN IF NOT EXISTS resume_mode TEXT NOT NULL DEFAULT 'NONE',
  ADD COLUMN IF NOT EXISTS run_quota_budget_units INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS run_quota_consumed_units INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS continuation_status TEXT NOT NULL DEFAULT 'RUNNING',
  ADD COLUMN IF NOT EXISTS deferred_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_page_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS exploration_pages_remaining INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS effective_max_pages INTEGER,
  ADD COLUMN IF NOT EXISTS effective_binding_bound TEXT,
  ADD COLUMN IF NOT EXISTS requested_page_depth INTEGER,
  ADD COLUMN IF NOT EXISTS resume_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS resume_rewalk_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS continued_from_run_id TEXT,
  ADD COLUMN IF NOT EXISTS continued_to_run_id TEXT,
  ADD COLUMN IF NOT EXISTS continuation_segment INTEGER NOT NULL DEFAULT 0;

ALTER TABLE query_runs
  DROP CONSTRAINT IF EXISTS chk_query_runs_resume_mode;
ALTER TABLE query_runs
  ADD CONSTRAINT chk_query_runs_resume_mode
  CHECK (resume_mode IN ('TOKEN', 'REWALK', 'OFFSET', 'NONE')) NOT VALID;
ALTER TABLE query_runs
  VALIDATE CONSTRAINT chk_query_runs_resume_mode;

ALTER TABLE query_runs
  DROP CONSTRAINT IF EXISTS chk_query_runs_effective_binding_bound;
ALTER TABLE query_runs
  ADD CONSTRAINT chk_query_runs_effective_binding_bound
  CHECK (effective_binding_bound IS NULL OR effective_binding_bound IN ('SAFETY', 'PROVIDER', 'RUN_BUDGET', 'TREATMENT', 'TRIAL')) NOT VALID;
ALTER TABLE query_runs
  VALIDATE CONSTRAINT chk_query_runs_effective_binding_bound;

ALTER TABLE query_runs
  DROP CONSTRAINT IF EXISTS chk_query_runs_requested_page_depth;
ALTER TABLE query_runs
  ADD CONSTRAINT chk_query_runs_requested_page_depth
  CHECK (requested_page_depth IS NULL OR requested_page_depth BETWEEN 1 AND 3) NOT VALID;
ALTER TABLE query_runs
  VALIDATE CONSTRAINT chk_query_runs_requested_page_depth;

ALTER TABLE query_runs
  DROP CONSTRAINT IF EXISTS chk_query_runs_continuation_status;
ALTER TABLE query_runs
  ADD CONSTRAINT chk_query_runs_continuation_status
  CHECK (continuation_status IN ('RUNNING', 'DEFERRED_QUOTA', 'DEFERRED_TIME', 'COMPLETE', 'FAILED', 'RESUME_UNAVAILABLE')) NOT VALID;
ALTER TABLE query_runs
  VALIDATE CONSTRAINT chk_query_runs_continuation_status;

-- Migration 066 froze every completed query_run. Continuation state is
-- bookkeeping that must remain writable after completion: this backfill
-- normalizes terminal rows and the runtime links a completed parent to its
-- continuation child. Replace the trigger function with an explicit
-- continuation-metadata allowlist; every metric, status, timestamp, and
-- provider column stays immutable. DELETE remains forbidden.
CREATE OR REPLACE FUNCTION reject_completed_query_run_mutation() RETURNS trigger AS $$
DECLARE
  continuation_columns CONSTANT text[] := ARRAY[
    'continuation_status',
    'deferred_until',
    'last_page_at',
    'exploration_pages_remaining',
    'effective_max_pages',
    'effective_binding_bound',
    'requested_page_depth',
    'resume_count',
    'resume_rewalk_count',
    'continued_from_run_id',
    'continued_to_run_id',
    'continuation_segment',
    'next_page_token',
    'resume_mode'
  ];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'COMPLETED' THEN
      RAISE EXCEPTION 'completed query_runs are immutable';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'COMPLETED'
     AND (to_jsonb(OLD) - continuation_columns) IS DISTINCT FROM (to_jsonb(NEW) - continuation_columns) THEN
    RAISE EXCEPTION 'completed query_runs are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Existing terminal runs keep truthful continuation state. Idempotent by
-- construction: the CASE is stable for already-normalized rows.
UPDATE query_runs
SET continuation_status = CASE
  WHEN status = 'COMPLETED' THEN 'COMPLETE'
  WHEN status = 'FAILED' THEN 'FAILED'
  ELSE COALESCE(NULLIF(continuation_status, ''), 'RUNNING')
END
WHERE continuation_status IS NULL
   OR continuation_status = ''
   OR (status = 'COMPLETED' AND continuation_status <> 'COMPLETE')
   OR (status = 'FAILED' AND continuation_status <> 'FAILED');

CREATE INDEX IF NOT EXISTS idx_query_runs_resume_pending
  ON query_runs(continuation_status, deferred_until, last_page_at)
  WHERE continuation_status IN ('RUNNING', 'DEFERRED_QUOTA', 'DEFERRED_TIME');
CREATE INDEX IF NOT EXISTS idx_query_runs_country_source
  ON query_runs(country, source, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_query_runs_continuation_segment
  ON query_runs(continued_from_run_id)
  WHERE continued_from_run_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. Native vocabulary AI budget ledger
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS native_vocabulary_ai_runs (
  request_id TEXT PRIMARY KEY,
  channel_id TEXT,
  country TEXT NOT NULL,
  metadata_hash TEXT NOT NULL,
  budget_day TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('RESERVED', 'SUCCEEDED', 'FAILED', 'BUDGET_SKIPPED')),
  provider TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  reserved_cost_microunits BIGINT NOT NULL DEFAULT 0,
  actual_cost_microunits BIGINT NOT NULL DEFAULT 0,
  -- Parsed provider output retained for idempotent admission replay. A retry
  -- after a persistence failure reuses this payload instead of spending a
  -- second logical call, and a stale RESERVED row is reclaimed by lease.
  response_payload JSONB,
  lease_expires_at TIMESTAMPTZ,
  -- Fencing token for the worker that currently owns the reservation. A
  -- reclaimed/replayed reservation rotates the token so a late write from the
  -- previous worker cannot overwrite the new owner's response or completion.
  lease_token TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
ALTER TABLE native_vocabulary_ai_runs
  ADD COLUMN IF NOT EXISTS response_payload JSONB;
ALTER TABLE native_vocabulary_ai_runs
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
ALTER TABLE native_vocabulary_ai_runs
  ADD COLUMN IF NOT EXISTS lease_token TEXT;
CREATE INDEX IF NOT EXISTS idx_native_vocab_ai_lease
  ON native_vocabulary_ai_runs(status, lease_expires_at)
  WHERE status='RESERVED';
CREATE INDEX IF NOT EXISTS idx_native_vocab_ai_day_country
  ON native_vocabulary_ai_runs(budget_day, country, status);
CREATE INDEX IF NOT EXISTS idx_native_vocab_ai_channel
  ON native_vocabulary_ai_runs(channel_id, budget_day);

-- ---------------------------------------------------------------------------
-- 5. Free query signals (Wikipedia/Wikidata enrichment; candidate vocabulary
--    only, never evidence) and optional paid demand signals (unused while off).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS free_query_signals (
  id BIGSERIAL PRIMARY KEY,
  country TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'und',
  signal_surface TEXT NOT NULL,
  normalized_surface TEXT NOT NULL,
  signal_type TEXT NOT NULL CHECK (signal_type IN ('ALIAS', 'INSTRUMENT', 'ENTITY', 'MARKET', 'METHOD', 'FORMAT', 'REGULATOR', 'EXCHANGE')),
  provider TEXT NOT NULL,
  provider_signal_id TEXT,
  source_url TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS unq_free_query_signals_identity
  ON free_query_signals(country, normalized_surface, signal_type, provider, COALESCE(provider_signal_id, ''));
CREATE INDEX IF NOT EXISTS idx_free_query_signals_country
  ON free_query_signals(country, language, signal_type, expires_at);
CREATE INDEX IF NOT EXISTS idx_free_query_signals_freshness
  ON free_query_signals(provider, fetched_at DESC);

CREATE TABLE IF NOT EXISTS query_demand_signals (
  id BIGSERIAL PRIMARY KEY,
  country TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'und',
  signal_surface TEXT NOT NULL,
  normalized_surface TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_signal_id TEXT,
  demand_score NUMERIC(12,6) NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS unq_query_demand_signals_identity
  ON query_demand_signals(country, normalized_surface, provider, COALESCE(provider_signal_id, ''));
CREATE INDEX IF NOT EXISTS idx_query_demand_signals_country
  ON query_demand_signals(country, language, expires_at);

-- ---------------------------------------------------------------------------
-- 6. Activation and defaults
-- ---------------------------------------------------------------------------
-- Insert-only activation: an explicit operator override (including a kill
-- switch set to false) is never silently replaced. This is the documented
-- operator-intent exception to automatic activation.
INSERT INTO app_settings(setting_key, setting_value) VALUES
  ('country_discovery_loop_enabled', 'true'),
  ('autonomous_pagination_enabled', 'true'),
  ('autonomous_pagination_v2_enabled', 'true'),
  ('autonomous_pagination_exploration_pages', '1'),
  ('autonomous_pagination_max_duplicate_pages', '2'),
  ('autonomous_pagination_max_wrong_country_pages', '2'),
  ('autonomous_pagination_min_run_pages', '1'),
  ('native_evidence_promotion_v2_enabled', 'true'),
  ('native_vocabulary_extraction_enabled', 'true'),
  ('native_vocabulary_ai_daily_calls', '200'),
  ('native_vocabulary_ai_country_daily_calls', '20'),
  ('native_vocabulary_ai_daily_cost_microunits', '5000000'),
  ('free_query_signals_enabled', 'true'),
  ('wikimedia_pageviews_enabled', 'false'),
  ('query_demand_signals_enabled', 'false')
ON CONFLICT(setting_key) DO NOTHING;

-- Raise the legacy seeded page ceiling (10) to the approved hard safety bound
-- (50). app_settings has no provenance column, so an operator-set value of
-- exactly 10 is indistinguishable from the seeded default and is raised too;
-- this is the explicitly accepted one-time PR #557 trade-off. Every other
-- configured value (including values below or above 10) is preserved exactly.
UPDATE app_settings
SET setting_value = '50'
WHERE setting_key = 'autonomous_pagination_max_pages'
  AND setting_value = '10';
INSERT INTO app_settings(setting_key, setting_value)
VALUES ('autonomous_pagination_max_pages', '50')
ON CONFLICT(setting_key) DO NOTHING;

-- The consecutive low-value threshold keeps its existing operator value (2);
-- only a missing row receives the approved default.
INSERT INTO app_settings(setting_key, setting_value)
VALUES ('autonomous_pagination_max_low_yield_pages', '2')
ON CONFLICT(setting_key) DO NOTHING;

-- Explicitly NOT modified here:
--   youtube_key_daily_cap_enforced (must remain true)
--   discovery_extraction_enabled (staging pipeline only; remains absent/OFF)
--   frontier_allocation_enabled, adaptive_discovery_pilot_enabled
--   probe flags/monitor/quota rows
--   query_demand_signals_enabled (insert-only false; paid prerequisites external)
