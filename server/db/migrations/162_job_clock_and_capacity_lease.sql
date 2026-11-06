-- Migration 162: immutable queue clocks, capacity leases, and reopen identity.
--
-- Phase 0 needs three separate concepts that the legacy jobs row conflated:
--
--   * when the work first entered the queue (first_enqueued_at);
--   * when the work most recently entered/re-entered the queue (last_enqueued_at);
--   * how much capacity waiting the work has accumulated (capacity_lease_*).
--
-- The existing first_transient_failure_at column remains the anchor for the
-- genuine retryable-failure budget. A capacity lease renewal must never write
-- that anchor. This migration is additive only: existing runtime behavior and
-- every historical observation remain unchanged.

SET LOCAL lock_timeout = '10s';

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS first_enqueued_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_enqueued_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS capacity_lease_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS capacity_lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS capacity_lease_renewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS capacity_lease_renewals INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reopen_generation INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_reopened_at TIMESTAMPTZ;

-- Backfill the immutable first queue clock from the best durable evidence.
-- Retry jobs carry the original observation time in payload.retryObservedAt;
-- created_at may already have been rewritten by the legacy five-hour capacity
-- lease. For those rows the earlier of the two timestamps is the truthful
-- queue age. A malformed historical payload must not abort deployment, so each
-- candidate is parsed with a local exception guard and falls back to created_at.
DO $$
DECLARE
  job record;
  observed_at TIMESTAMPTZ;
BEGIN
  FOR job IN
    SELECT id, created_at, payload
      FROM public.jobs
     WHERE first_enqueued_at IS NULL OR last_enqueued_at IS NULL
  LOOP
    observed_at := NULL;
    BEGIN
      IF job.payload IS NOT NULL AND job.payload ? 'retryObservedAt' THEN
        observed_at := (job.payload ->> 'retryObservedAt')::timestamptz;
      END IF;
    EXCEPTION WHEN others THEN
      observed_at := NULL;
    END;

    UPDATE public.jobs
       SET first_enqueued_at = COALESCE(
             first_enqueued_at,
             LEAST(job.created_at, COALESCE(observed_at, job.created_at))
           ),
           last_enqueued_at = COALESCE(last_enqueued_at, job.created_at)
     WHERE id = job.id;
  END LOOP;
END $$;

-- New inserts inherit the same clocks without a runtime write. NOT NULL is
-- applied only after the historical backfill above has completed.
ALTER TABLE public.jobs
  ALTER COLUMN first_enqueued_at SET DEFAULT now(),
  ALTER COLUMN last_enqueued_at SET DEFAULT now(),
  ALTER COLUMN first_enqueued_at SET NOT NULL,
  ALTER COLUMN last_enqueued_at SET NOT NULL;

-- The queue-age and capacity-lease indexes are built concurrently by the
-- migration runner after this transaction commits. They are intentionally not
-- declared here: a transactional CREATE INDEX would hold a write-blocking lock
-- on the populated jobs table.
