-- Migration 165: reopen generation guard and generation-scoped attempt history.
--
-- A terminal job can legitimately be reopened when fresh evidence arrives, but
-- an automatic recovery loop can reopen the same channel forever. Each reopen
-- resets jobs.attempts to zero, while job_attempts.attempt_number also restarts
-- at one, so the old and new attempt histories become indistinguishable.
--
-- This migration adds three additive pieces:
--
--   * job_attempts.generation scopes every claim to the job's reopen
--     generation;
--   * jobs.reopened_from_status records the status the job left;
--   * job_reopen_events is an append-only ledger of allowed and blocked
--     reopen attempts.
--
-- The guard is shadow-first. job_reopen_guard_config starts disabled: the
-- trigger still records reopen identity and ledger events, but it never blocks
-- a reopen. Enabling the config row enforces a bounded number of automatic
-- reopens per channel and job type in a rolling 30-day window. Operators can
-- bypass one session with:
--
--   SET LOCAL acquisition.reopen_guard_override = 'on';
--
-- The trigger only enforces for acquisition retry job types; other queues keep
-- their existing reopen behavior. No historical row is rewritten and no
-- existing observation is changed.

SET LOCAL lock_timeout = '10s';

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS reopened_from_status TEXT;

ALTER TABLE public.job_attempts
  ADD COLUMN IF NOT EXISTS generation INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.job_reopen_guard_config (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled BOOLEAN NOT NULL DEFAULT false,
  max_reopens_per_30d INTEGER NOT NULL DEFAULT 6 CHECK (max_reopens_per_30d > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.job_reopen_guard_config(singleton, enabled, max_reopens_per_30d)
VALUES (true, false, 6)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.job_reopen_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  channel_id TEXT,
  job_type TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('REOPENED', 'BLOCKED')),
  prior_status TEXT NOT NULL,
  prior_generation INTEGER NOT NULL,
  next_generation INTEGER,
  reason TEXT NOT NULL,
  reopened_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The cap query is always channel + job type + rolling window. The ledger is
-- small (one row per terminal-to-pending transition), so these indexes can be
-- built transactionally when the table is created.
CREATE INDEX IF NOT EXISTS idx_job_reopen_events_channel_window
  ON public.job_reopen_events (channel_id, job_type, reopened_at DESC)
  WHERE outcome = 'REOPENED';

CREATE INDEX IF NOT EXISTS idx_job_reopen_events_job_time
  ON public.job_reopen_events (job_id, reopened_at DESC);

-- A capped job can be offered for reopen repeatedly. Record each blocked
-- generation once instead of appending an unbounded audit stream.
CREATE UNIQUE INDEX IF NOT EXISTS idx_job_reopen_events_blocked_once
  ON public.job_reopen_events (job_id, prior_generation)
  WHERE outcome = 'BLOCKED';

CREATE OR REPLACE FUNCTION public.guard_job_reopen_generation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  guard_enabled BOOLEAN := false;
  max_reopens INTEGER := 6;
  channel_key TEXT;
  guarded_type BOOLEAN;
  override_enabled BOOLEAN;
  recent_reopens INTEGER := 0;
BEGIN
  -- Only a terminal-to-pending transition is a reopen. Capacity leases,
  -- stale-lock recovery, and ordinary retries stay exactly as they were.
  IF NEW.status IS DISTINCT FROM 'PENDING'
     OR OLD.status NOT IN ('COMPLETED', 'FAILED') THEN
    RETURN NEW;
  END IF;

  NEW.reopened_from_status := OLD.status;
  channel_key := NULLIF(btrim(COALESCE(NEW.payload->>'channelId', OLD.payload->>'channelId', '')), '');
  guarded_type := OLD.type IN ('RETRY_COMMUNITY_ACQUISITION', 'ENRICH_CHANNEL');

  SELECT c.enabled, c.max_reopens_per_30d
    INTO guard_enabled, max_reopens
    FROM public.job_reopen_guard_config c
   WHERE c.singleton;

  guard_enabled := COALESCE(guard_enabled, false);
  max_reopens := COALESCE(max_reopens, 6);
  override_enabled := lower(COALESCE(current_setting('acquisition.reopen_guard_override', true), 'off'))
    IN ('on', 'true', '1', 'yes');

  IF guard_enabled AND guarded_type AND channel_key IS NOT NULL AND NOT override_enabled THEN
    -- Different terminal jobs for one channel can reach this trigger
    -- concurrently. Serialize the count-and-insert decision for the channel
    -- and job type; a transaction-scoped advisory lock releases on commit.
    PERFORM pg_advisory_xact_lock(hashtextextended(channel_key || ':' || OLD.type, 0));

    SELECT count(*)::int
      INTO recent_reopens
      FROM public.job_reopen_events e
     WHERE e.outcome = 'REOPENED'
       AND e.channel_id = channel_key
       AND e.job_type = OLD.type
       AND e.reopened_at > now() - interval '30 days';

    IF recent_reopens >= max_reopens THEN
      INSERT INTO public.job_reopen_events(
        job_id, channel_id, job_type, outcome, prior_status,
        prior_generation, next_generation, reason
      ) VALUES (
        OLD.id, channel_key, OLD.type, 'BLOCKED', OLD.status,
        OLD.reopen_generation, OLD.reopen_generation + 1,
        'REOPEN_GENERATION_CAP'
      )
      ON CONFLICT DO NOTHING;
      RETURN NULL;
    END IF;
  END IF;

  -- Keep reopen identity truthful even on the legacy flag-off path. The
  -- application may already have incremented the generation; never
  -- double-count it.
  IF NEW.reopen_generation IS NULL OR NEW.reopen_generation <= OLD.reopen_generation THEN
    NEW.reopen_generation := COALESCE(OLD.reopen_generation, 0) + 1;
  END IF;
  IF NEW.last_reopened_at IS NOT DISTINCT FROM OLD.last_reopened_at THEN
    NEW.last_reopened_at := now();
  END IF;

  INSERT INTO public.job_reopen_events(
    job_id, channel_id, job_type, outcome, prior_status,
    prior_generation, next_generation, reason
  ) VALUES (
    OLD.id, channel_key, OLD.type, 'REOPENED', OLD.status,
    OLD.reopen_generation, NEW.reopen_generation, 'STATUS_TRANSITION'
  );

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.guard_job_reopen_generation() IS
  'Phase 0: record reopen identity and enforce the default-off per-channel reopen cap.';

DROP TRIGGER IF EXISTS jobs_reopen_generation_guard ON public.jobs;
CREATE TRIGGER jobs_reopen_generation_guard
  BEFORE UPDATE ON public.jobs
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_job_reopen_generation();
