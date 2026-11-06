-- Migration 164: enforce the Phase 0 clock separation at the storage layer.
--
-- The application now keeps three ages separate:
--
--   * first_enqueued_at          — the immutable queue age;
--   * first_transient_failure_at — the genuine retryable-failure age;
--   * capacity_lease_*           — capacity waiting, which may renew.
--
-- A capacity lease renewal must never reset either age. The runtime already
-- writes only lease bookkeeping, but a future update statement could forget;
-- this trigger makes the separation an invariant of the jobs table.
--
-- The guard is deliberately compatible with the flag-off path:
--   * legacy created_at resets do not touch capacity-lease fields, so they
--     continue to work;
--   * legacy reopen paths never rewrite first_enqueued_at;
--   * first_transient_failure_at may still be set once and intentionally
--     cleared for a new retry epoch, as the existing recovery paths do.
--
-- This migration is additive, flag-agnostic, and rewrites no rows. Historical
-- observations and the legacy scheduling path remain unchanged.

SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.guard_job_clock_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- The queue clock may be filled once (including the bounded backfill of
  -- historical rows) but can never move, clear, or re-age afterwards.
  IF OLD.first_enqueued_at IS NOT NULL
     AND NEW.first_enqueued_at IS DISTINCT FROM OLD.first_enqueued_at THEN
    RAISE EXCEPTION
      'JOB_CLOCK_IMMUTABLE: first_enqueued_at cannot change once set (job %)', OLD.id;
  END IF;

  -- A genuine failure anchor may be cleared intentionally for a new retry
  -- epoch, but it can never be moved to a different non-null timestamp. That
  -- would silently restart the six-hour retryable-failure budget.
  IF OLD.first_transient_failure_at IS NOT NULL
     AND NEW.first_transient_failure_at IS NOT NULL
     AND NEW.first_transient_failure_at IS DISTINCT FROM OLD.first_transient_failure_at THEN
    RAISE EXCEPTION
      'JOB_CLOCK_IMMUTABLE: first_transient_failure_at cannot move once set (job %)', OLD.id;
  END IF;

  -- Any statement that renews or starts a capacity lease must leave both the
  -- legacy queue clock and the genuine failure anchor byte-for-byte unchanged.
  IF (NEW.capacity_lease_started_at IS DISTINCT FROM OLD.capacity_lease_started_at
      OR NEW.capacity_lease_expires_at IS DISTINCT FROM OLD.capacity_lease_expires_at
      OR NEW.capacity_lease_renewed_at IS DISTINCT FROM OLD.capacity_lease_renewed_at
      OR NEW.capacity_lease_renewals IS DISTINCT FROM OLD.capacity_lease_renewals)
     AND (NEW.created_at IS DISTINCT FROM OLD.created_at
          OR NEW.first_transient_failure_at IS DISTINCT FROM OLD.first_transient_failure_at) THEN
    RAISE EXCEPTION
      'JOB_CLOCK_IMMUTABLE: capacity lease renewal cannot rewrite queue or failure age (job %)', OLD.id;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.guard_job_clock_immutability() IS
  'Phase 0: queue age and genuine failure age survive capacity-lease renewal.';

DROP TRIGGER IF EXISTS jobs_clock_immutability_guard ON public.jobs;
CREATE TRIGGER jobs_clock_immutability_guard
  BEFORE UPDATE ON public.jobs
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_job_clock_immutability();
