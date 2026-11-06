-- Migration 166: durable community-acquisition URL work ledger.
--
-- Phase 0 adds the ledger schema and the read-only projection report only.
-- No worker reads or writes this table yet. Phase 1 materializes rows on retry
-- enqueue/reopen and switches scheduling to bounded URL slices.
--
-- Why a separate ledger:
--
--   * a channel retry job is a batch owner, not an opaque unbounded crawl;
--   * URL work must survive a job reopen, a worker crash, and a capacity wait;
--   * "never executed" must remain distinguishable from "attempted, fetched,
--     inspected, acquired, conclusively absent, externally blocked, or
--     inconclusive"; a started request is not proof of execution.
--
-- The table is mutable by design (work state advances), so it is intentionally
-- not append-only. Every attempt is already append-only in
-- external_acquisition_observations; this table stores the current projection.
--
-- Additive only: no backfill, no existing row rewrite, no behavior change.

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS public.community_acquisition_url_state (
  work_key TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  url TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  surface TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (state IN (
      'PENDING',
      'RUNNING',
      'RESOLVED',
      'PARKED_INFRA',
      'PARKED_EXTERNAL',
      'EXHAUSTED'
    )),
  never_executed BOOLEAN NOT NULL DEFAULT TRUE,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  -- Persisted copies of the two exit-gate facts. Without them the ledger can
  -- express neither retry ownership nor never-browser-executed work; attempts
  -- alone cannot distinguish a direct browser run from a static or borrowed
  -- outcome.
  retryable BOOLEAN NOT NULL DEFAULT FALSE,
  browser_executed BOOLEAN NOT NULL DEFAULT FALSE,
  first_observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_attempt_at TIMESTAMPTZ,
  next_eligible_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_failure_class TEXT,
  last_outcome TEXT,
  terminal_reason TEXT,
  terminal_evidence JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(terminal_evidence) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel_id, normalized_url, surface),
  -- Processed evidence is exactly what makes an attempt real. A genuine
  -- transport failure is an attempt without processed evidence, so the
  -- converse alone is asserted (attempts > 0 must not accompany a false
  -- never_executed flag).
  CONSTRAINT community_url_state_never_executed_attempts_check
    CHECK (never_executed OR attempts > 0),
  CONSTRAINT community_url_state_browser_executed_check
    CHECK (NOT browser_executed OR NOT never_executed)
);

-- Worker claim path: find due work for one channel or across channels.
-- RUNNING is included so stale-lease recovery can find crashed claims.
CREATE INDEX IF NOT EXISTS idx_community_url_state_due
  ON public.community_acquisition_url_state (state, next_eligible_at)
  WHERE state IN ('PENDING', 'RUNNING');

CREATE INDEX IF NOT EXISTS idx_community_url_state_channel
  ON public.community_acquisition_url_state (channel_id, state, next_eligible_at);

-- Never-executed accounting is a Phase 0 exit-gate metric.
CREATE INDEX IF NOT EXISTS idx_community_url_state_never_executed
  ON public.community_acquisition_url_state (channel_id)
  WHERE never_executed;

CREATE OR REPLACE FUNCTION public.touch_community_acquisition_url_state_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- clock_timestamp(), not now(): now() is fixed at transaction start, which
  -- would hide a second write in the same transaction from lease/freshness
  -- checks.
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS community_url_state_touch_updated_at
  ON public.community_acquisition_url_state;
CREATE TRIGGER community_url_state_touch_updated_at
  BEFORE UPDATE ON public.community_acquisition_url_state
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_community_acquisition_url_state_updated_at();

COMMENT ON TABLE public.community_acquisition_url_state IS
  'Phase 0 URL work ledger: per-channel/surface/URL state, never executed vs attempted vs resolved.';
COMMENT ON COLUMN public.community_acquisition_url_state.never_executed IS
  'TRUE until direct processed evidence exists; a started request alone never clears it.';
COMMENT ON COLUMN public.community_acquisition_url_state.attempts IS
  'Billable retry attempts: genuine transport/site failures and direct processed work; capacity/browser-runtime parks and borrowed evidence do not consume the budget.';
COMMENT ON COLUMN public.community_acquisition_url_state.retryable IS
  'TRUE when the effective observation for this work row owns a retry (required ACQUISITION_FAILED, retryable, not REDIRECT_LIMIT).';
COMMENT ON COLUMN public.community_acquisition_url_state.browser_executed IS
  'TRUE only when a direct rendered observation processed pages/requests/clicks; borrowed or static evidence never sets it.';
COMMENT ON COLUMN public.community_acquisition_url_state.state IS
  'PENDING/RUNNING are runnable; RESOLVED is terminal; PARKED_INFRA/PARKED_EXTERNAL are bounded parks; EXHAUSTED is attempt-capped.';
