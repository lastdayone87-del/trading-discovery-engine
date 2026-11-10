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
  job_id UUID PRIMARY KEY REFERENCES public.jobs(id) ON DELETE CASCADE,
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

COMMENT ON TABLE public.retry_backlog_triage IS
  'Phase 2 Unit 4 retry-backlog classification evidence. Terminal rows mirror jobs.closed_evidence; quarantine rows preserve original queue state for reversal.';
COMMENT ON COLUMN public.retry_backlog_triage.bucket IS
  'TERMINAL = evidence-backed closure; QUARANTINE = PENDING job deferred with run_after; RECOVERABLE is report-only.';
COMMENT ON COLUMN public.retry_backlog_triage.evidence IS
  'Bounded classification evidence: channel/scan/claim/age counters, never URLs or page text.';
COMMENT ON COLUMN public.retry_backlog_triage.deferred_until IS
  'run_after value applied to a quarantined job; original_run_after is preserved for reversal.';
