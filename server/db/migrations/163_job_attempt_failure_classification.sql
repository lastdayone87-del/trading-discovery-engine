-- Migration 163: shadow failure classification on job attempts.
--
-- Phase 0 separates capacity waits, browser runtime failures, and genuine
-- acquisition failures before any of them can change scheduling. This slice
-- records the shadow classification on the attempt that failed so the
-- classification survives process restarts and can be reconciled with the
-- existing coarse capacity predicate in SQL.
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
-- The columns are written only while the job-clock v2 canary is enabled, so
-- flag-off behavior stays byte-for-byte legacy.

SET LOCAL lock_timeout = '10s';

ALTER TABLE public.job_attempts
  ADD COLUMN IF NOT EXISTS failure_class TEXT,
  ADD COLUMN IF NOT EXISTS failure_reason TEXT;
