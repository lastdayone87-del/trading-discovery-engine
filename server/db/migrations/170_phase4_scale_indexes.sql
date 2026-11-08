-- Migration 170: Phase 4 scale-gate and cache-retention indexes.
--
-- The enrichment throughput query filters ENRICH_CHANNEL rows by created_at
-- and completed_at. Without these partial indexes it scans the full job
-- history and can exceed ENRICHMENT_SCALE_METRICS_TIMEOUT_MS on every start,
-- forcing the gate to fail closed. The cache purge query filters on
-- COALESCE(last_hit_at, created_at), so its index must use the same
-- expression; the plain created_at index from migration 169 cannot serve it.
--
-- Locking safety mirrors migrations 157, 160, and 168:
-- * Where an index already exists and is valid/ready, the DO block is a
--   catalog no-op.
-- * On a fresh database, jobs and the semantic cache are empty when
--   migrations run, so each one-time build is short.
-- * On a populated database where an index is unexpectedly absent, this
--   migration fails closed instead of holding a write-blocking lock. The
--   runner's pre-migration helper builds it with CREATE INDEX CONCURRENTLY
--   before this transactional file runs.
-- * The runner wraps each migration file in BEGIN/COMMIT, so the SQL itself
--   must not request a concurrent build.
SET LOCAL lock_timeout = '10s';

DO $$
DECLARE
  index_oid oid;
  index_valid boolean;
  index_ready boolean;
BEGIN
  SELECT c.oid, i.indisvalid, i.indisready
    INTO index_oid, index_valid, index_ready
    FROM pg_class c
    JOIN pg_index i ON i.indexrelid = c.oid
   WHERE c.oid = to_regclass('public.idx_jobs_enrich_created_at');

  IF index_oid IS NOT NULL AND (NOT index_valid OR NOT index_ready) THEN
    RAISE EXCEPTION 'idx_jobs_enrich_created_at exists but is not valid/ready; rebuild it CONCURRENTLY out-of-band before applying migration 170';
  END IF;

  IF index_oid IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.jobs LIMIT 1) THEN
      RAISE EXCEPTION 'jobs is populated and idx_jobs_enrich_created_at is absent; create it CONCURRENTLY out-of-band before applying migration 170';
    END IF;
    CREATE INDEX IF NOT EXISTS idx_jobs_enrich_created_at
      ON public.jobs (created_at)
      WHERE type='ENRICH_CHANNEL';
  END IF;
END $$;

DO $$
DECLARE
  index_oid oid;
  index_valid boolean;
  index_ready boolean;
BEGIN
  SELECT c.oid, i.indisvalid, i.indisready
    INTO index_oid, index_valid, index_ready
    FROM pg_class c
    JOIN pg_index i ON i.indexrelid = c.oid
   WHERE c.oid = to_regclass('public.idx_jobs_enrich_completed_at');

  IF index_oid IS NOT NULL AND (NOT index_valid OR NOT index_ready) THEN
    RAISE EXCEPTION 'idx_jobs_enrich_completed_at exists but is not valid/ready; rebuild it CONCURRENTLY out-of-band before applying migration 170';
  END IF;

  IF index_oid IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.jobs WHERE completed_at IS NOT NULL LIMIT 1) THEN
      RAISE EXCEPTION 'jobs has completed rows and idx_jobs_enrich_completed_at is absent; create it CONCURRENTLY out-of-band before applying migration 170';
    END IF;
    CREATE INDEX IF NOT EXISTS idx_jobs_enrich_completed_at
      ON public.jobs (completed_at)
      WHERE type='ENRICH_CHANNEL' AND completed_at IS NOT NULL;
  END IF;
END $$;

DO $$
DECLARE
  index_oid oid;
  index_valid boolean;
  index_ready boolean;
BEGIN
  SELECT c.oid, i.indisvalid, i.indisready
    INTO index_oid, index_valid, index_ready
    FROM pg_class c
    JOIN pg_index i ON i.indexrelid = c.oid
   WHERE c.oid = to_regclass('public.idx_semantic_cache_retention');

  IF index_oid IS NOT NULL AND (NOT index_valid OR NOT index_ready) THEN
    RAISE EXCEPTION 'idx_semantic_cache_retention exists but is not valid/ready; rebuild it CONCURRENTLY out-of-band before applying migration 170';
  END IF;

  IF index_oid IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.semantic_classification_cache LIMIT 1) THEN
      RAISE EXCEPTION 'semantic_classification_cache is populated and idx_semantic_cache_retention is absent; create it CONCURRENTLY out-of-band before applying migration 170';
    END IF;
    CREATE INDEX IF NOT EXISTS idx_semantic_cache_retention
      ON public.semantic_classification_cache ((COALESCE(last_hit_at, created_at)));
  END IF;
END $$;

-- Migration 169 created this index before the retention query was finalized.
-- Fresh databases no longer create it; already-migrated databases converge
-- here. The runner's helper drops it CONCURRENTLY before this transaction;
-- IF EXISTS keeps the migration safe on both paths.
DROP INDEX IF EXISTS idx_semantic_cache_created_at;

-- The original comment described NULL as "single call". With batching enabled
-- every call, including a batch of one, records the version; correct the
-- comment for databases that applied migration 169 before this wording was
-- finalized.
COMMENT ON COLUMN semantic_classification_cache.batch_prompt_version IS
  'Batch prompt version in effect when the result was cached (set for every call while batching is enabled, NULL otherwise); purging by version also removes single-call rows written under batching.';
COMMENT ON COLUMN semantic_classification_cache.input_checksum IS
  'Model-facing semantic prompt fingerprint (declared context plus bounded documents; retrieval-only evidence, attribution, and audience counters excluded).';
