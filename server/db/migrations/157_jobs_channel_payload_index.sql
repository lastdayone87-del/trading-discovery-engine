-- Migration 157: index the channel id carried in job payloads.
--
-- Production already has this index, but it was created outside the migration
-- lineage during the #548 investigation. Re-declaring it here makes a fresh
-- database converge on the same schema and records the index in
-- schema_migrations on databases where it already exists.
--
-- Locking safety:
-- * Where the index already exists and is valid/ready (including production),
--   the DO block is a catalog no-op. PostgreSQL adopts the existing index and
--   does not rebuild it or hold a long lock on jobs.
-- * On a fresh database, jobs is empty when migrations run, so the one-time
--   build is short.
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
   WHERE c.oid = to_regclass('public.idx_jobs_channel_payload');

  IF index_oid IS NOT NULL AND (NOT index_valid OR NOT index_ready) THEN
    RAISE EXCEPTION 'idx_jobs_channel_payload exists but is not valid/ready; rebuild it CONCURRENTLY out-of-band before applying migration 157';
  END IF;

  IF index_oid IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.jobs LIMIT 1) THEN
      RAISE EXCEPTION 'jobs is populated and idx_jobs_channel_payload is absent; create it CONCURRENTLY out-of-band before applying migration 157';
    END IF;
    CREATE INDEX IF NOT EXISTS idx_jobs_channel_payload
      ON public.jobs USING btree (((payload ->> 'channelId'::text)));
  END IF;
END $$;
