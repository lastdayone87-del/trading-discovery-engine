-- Migration 167: append-only job closure evidence.
--
-- Phase 0's zombie reconciliation may close a pending retry only when evidence
-- proves the channel/work is already resolved or externally terminal. A closed
-- job must carry its evidence and actor durably, and that record must never be
-- rewritten in place: a later reopen is a new retry epoch, not a reason to
-- erase why the previous epoch ended.
--
-- The four columns are additive and nullable. The completeness constraint is
-- added NOT VALID so a rolling deploy never takes a long validation lock on the
-- populated jobs table; new inserts/updates are still checked immediately.
--
-- Append-only means exactly that: `closed_reason`, `closed_evidence`,
-- `closed_by`, and `closed_at` may be set once (all together) and can never
-- change or disappear afterwards. Status transitions, payload updates, queue
-- clocks, and capacity leases are untouched by this guard; a DELETE of a
-- closed job is rejected so the closure record cannot be erased either.

SET LOCAL lock_timeout = '10s';

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS closed_reason TEXT,
  ADD COLUMN IF NOT EXISTS closed_evidence JSONB,
  ADD COLUMN IF NOT EXISTS closed_by TEXT,
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'jobs_closure_evidence_complete_check'
       AND conrelid = 'public.jobs'::regclass
  ) THEN
    ALTER TABLE public.jobs
      ADD CONSTRAINT jobs_closure_evidence_complete_check
      CHECK (
        (
          closed_at IS NULL
          AND closed_reason IS NULL
          AND closed_evidence IS NULL
          AND closed_by IS NULL
        )
        OR (
          closed_at IS NOT NULL
          AND closed_reason IS NOT NULL
          AND btrim(closed_reason) <> ''
          AND closed_evidence IS NOT NULL
          AND jsonb_typeof(closed_evidence) = 'object'
          AND closed_by IS NOT NULL
          AND btrim(closed_by) <> ''
        )
      ) NOT VALID;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'jobs_closure_reason_allowed_check'
       AND conrelid = 'public.jobs'::regclass
  ) THEN
    ALTER TABLE public.jobs
      ADD CONSTRAINT jobs_closure_reason_allowed_check
      CHECK (
        closed_reason IS NULL
        OR closed_reason IN ('CHANNEL_TERMINAL','LEDGER_ALL_TERMINAL')
      ) NOT VALID;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.guard_job_closure_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.closed_at IS NOT NULL THEN
      RAISE EXCEPTION
        'JOB_CLOSURE_IMMUTABLE: closure evidence cannot be deleted (job %)', OLD.id;
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.closed_at IS NOT NULL
     AND (
       NEW.closed_at IS DISTINCT FROM OLD.closed_at
       OR NEW.closed_reason IS DISTINCT FROM OLD.closed_reason
       OR NEW.closed_evidence IS DISTINCT FROM OLD.closed_evidence
       OR NEW.closed_by IS DISTINCT FROM OLD.closed_by
     ) THEN
    RAISE EXCEPTION
      'JOB_CLOSURE_IMMUTABLE: closure evidence cannot be rewritten (job %)', OLD.id;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.guard_job_closure_evidence() IS
  'Phase 0: closure reason, evidence, actor, and time are append-only, including DELETE.';

DROP TRIGGER IF EXISTS jobs_closure_evidence_guard ON public.jobs;
CREATE TRIGGER jobs_closure_evidence_guard
  BEFORE UPDATE OR DELETE ON public.jobs
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_job_closure_evidence();

COMMENT ON COLUMN public.jobs.closed_reason IS
  'Append-only closure reason, e.g. CHANNEL_TERMINAL or LEDGER_ALL_TERMINAL.';
COMMENT ON COLUMN public.jobs.closed_evidence IS
  'Append-only JSON evidence captured at closure; never derived after the fact.';
COMMENT ON COLUMN public.jobs.closed_by IS
  'Append-only operator/service identity that authorized the closure.';
COMMENT ON COLUMN public.jobs.closed_at IS
  'Append-only closure timestamp. A later reopen is a new generation and does not rewrite this record.';
