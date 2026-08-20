-- Migration 106: Checkpoint 6 / Phase 10 — Country-Native Intelligence

-- 1. Additive observation-level geography, locale, code-switching, and deterministic observation_key fields to terminology_observations
ALTER TABLE terminology_observations
  ADD COLUMN IF NOT EXISTS source_creator_country TEXT,
  ADD COLUMN IF NOT EXISTS target_market_country TEXT,
  ADD COLUMN IF NOT EXISTS locale TEXT,
  ADD COLUMN IF NOT EXISTS is_code_switched BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS native_language TEXT,
  ADD COLUMN IF NOT EXISTS term_language TEXT,
  ADD COLUMN IF NOT EXISTS native_evidence_status TEXT CHECK (native_evidence_status IN ('NATIVE_OBSERVED', 'BOOTSTRAP_SEED', 'TRANSLATED_SEED')),
  ADD COLUMN IF NOT EXISTS source_provenance_family TEXT CHECK (source_provenance_family IN ('CREATOR_METADATA', 'STRUCTURED_LOCAL_ENTITY', 'COUNTRY_VOCABULARY', 'STATIC_BOOTSTRAP', 'TRANSLATED_QUERY')),
  ADD COLUMN IF NOT EXISTS code_switch_type TEXT,
  ADD COLUMN IF NOT EXISTS observation_key TEXT UNIQUE;

CREATE INDEX IF NOT EXISTS idx_term_obs_creator_country ON terminology_observations(source_creator_country);
CREATE INDEX IF NOT EXISTS idx_term_obs_market_country ON terminology_observations(target_market_country);
CREATE INDEX IF NOT EXISTS idx_term_obs_status ON terminology_observations(native_evidence_status);
CREATE INDEX IF NOT EXISTS idx_term_obs_key ON terminology_observations(observation_key);

-- 2. Derived, idempotent aggregate country-native evidence projection table
CREATE TABLE IF NOT EXISTS country_native_evidence_projections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_term_id BIGINT NOT NULL UNIQUE REFERENCES canonical_trading_terms(id) ON DELETE CASCADE,
  concept_id UUID REFERENCES concepts(id) ON DELETE SET NULL,
  country TEXT NOT NULL,
  dominant_locale TEXT NOT NULL DEFAULT 'und',
  observed_creator_countries JSONB NOT NULL DEFAULT '[]'::jsonb,
  observed_market_countries JSONB NOT NULL DEFAULT '[]'::jsonb,
  code_switch_ratio REAL NOT NULL DEFAULT 0.0,
  is_code_switched BOOLEAN NOT NULL DEFAULT false,
  code_switch_type TEXT,
  code_switch_types JSONB NOT NULL DEFAULT '[]'::jsonb,
  code_switch_type_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_observation_count INTEGER NOT NULL DEFAULT 0,
  native_observed_count INTEGER NOT NULL DEFAULT 0,
  bootstrap_seed_count INTEGER NOT NULL DEFAULT 0,
  translated_seed_count INTEGER NOT NULL DEFAULT 0,
  native_observed_ratio REAL NOT NULL DEFAULT 0.0,
  distinct_creator_count INTEGER NOT NULL DEFAULT 0,
  quality_creator_count INTEGER NOT NULL DEFAULT 0,
  distinct_community_count INTEGER NOT NULL DEFAULT 0,
  structured_entity_matched BOOLEAN NOT NULL DEFAULT false,
  native_evidence_status TEXT NOT NULL DEFAULT 'NATIVE_OBSERVED' CHECK (native_evidence_status IN ('NATIVE_OBSERVED', 'BOOTSTRAP_SEED', 'TRANSLATED_SEED')),
  source_provenance_family TEXT NOT NULL DEFAULT 'CREATOR_METADATA' CHECK (source_provenance_family IN ('CREATOR_METADATA', 'STRUCTURED_LOCAL_ENTITY', 'COUNTRY_VOCABULARY', 'STATIC_BOOTSTRAP', 'TRANSLATED_QUERY')),
  source_provenance_families JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_provenance_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  native_confidence_score REAL NOT NULL DEFAULT 0.0,
  native_proposal_eligible BOOLEAN NOT NULL DEFAULT false,
  last_observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_country_native_proj_country ON country_native_evidence_projections(country);
