-- Migration 157: index the channel id carried in job payloads.
--
-- Production already has this index, but it was created outside the migration
-- lineage during the #548 investigation. Re-declaring it here makes a fresh
-- database converge on the same schema and records the index in
-- schema_migrations on databases where it already exists.
--
-- Locking safety:
-- * Where the index already exists (including production), CREATE INDEX IF NOT
--   EXISTS is a catalog no-op. PostgreSQL adopts the existing valid index and
--   does not rebuild it or hold a long lock on jobs.
-- * On a fresh database, jobs is empty when migrations run, so the one-time
--   build is short.
-- * The runner wraps each migration file in BEGIN/COMMIT, so an
--   out-of-transaction concurrent build is not available here. If this
--   migration ever encounters a populated database where the index is
--   unexpectedly absent, the build takes a write-blocking lock. SET LOCAL
--   lock_timeout bounds the wait to acquire that lock; after 10s the
--   transaction fails and rolls back instead of queueing behind other DDL.
--   In that exceptional case, build the index out-of-band before deploying.
SET LOCAL lock_timeout = '10s';

CREATE INDEX IF NOT EXISTS idx_jobs_channel_payload
  ON public.jobs USING btree (((payload ->> 'channelId'::text)));

COMMENT ON INDEX public.idx_jobs_channel_payload IS
  'Supports channel-scoped job lookups that read payload->>channelId.';
