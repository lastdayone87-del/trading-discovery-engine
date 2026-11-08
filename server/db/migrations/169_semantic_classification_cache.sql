-- Migration 169: Phase 4 semantic result cache.
--
-- The cache is keyed by the attribution-free evidence fingerprint plus every
-- model-facing version input. It stores only the final parsed semantic result,
-- never a whole classification decision: deterministic providers still run on
-- every evaluation, so a cache hit cannot freeze a stale evidence decision.
--
-- Rows are written append-only (ON CONFLICT DO NOTHING). Hits are counted for
-- observability so operators can measure quota savings before enabling the
-- batch path. A corrupt row is ignored by the reader and deleted; it is never
-- treated as evidence.
CREATE TABLE IF NOT EXISTS semantic_classification_cache (
  cache_key TEXT PRIMARY KEY,
  input_checksum TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  feature_version TEXT NOT NULL,
  model_version TEXT NOT NULL,
  adjudicator_model_version TEXT,
  adjudication_enabled BOOLEAN NOT NULL DEFAULT false,
  provider TEXT NOT NULL,
  result JSONB NOT NULL,
  fallback_used BOOLEAN NOT NULL DEFAULT false,
  repair_prompt_version TEXT,
  batch_prompt_version TEXT,
  hits INTEGER NOT NULL DEFAULT 0 CHECK(hits >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_hit_at TIMESTAMPTZ,
  CHECK(jsonb_typeof(result)='object')
);

-- A database that applied this migration before the batch column existed must
-- still converge: CREATE TABLE IF NOT EXISTS does not add columns.
ALTER TABLE semantic_classification_cache
  ADD COLUMN IF NOT EXISTS batch_prompt_version TEXT;

-- The retention expression index lives in migration 170 so databases that
-- already applied this migration still converge on the documented purge query.
COMMENT ON TABLE semantic_classification_cache IS
  'Phase 4: final semantic-model result keyed by evidence checksum + prompt/feature/model versions. Fail-open; never authoritative evidence.';
COMMENT ON COLUMN semantic_classification_cache.input_checksum IS
  'Model-facing semantic prompt fingerprint (declared context plus bounded documents; retrieval-only evidence, attribution, and audience counters excluded).';
COMMENT ON COLUMN semantic_classification_cache.batch_prompt_version IS
  'Batch prompt version in effect when the result was cached (set for every call while batching is enabled, NULL otherwise); purging by version also removes single-call rows written under batching.';
COMMENT ON COLUMN semantic_classification_cache.hits IS
  'Number of cache reads that returned this row; used to measure quota savings.';
