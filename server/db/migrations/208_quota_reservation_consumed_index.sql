-- Migration 208: index the seven-day consumed-quota aggregate.
--
-- Autonomous admission sums CONSUMED reservation units from the last seven
-- days before taking the tracker lock. quota_reservations retains millions of
-- historical rows, so that aggregate used a full parallel sequential scan on
-- every reservation. The partial index covers only CONSUMED rows and supports
-- a reserved_at range scan with allocation/units included.
--
-- The migration runner builds this index CONCURRENTLY before the transactional
-- migration loop. This file only adopts a valid index or verifies an empty
-- table; it never holds a write-blocking build on a populated table.
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
   WHERE c.oid = to_regclass('public.idx_quota_reservations_consumed_recent');

  IF index_oid IS NOT NULL AND (NOT index_valid OR NOT index_ready) THEN
    RAISE EXCEPTION 'idx_quota_reservations_consumed_recent exists but is not valid/ready; rebuild it CONCURRENTLY out-of-band before applying migration 208';
  END IF;

  IF index_oid IS NOT NULL AND (
    pg_get_indexdef(index_oid) NOT LIKE '%USING btree (reserved_at)%'
    OR pg_get_indexdef(index_oid) NOT LIKE '%INCLUDE (allocation, units)%'
    OR NOT EXISTS (
      SELECT 1 FROM pg_index i
       WHERE i.indexrelid = index_oid
         AND i.indrelid = to_regclass('public.quota_reservations')
         AND i.indnatts = 3
         AND i.indnkeyatts = 1
         AND i.indpred IS NOT NULL
         AND i.indexprs IS NULL
         AND NOT i.indisunique
         AND btrim(regexp_replace(pg_get_expr(i.indpred, i.indrelid), '[()]', '', 'g')) = 'status = ''CONSUMED''::text'
    )
  ) THEN
    RAISE EXCEPTION 'idx_quota_reservations_consumed_recent exists with the wrong table/keys/predicate; rebuild it CONCURRENTLY before applying migration 208';
  END IF;

  IF index_oid IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.quota_reservations LIMIT 1) THEN
      RAISE EXCEPTION 'quota_reservations is populated and idx_quota_reservations_consumed_recent is absent; create it CONCURRENTLY out-of-band before applying migration 208';
    END IF;
    CREATE INDEX IF NOT EXISTS idx_quota_reservations_consumed_recent
      ON public.quota_reservations (reserved_at)
      INCLUDE (allocation, units)
      WHERE status='CONSUMED';
  END IF;
END $$;
