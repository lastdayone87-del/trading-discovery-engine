-- Migration 176: Phase 2 retry backlog triage evidence and reversible quarantine.
--
-- Unit 4 classifies ancient RETRY_COMMUNITY_ACQUISITION jobs into terminal,
-- quarantine, and recoverable buckets. Terminal jobs keep their append-only
-- closure evidence on `jobs`. Quarantine is a reversible scheduling action:
-- the job stays PENDING, its payload/history is untouched, and its original
-- priority/run_after are recorded here before `run_after` is deferred.
--
-- Additive only: no existing table, row, or observation is altered.

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS public.retry_backlog_triage (
  -- RESTRICT: a pending job carrying quarantine evidence must be handled
  -- explicitly before it can be deleted; the evidence is never cascaded away.
  job_id UUID PRIMARY KEY REFERENCES public.jobs(id) ON DELETE RESTRICT,
  bucket TEXT NOT NULL CHECK (bucket IN ('TERMINAL','QUARANTINE','RECOVERABLE')),
  reason TEXT NOT NULL CHECK (btrim(reason) <> ''),
  evidence JSONB NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  -- Original queue state for a reversible quarantine.
  original_priority INTEGER,
  original_run_after TIMESTAMPTZ,
  deferred_until TIMESTAMPTZ,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_by TEXT NOT NULL CHECK (btrim(applied_by) <> ''),
  undone_at TIMESTAMPTZ,
  undone_by TEXT,
  CHECK (
    bucket <> 'QUARANTINE'
    OR (original_priority IS NOT NULL AND original_run_after IS NOT NULL AND deferred_until IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_retry_backlog_triage_bucket
  ON public.retry_backlog_triage (bucket, applied_at DESC);

CREATE INDEX IF NOT EXISTS idx_retry_backlog_triage_deferred
  ON public.retry_backlog_triage (deferred_until)
  WHERE undone_at IS NULL AND deferred_until IS NOT NULL;

-- Extend the closure taxonomy for Unit 4's explicit terminal buckets. The
-- evidence row carries the specific OUT_OF_SCOPE / LOW_AUDIENCE / EXHAUSTED
-- reason; this class keeps jobs.closed_reason truthful at the audit level.
ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_closure_reason_allowed_check;
ALTER TABLE public.jobs
  ADD CONSTRAINT jobs_closure_reason_allowed_check
  CHECK (
    closed_reason IS NULL
    OR closed_reason IN ('CHANNEL_TERMINAL','LEDGER_ALL_TERMINAL','RETRY_TRIAGE_TERMINAL')
  ) NOT VALID;

-- Append-only evidence: only the one-way undo marker may be added by an
-- operator; classification fields, original queue state, and the actor/time
-- of the original apply can never be rewritten. DELETE is rejected.
CREATE OR REPLACE FUNCTION public.guard_retry_backlog_triage_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'RETRY_BACKLOG_TRIAGE_APPEND_ONLY: triage evidence cannot be deleted (job %)', OLD.job_id;
  END IF;
  IF NEW.job_id IS DISTINCT FROM OLD.job_id
     OR NEW.bucket IS DISTINCT FROM OLD.bucket
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.evidence IS DISTINCT FROM OLD.evidence
     OR NEW.original_priority IS DISTINCT FROM OLD.original_priority
     OR NEW.original_run_after IS DISTINCT FROM OLD.original_run_after
     OR NEW.deferred_until IS DISTINCT FROM OLD.deferred_until
     OR NEW.applied_at IS DISTINCT FROM OLD.applied_at
     OR NEW.applied_by IS DISTINCT FROM OLD.applied_by
  THEN
    RAISE EXCEPTION
      'RETRY_BACKLOG_TRIAGE_APPEND_ONLY: classification evidence cannot be rewritten (job %)', OLD.job_id;
  END IF;
  IF OLD.undone_at IS NOT NULL AND NEW.undone_at IS DISTINCT FROM OLD.undone_at THEN
    RAISE EXCEPTION
      'RETRY_BACKLOG_TRIAGE_APPEND_ONLY: undo marker is one-way (job %)', OLD.job_id;
  END IF;
  IF OLD.undone_by IS NOT NULL AND NEW.undone_by IS DISTINCT FROM OLD.undone_by THEN
    RAISE EXCEPTION
      'RETRY_BACKLOG_TRIAGE_APPEND_ONLY: undo actor is one-way (job %)', OLD.job_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS retry_backlog_triage_append_only ON public.retry_backlog_triage;
CREATE TRIGGER retry_backlog_triage_append_only
  BEFORE UPDATE OR DELETE ON public.retry_backlog_triage
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_retry_backlog_triage_mutation();

COMMENT ON TABLE public.retry_backlog_triage IS
  'Phase 2 Unit 4 retry-backlog classification evidence. Terminal rows mirror jobs.closed_evidence; quarantine rows preserve original queue state for reversal.';
COMMENT ON COLUMN public.retry_backlog_triage.bucket IS
  'TERMINAL = evidence-backed closure; QUARANTINE = PENDING job deferred with run_after; RECOVERABLE is report-only.';
COMMENT ON COLUMN public.retry_backlog_triage.evidence IS
  'Bounded classification evidence: channel/scan/claim/age counters, never URLs or page text.';
COMMENT ON COLUMN public.retry_backlog_triage.deferred_until IS
  'run_after value applied to a quarantined job; original_run_after is preserved for reversal.';
