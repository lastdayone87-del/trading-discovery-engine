-- Acquisition reliability: Phase 1 URL work ledger runtime + retry claim indexes.
--
-- Additive only. The URL work ledger table already exists from migration 166;
-- this migration adds the queue-side bookkeeping needed to make capacity waits
-- observable and to keep the retry-only claim path from sorting the full
-- pending queue on every worker poll.

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS capacity_deferrals INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS capacity_wait_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_progress_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS parked_reason TEXT,
  ADD COLUMN IF NOT EXISTS parked_at TIMESTAMPTZ;

-- The dedicated community-retry consumer orders by updated_at so a saturated
-- cohort yields its turn to never-claimed/new work. Match that order exactly.
CREATE INDEX IF NOT EXISTS idx_jobs_retry_fair_claim
  ON jobs (priority DESC, updated_at ASC, id ASC)
  WHERE status='PENDING' AND type='RETRY_COMMUNITY_ACQUISITION';

-- Channel job lookups are frequent in reconciliation/reporting. Restrict the
-- index to active retry rows so it stays small and selective.
CREATE INDEX IF NOT EXISTS idx_jobs_retry_channel_active
  ON jobs ((payload->>'channelId'))
  WHERE type='RETRY_COMMUNITY_ACQUISITION'
    AND status IN ('PENDING','PROCESSING');

-- Bounded URL claim path: per-channel due order.
CREATE INDEX IF NOT EXISTS idx_community_url_state_claim
  ON community_acquisition_url_state (channel_id, next_eligible_at, first_observed_at)
  WHERE state='PENDING';

COMMENT ON COLUMN jobs.capacity_deferrals IS
  'Number of attempt-free capacity/browser-gate deferrals for observability and bounded parking.';
COMMENT ON COLUMN jobs.capacity_wait_started_at IS
  'First capacity wait for this job epoch; used to bound indefinite deferral without charging a genuine failure.';
COMMENT ON COLUMN jobs.last_progress_at IS
  'Last real acquisition progress (slice started/resolved), never a capacity wait.';
COMMENT ON COLUMN jobs.parked_reason IS
  'Visible reason when a job is parked on capacity or an approved individual deferral.';
