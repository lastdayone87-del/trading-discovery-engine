SET LOCAL lock_timeout = '10s';

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




COMMENT ON COLUMN jobs.capacity_deferrals IS
  'Number of attempt-free capacity/browser-gate deferrals for observability and bounded parking.';
COMMENT ON COLUMN jobs.capacity_wait_started_at IS
  'First capacity wait for this job epoch; used to bound indefinite deferral without charging a genuine failure.';
COMMENT ON COLUMN jobs.last_progress_at IS
  'Last real acquisition progress (slice started/resolved), never a capacity wait.';
COMMENT ON COLUMN jobs.parked_reason IS
  'Visible reason when a job is parked on capacity or an approved individual deferral.';
