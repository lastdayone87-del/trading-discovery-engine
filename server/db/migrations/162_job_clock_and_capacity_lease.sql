-- Migration 162: immutable queue clocks, capacity leases, and reopen identity.
--
-- Phase 0 needs three separate concepts that the legacy jobs row conflated:
--
--   * when the work first entered the queue (first_enqueued_at);
--   * when the work most recently entered/re-entered the queue (last_enqueued_at);
--   * how much capacity waiting the work has accumulated (capacity_lease_*).
--
-- The existing first_transient_failure_at column remains the anchor for the
-- genuine retryable-failure budget. A capacity lease renewal must never write
-- that anchor. This migration is additive only: existing runtime behavior and
-- every historical observation remain unchanged.
--
-- Only fast, metadata-only DDL runs here. The historical backfill is a
-- bounded, batched runner step that executes after this transaction commits
-- (see backfillPhase0JobClocks in dbCore.ts), so the ACCESS EXCLUSIVE lock
-- taken by ALTER TABLE is never held across a table scan or row updates.
-- Defaults apply to new inserts immediately; existing rows stay NULL until
-- the idempotent backfill fills them. NOT NULL is intentionally deferred
-- until after the backfill has soaked, so a rolling deploy with old workers
-- cannot fail updates on rows that are still being backfilled.

SET LOCAL lock_timeout = '10s';

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS first_enqueued_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_enqueued_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS capacity_lease_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS capacity_lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS capacity_lease_renewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS capacity_lease_renewals INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reopen_generation INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_reopened_at TIMESTAMPTZ;

-- Adding a DEFAULT here is metadata-only. Existing rows are deliberately left
-- NULL: a DEFAULT on ADD COLUMN would have made every historical job look
-- freshly enqueued and destroy the backfill.
ALTER TABLE public.jobs
  ALTER COLUMN first_enqueued_at SET DEFAULT now(),
  ALTER COLUMN last_enqueued_at SET DEFAULT now();

-- The queue-age and capacity-lease indexes are built concurrently by the
-- migration runner after this transaction commits. They are intentionally not
-- declared here: a transactional CREATE INDEX would hold a write-blocking lock
-- on the populated jobs table.