CREATE INDEX IF NOT EXISTS idx_country_native_proj_eligible ON country_native_evidence_projections(country, native_proposal_eligible);
CREATE INDEX IF NOT EXISTS idx_country_native_proj_status ON country_native_evidence_projections(native_evidence_status);

-- 3. Performance attribution table tracking executions and net-new creators by native provenance
CREATE TABLE IF NOT EXISTS country_native_performance_attribution (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_term_id BIGINT NOT NULL REFERENCES canonical_trading_terms(id) ON DELETE CASCADE,
  query_id INTEGER REFERENCES query_library(id) ON DELETE SET NULL,
  query_run_id UUID REFERENCES query_runs(id) ON DELETE SET NULL,
  country TEXT NOT NULL,
  native_evidence_status TEXT NOT NULL CHECK (native_evidence_status IN ('NATIVE_OBSERVED', 'BOOTSTRAP_SEED', 'TRANSLATED_SEED')),
  source_provenance_family TEXT NOT NULL CHECK (source_provenance_family IN ('CREATOR_METADATA', 'STRUCTURED_LOCAL_ENTITY', 'COUNTRY_VOCABULARY', 'STATIC_BOOTSTRAP', 'TRANSLATED_QUERY')),
  is_code_switched BOOLEAN NOT NULL DEFAULT false,
  executed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_results INTEGER NOT NULL DEFAULT 0,
  unique_creators INTEGER NOT NULL DEFAULT 0,
  new_creators INTEGER NOT NULL DEFAULT 0,
  quality_creators INTEGER NOT NULL DEFAULT 0,
  confirmed_trading_creators INTEGER NOT NULL DEFAULT 0,
  quota_consumed INTEGER NOT NULL DEFAULT 0,
  yield_score REAL NOT NULL DEFAULT 0.0,
  coverage_expansion_gain REAL NOT NULL DEFAULT 0.0
);

CREATE INDEX IF NOT EXISTS idx_country_native_attr_term ON country_native_performance_attribution(canonical_term_id);
CREATE INDEX IF NOT EXISTS idx_country_native_attr_country ON country_native_performance_attribution(country);
CREATE INDEX IF NOT EXISTS idx_country_native_attr_status ON country_native_performance_attribution(native_evidence_status);

-- 4. Diagnostics view summarizing concept coverage, provenance split, and code-switching rates
CREATE OR REPLACE VIEW country_native_coverage_diagnostics AS
SELECT
  p.country,
  COUNT(p.id)::int AS total_native_concepts,
  COUNT(p.id) FILTER (WHERE p.native_evidence_status = 'NATIVE_OBSERVED')::int AS native_observed_concepts,
  COUNT(p.id) FILTER (WHERE p.native_evidence_status = 'BOOTSTRAP_SEED')::int AS bootstrap_seed_concepts,
  COUNT(p.id) FILTER (WHERE p.native_evidence_status = 'TRANSLATED_SEED')::int AS translated_seed_concepts,
  COUNT(p.id) FILTER (WHERE p.source_provenance_family = 'STRUCTURED_LOCAL_ENTITY')::int AS structured_entity_concepts,
  COUNT(p.id) FILTER (WHERE p.is_code_switched = true)::int AS code_switched_concepts,
  COUNT(p.id) FILTER (WHERE p.native_proposal_eligible = true)::int AS proposal_eligible_concepts,
  (COUNT(p.id) FILTER (WHERE p.native_evidence_status = 'NATIVE_OBSERVED') < 3)::boolean AS weak_native_evidence,
  (COUNT(p.id) FILTER (WHERE p.native_evidence_status = 'TRANSLATED_SEED') > COUNT(p.id) FILTER (WHERE p.native_evidence_status = 'NATIVE_OBSERVED'))::boolean AS heavy_english_reliance,
  COALESCE(SUM(p.quality_creator_count), 0)::int AS quality_creators_discovered
FROM country_native_evidence_projections p
GROUP BY p.country;
