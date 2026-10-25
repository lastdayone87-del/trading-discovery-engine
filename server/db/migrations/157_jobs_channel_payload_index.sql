-- Migration 157: index the channel id carried in job payloads.
--
-- Production already has this index, but it was created outside the migration
-- lineage during the #548 investigation. Re-declaring it here makes a fresh
-- database converge on the same schema and records the index in
-- schema_migrations on databases where it already exists.
--
-- Locking safety:
-- * Where the index already exists (including production), the DO block is a
--   catalog no-op. PostgreSQL adopts the existing valid index and does not
--   rebuild it or hold a long lock on jobs.
-- * On a fresh database, jobs is empty when migrations run, so the one-time
--   build is short.
-- * On a populated database where the index is unexpectedly absent, this
--   migration fails closed instead of holding a write-blocking lock for the
--   full build. The runner's pre-migration helper builds that index with
--   CREATE INDEX CONCURRENTLY before this transactional file runs.
-- * The runner wraps each migration file in BEGIN/COMMIT, so the SQL itself
--   must not request a concurrent build.
SET LOCAL lock_timeout = '10s';

DO $$
BEGIN
  IF to_regclass('public.idx_jobs_channel_payload') IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.jobs LIMIT 1) THEN
      RAISE EXCEPTION 'jobs is populated and idx_jobs_channel_payload is absent; create it CONCURRENTLY out-of-band before applying migration 157';
    END IF;
    CREATE INDEX IF NOT EXISTS idx_jobs_channel_payload
      ON public.jobs USING btree (((payload ->> 'channelId'::text)));
  END IF;
END $$;
