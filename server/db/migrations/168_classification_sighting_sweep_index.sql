-- Migration 168: index the pending-classification sighting sweep.
--
-- The maintenance sweep runs every 60 seconds and looks for sightings whose
-- funnel outcome is CLASSIFICATION_PENDING and whose observation is inside a
-- 14-day window. Without a partial index, every run scans channel_sightings
-- (and continues to do so after a rollback, because the sweep must stay active
-- to repair old rows). The partial index keeps the scan proportional to the
-- unfinished set, not to the full sighting history.
--
-- Locking safety mirrors migrations 157 and 160:
-- * Where the index already exists and is valid/ready, this DO block is a
--   catalog no-op.
-- * On a fresh database, channel_sightings is empty when migrations run, so
--   the one-time build is short.
-- * On a populated database where the index is unexpectedly absent, this
--   migration fails closed instead of holding a write-blocking lock. The
--   runner's pre-migration helper builds the index with
--   CREATE INDEX CONCURRENTLY before this transactional file runs.
-- * The runner wraps each migration file in BEGIN/COMMIT, so the SQL itself
--   must not request a concurrent build.
SET LOCAL lock_timeout = '10s';

DO $$
DECLARE
  index_oid oid;
  index_valid boolean;
  index_ready boolean;
BEGIN
  IF to_regclass('public.channel_sightings') IS NULL THEN
    RETURN;
  END IF;

  SELECT c.oid, i.indisvalid, i.indisready
    INTO index_oid, index_valid, index_ready
    FROM pg_class c
    JOIN pg_index i ON i.indexrelid = c.oid
   WHERE c.oid = to_regclass('public.idx_channel_sightings_classification_pending');

  IF index_oid IS NOT NULL AND (NOT index_valid OR NOT index_ready) THEN
    RAISE EXCEPTION 'idx_channel_sightings_classification_pending exists but is not valid/ready; rebuild it CONCURRENTLY out-of-band before applying migration 168';
  END IF;

  IF index_oid IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.channel_sightings LIMIT 1) THEN
      RAISE EXCEPTION 'channel_sightings is populated and idx_channel_sightings_classification_pending is absent; create it CONCURRENTLY out-of-band before applying migration 168';
    END IF;
    CREATE INDEX IF NOT EXISTS idx_channel_sightings_classification_pending
      ON public.channel_sightings (observed_at)
      WHERE funnel_outcome='CLASSIFICATION_PENDING';
  END IF;
END $$;
