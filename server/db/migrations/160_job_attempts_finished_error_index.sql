-- Migration 160: index the cap monitor's rolling attempt window.
--
-- The monitor counts cap-unavailable and provider-quota failures from
-- job_attempts every 60 seconds. Without an index on finished_at, each sample
-- scans the full attempt history (twice when a sample crosses quota midnight),
-- and the leading-wildcard error predicates cannot use an error index. A
-- partial index on finished_at keeps the one-hour range small and skips rows
-- that have no error to classify.
--
-- Locking safety:
-- * Where the index already exists and is valid/ready (including a concurrent
--   build by the runner), the DO block is a catalog no-op. PostgreSQL adopts
--   the existing index and does not rebuild it or hold a long lock on
--   job_attempts.
-- * On a fresh database, job_attempts is empty when migrations run, so the
--   one-time build is short.
-- * On a populated database where the index is unexpectedly absent, this
--   migration fails closed instead of holding a write-blocking lock for the
--   full build. The runner's pre-migration helper builds that index with
--   CREATE INDEX CONCURRENTLY before this transactional file runs.
-- * If a failed concurrent build left an invalid/not-ready index, the runner
--   drops and rebuilds it concurrently; this migration fails closed if the
--   invalid index somehow remains, so it is never recorded as applied with an
--   unusable index.
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
   WHERE c.oid = to_regclass('public.idx_job_attempts_finished_error');

  IF index_oid IS NOT NULL AND (NOT index_valid OR NOT index_ready) THEN
    RAISE EXCEPTION 'idx_job_attempts_finished_error exists but is not valid/ready; rebuild it CONCURRENTLY out-of-band before applying migration 160';
  END IF;

  IF index_oid IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.job_attempts LIMIT 1) THEN
      RAISE EXCEPTION 'job_attempts is populated and idx_job_attempts_finished_error is absent; create it CONCURRENTLY out-of-band before applying migration 160';
    END IF;
    CREATE INDEX IF NOT EXISTS idx_job_attempts_finished_error
      ON public.job_attempts (finished_at)
      WHERE error IS NOT NULL;
  END IF;
END $$;
