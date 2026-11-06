-- Migration 163: shadow failure classification on job attempts.
--
-- Phase 0 separates capacity waits, browser runtime failures, and genuine
-- acquisition failures before any of them can change scheduling. This slice
-- records the shadow classification on the attempt that failed so the
-- classification survives process restarts and can be reconciled with the
-- existing coarse capacity predicate in SQL.
--
-- The comparison columns are the point of the shadow:
--   * failure_class / failure_reason  — the new evidence-based split;
--   * failure_existing_capacity_lease — what the legacy predicate decided;
--   * failure_work_started_evidence   — UNKNOWN / PROVEN_UNSTARTED /
--     PROVEN_STARTED, so a BROWSER_RUNTIME row with missing evidence is
--     distinguishable from one proved to have done no work.
--
-- This is additive, metadata-only DDL:
--   * no backfill; historical attempts remain NULL because their execution
--     evidence is not available and must not be guessed from current policy;
--   * no NOT NULL constraint, so a rolling deploy with an older worker that
--     does not write these columns remains valid;
--   * no index yet; classification analysis filters a bounded recent attempt
--     window and a later slice can add a partial index if measured volume
--     requires one.
--
-- Closed value sets get NOT VALID CHECK constraints: they apply to every new
-- write without scanning existing rows, so historical NULLs and a rolling
-- deploy with an older worker remain valid.
--
-- The columns are written only while the job-clock v2 canary is enabled, so
-- flag-off behavior stays byte-for-byte legacy.

SET LOCAL lock_timeout = '10s';

ALTER TABLE public.job_attempts
  ADD COLUMN IF NOT EXISTS failure_class TEXT,
  ADD COLUMN IF NOT EXISTS failure_reason TEXT,
  ADD COLUMN IF NOT EXISTS failure_existing_capacity_lease BOOLEAN,
  ADD COLUMN IF NOT EXISTS failure_work_started_evidence TEXT;

ALTER TABLE public.job_attempts
  ADD CONSTRAINT job_attempts_failure_class_check
    CHECK (failure_class IN ('CAPACITY', 'BROWSER_RUNTIME', 'GENUINE_FAILURE'))
    NOT VALID;

ALTER TABLE public.job_attempts
  ADD CONSTRAINT job_attempts_failure_work_started_evidence_check
    CHECK (failure_work_started_evidence IN ('UNKNOWN', 'PROVEN_UNSTARTED', 'PROVEN_STARTED'))
    NOT VALID;
