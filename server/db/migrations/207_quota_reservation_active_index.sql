-- Migration 207: index the active quota-reservation slice.
--
-- quota_reservations retains millions of historical rows. Reservation totals
-- and expiry sweeps used to scan/update the whole table while holding the
-- singleton quota_tracker row lock, serializing every YouTube worker behind a
-- ~1s scan. The partial index covers only RESERVED rows, which are bounded by
-- the 20-minute lease TTL.
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
   WHERE c.oid = to_regclass('public.idx_quota_reservations_reserved_expiry');

  IF index_oid IS NOT NULL AND (NOT index_valid OR NOT index_ready) THEN
    RAISE EXCEPTION 'idx_quota_reservations_reserved_expiry exists but is not valid/ready; rebuild it CONCURRENTLY out-of-band before applying migration 207';
  END IF;

  IF index_oid IS NOT NULL AND (
    pg_get_indexdef(index_oid) NOT LIKE '%USING btree (expires_at)%'
    OR pg_get_indexdef(index_oid) NOT LIKE '%INCLUDE (units, operation_type, operation_id)%'
    OR pg_get_indexdef(index_oid) NOT LIKE '%status = ''RESERVED''%'
    OR NOT EXISTS (
      SELECT 1 FROM pg_index i
       WHERE i.indexrelid = index_oid
         AND i.indrelid = to_regclass('public.quota_reservations')
         AND i.indnatts = 4
         AND i.indnkeyatts = 1
         AND i.indpred IS NOT NULL
         AND i.indexprs IS NULL
    )
  ) THEN
    RAISE EXCEPTION 'idx_quota_reservations_reserved_expiry exists with the wrong table/keys/predicate; rebuild it CONCURRENTLY before applying migration 207';
  END IF;

  IF index_oid IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.quota_reservations LIMIT 1) THEN
      RAISE EXCEPTION 'quota_reservations is populated and idx_quota_reservations_reserved_expiry is absent; create it CONCURRENTLY out-of-band before applying migration 207';
    END IF;
    CREATE INDEX IF NOT EXISTS idx_quota_reservations_reserved_expiry
      ON public.quota_reservations (expires_at)
      INCLUDE (units, operation_type, operation_id)
      WHERE status='RESERVED';
  END IF;
END $$;
