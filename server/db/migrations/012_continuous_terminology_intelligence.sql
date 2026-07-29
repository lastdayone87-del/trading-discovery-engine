CREATE TABLE canonical_trading_terms (
  id BIGSERIAL PRIMARY KEY,
  canonical_term TEXT NOT NULL,
  normalized_term TEXT NOT NULL,
  country TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'und',
  script TEXT NOT NULL DEFAULT 'Zyyy',
  term_type TEXT NOT NULL CHECK (term_type IN ('TERMINOLOGY','INSTRUMENT','PHRASE','FORMAT','BRAND')),
  trust_tier SMALLINT NOT NULL DEFAULT 3 CHECK (trust_tier BETWEEN 1 AND 4),
  search_eligible BOOLEAN NOT NULL DEFAULT false,
  classification_eligible BOOLEAN NOT NULL DEFAULT false,
  country_evidence_eligible BOOLEAN NOT NULL DEFAULT false,
  lifecycle_status TEXT NOT NULL DEFAULT 'CANDIDATE' CHECK (lifecycle_status IN ('CANDIDATE','OBSERVED','MULTI_CREATOR_VALIDATED','SEARCH_TRIAL','PROVEN_SEARCH_TERM','DEMOTED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  first_observed_at TIMESTAMPTZ,
  last_observed_at TIMESTAMPTZ,
  UNIQUE(country, normalized_term)
);

CREATE TABLE trading_term_aliases (
  id BIGSERIAL PRIMARY KEY,
  canonical_term_id BIGINT NOT NULL REFERENCES canonical_trading_terms(id),
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'und',
  script TEXT NOT NULL DEFAULT 'Zyyy',
  alias_type TEXT NOT NULL DEFAULT 'SPELLING' CHECK (alias_type IN ('ABBREVIATION','SPELLING','TRANSLITERATION','SHORTHAND','REGIONAL','SPELLING_VARIANT')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(canonical_term_id, normalized_alias)
);

-- Append-only provenance ledger: observations are never overwritten or deleted.
CREATE TABLE terminology_observations (
  id BIGSERIAL PRIMARY KEY,
  canonical_term_id BIGINT NOT NULL REFERENCES canonical_trading_terms(id),
  alias_id BIGINT REFERENCES trading_term_aliases(id),
  source_channel_id TEXT REFERENCES channels(channel_id),
  source_video_id TEXT,
  observation_type TEXT NOT NULL CHECK (observation_type IN ('CHANNEL_NAME','VIDEO_TITLE','DESCRIPTION','ENRICHMENT','HUMAN_APPROVED_CHANNEL')),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  human_approval_id UUID REFERENCES channel_review_decisions(id),
  human_approved BOOLEAN NOT NULL DEFAULT false,
  community_fingerprint TEXT,
  evidence_weight NUMERIC(8,4) NOT NULL DEFAULT 1,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE terminology_performance (
  id BIGSERIAL PRIMARY KEY,
  canonical_term_id BIGINT NOT NULL REFERENCES canonical_trading_terms(id),
  query_id INTEGER REFERENCES query_library(id),
  retrieval_lane TEXT NOT NULL DEFAULT 'UNKNOWN',
  executed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  executions INTEGER NOT NULL DEFAULT 1,
  raw_results INTEGER NOT NULL DEFAULT 0,
  unique_creators INTEGER NOT NULL DEFAULT 0,
  new_creators INTEGER NOT NULL DEFAULT 0,
  confirmed_trading_creators INTEGER NOT NULL DEFAULT 0,
  needs_review_creators INTEGER NOT NULL DEFAULT 0,
  non_trading_creators INTEGER NOT NULL DEFAULT 0,
  wrong_country_creators INTEGER NOT NULL DEFAULT 0,
  communities_discovered INTEGER NOT NULL DEFAULT 0,
  quota_consumed INTEGER NOT NULL DEFAULT 0,
  decayed_yield_score NUMERIC(8,4) NOT NULL DEFAULT 0
);

CREATE TABLE terminology_lifecycle_events (
  id BIGSERIAL PRIMARY KEY,
  canonical_term_id BIGINT NOT NULL REFERENCES canonical_trading_terms(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('PROMOTION','DEMOTION','ELIGIBILITY_CHANGE')),
  reason TEXT NOT NULL,
  evidence_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE terminology_score_snapshots (
  id BIGSERIAL PRIMARY KEY,
  canonical_term_id BIGINT NOT NULL REFERENCES canonical_trading_terms(id),
  scored_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  distinct_creators INTEGER NOT NULL,
  distinct_communities INTEGER NOT NULL,
  human_approved_creators INTEGER NOT NULL,
  decayed_evidence NUMERIC(10,4) NOT NULL,
  decayed_yield_score NUMERIC(8,4) NOT NULL,
  lifecycle_status TEXT NOT NULL,
  scoring_version TEXT NOT NULL DEFAULT 'phase-f-v1',
  configuration JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_term_country_lifecycle ON canonical_trading_terms(country, lifecycle_status, search_eligible);
CREATE INDEX idx_alias_normalized ON trading_term_aliases(normalized_alias);
CREATE INDEX idx_observation_term_date ON terminology_observations(canonical_term_id, observed_at DESC);
CREATE INDEX idx_observation_creator ON terminology_observations(canonical_term_id, source_channel_id);
CREATE INDEX idx_term_performance_date ON terminology_performance(canonical_term_id, executed_at DESC);
CREATE INDEX idx_term_events_date ON terminology_lifecycle_events(canonical_term_id, created_at DESC);

-- Preserve flat vocabulary history while moving all future learning to canonical terms.
INSERT INTO canonical_trading_terms(canonical_term, normalized_term, country, term_type, trust_tier, first_observed_at, last_observed_at)
SELECT term, lower(regexp_replace(trim(term), '\\s+', ' ', 'g')), country,
       CASE category WHEN 'instrument' THEN 'INSTRUMENT' WHEN 'phrase' THEN 'PHRASE' WHEN 'format' THEN 'FORMAT' ELSE 'TERMINOLOGY' END,
       trust_tier, first_extracted, last_extracted
FROM extracted_trading_vocabulary
ON CONFLICT(country, normalized_term) DO NOTHING;
