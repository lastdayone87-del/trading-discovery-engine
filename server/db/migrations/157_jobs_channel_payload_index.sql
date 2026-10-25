-- Migration 157: index the channel id carried in job payloads.
--
-- Production already has this index, but it was created outside the migration
-- lineage during the #548 investigation. Re-declaring it here makes a fresh
-- database converge on the same schema and records the index in
-- schema_migrations on databases where it already exists.
--
-- IF NOT EXISTS keeps this additive and idempotent: the existing valid index
-- is adopted without a rebuild or a long lock on jobs.
SET LOCAL lock_timeout = '10s';

CREATE INDEX IF NOT EXISTS idx_jobs_channel_payload
  ON public.jobs USING btree (((payload ->> 'channelId'::text)));

COMMENT ON INDEX public.idx_jobs_channel_payload IS
  'Supports channel-scoped job lookups that read payload->>channelId.';
