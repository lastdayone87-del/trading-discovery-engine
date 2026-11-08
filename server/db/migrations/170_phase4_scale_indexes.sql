-- Migration 170: Phase 4 scale-gate and cache-retention indexes.
--
-- The enrichment throughput query filters ENRICH_CHANNEL rows by created_at
-- and completed_at. Without these partial indexes it scans the full job
-- history and can exceed ENRICHMENT_SCALE_METRICS_TIMEOUT_MS on every start,
-- forcing the gate to fail closed. The cache purge query filters on
-- COALESCE(last_hit_at, created_at), so its index must use the same
-- expression; the plain created_at index from migration 169 cannot serve it.
CREATE INDEX IF NOT EXISTS idx_jobs_enrich_created_at
  ON jobs(created_at)
  WHERE type='ENRICH_CHANNEL';

CREATE INDEX IF NOT EXISTS idx_jobs_enrich_completed_at
  ON jobs(completed_at)
  WHERE type='ENRICH_CHANNEL' AND completed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_semantic_cache_retention
  ON semantic_classification_cache((COALESCE(last_hit_at, created_at)));

-- Migration 169 created this index before the retention query was finalized.
-- Fresh databases no longer create it; already-migrated databases converge
-- here. IF EXISTS keeps the migration safe on both.
DROP INDEX IF EXISTS idx_semantic_cache_created_at;

-- The original comment described NULL as "single call". With batching enabled
-- every call, including a batch of one, records the version; correct the
-- comment for databases that applied migration 169 before this wording was
-- finalized.
COMMENT ON COLUMN semantic_classification_cache.batch_prompt_version IS
  'Batch prompt version in effect when the result was cached (set for every call while batching is enabled, NULL otherwise); purging by version also removes single-call rows written under batching.';
COMMENT ON COLUMN semantic_classification_cache.input_checksum IS
  'Attribution-free classification input fingerprint (job_id/run_id and audience counters excluded).';
