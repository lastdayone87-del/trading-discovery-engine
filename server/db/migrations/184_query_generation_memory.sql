-- Query generation memory and batch cache.
--
-- This is deliberately separate from query_library: query_library is the
-- executable inventory. These tables remember generated/rejected candidates
-- and the raw provider batch so repeated cycles can skip exact work without
-- granting search authority.

CREATE TABLE IF NOT EXISTS query_candidate_memory (
  id BIGSERIAL PRIMARY KEY,
  country TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'und',
  source TEXT NOT NULL,
  mode TEXT NOT NULL,
  normalized_query TEXT NOT NULL,
  semantic_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('GENERATED', 'PROPOSED', 'ADMITTED', 'REJECTED', 'DUPLICATE')),
  reason_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
  batch_key TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(country, language, normalized_query)
);

CREATE INDEX IF NOT EXISTS idx_query_candidate_memory_country
  ON query_candidate_memory(country, language, status, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_query_candidate_memory_lower_country
  ON query_candidate_memory(LOWER(country), language, status, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_query_candidate_memory_semantic
  ON query_candidate_memory(country, semantic_key);
CREATE INDEX IF NOT EXISTS idx_query_candidate_memory_batch
  ON query_candidate_memory(batch_key) WHERE batch_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS query_generation_batches (
  batch_key TEXT PRIMARY KEY,
  country TEXT NOT NULL,
  language TEXT NOT NULL,
  source TEXT NOT NULL,
  mode TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  prompt_version TEXT,
  input_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('PENDING', 'COMPLETED', 'LOW_NOVELTY', 'FAILED')),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  duplicate_rate NUMERIC(8,4),
  accepted_count INTEGER NOT NULL DEFAULT 0,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_query_generation_batches_lookup
  ON query_generation_batches(country, language, source, mode, expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_query_generation_batches_lower_country
  ON query_generation_batches(LOWER(country), language, source, mode, expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_query_generation_batches_expiry
  ON query_generation_batches(expires_at) WHERE expires_at IS NOT NULL;
