-- Migration 185: indexes for the mature saturation sweep.
--
-- query_runs and channel_sightings are hot discovery tables. An ordinary index
-- build inside the migration transaction would block writes for the full build
-- on a populated database. The runner builds these indexes CONCURRENTLY before
-- this transactional file runs; this migration adopts a valid index or verifies
-- an empty table, and fails closed otherwise.
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
   WHERE c.oid = to_regclass('public.idx_query_runs_saturation_mature');

  IF index_oid IS NOT NULL AND (NOT index_valid OR NOT index_ready) THEN
    RAISE EXCEPTION 'idx_query_runs_saturation_mature exists but is not valid/ready; rebuild it CONCURRENTLY out-of-band before applying migration 185';
  END IF;

  IF index_oid IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.query_runs LIMIT 1) THEN
      RAISE EXCEPTION 'query_runs is populated and idx_query_runs_saturation_mature is absent; create it CONCURRENTLY out-of-band before applying migration 185';
    END IF;
    CREATE INDEX IF NOT EXISTS idx_query_runs_saturation_mature
      ON public.query_runs(status, completed_at, query_id)
      WHERE query_id IS NOT NULL;
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
   WHERE c.oid = to_regclass('public.idx_channel_sightings_query_run_funnel');

  IF index_oid IS NOT NULL AND (NOT index_valid OR NOT index_ready) THEN
    RAISE EXCEPTION 'idx_channel_sightings_query_run_funnel exists but is not valid/ready; rebuild it CONCURRENTLY out-of-band before applying migration 185';
  END IF;

  IF index_oid IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.channel_sightings LIMIT 1) THEN
      RAISE EXCEPTION 'channel_sightings is populated and idx_channel_sightings_query_run_funnel is absent; create it CONCURRENTLY out-of-band before applying migration 185';
    END IF;
    CREATE INDEX IF NOT EXISTS idx_channel_sightings_query_run_funnel
      ON public.channel_sightings(query_run_id, funnel_outcome);
  END IF;
END $$;
