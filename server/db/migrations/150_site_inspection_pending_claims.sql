-- Migration 150: per-channel pending candidate claims for site_inspections.
--
-- Migration 149 introduced the PENDING claim handshake with a single
-- `source_channel_id` per site row. That representation cannot keep two
-- creators' unclaimed discoveries recoverable when they inspect the same
-- site: a later writer either overwrites the earlier candidates or must
-- discard its own evidence. This additive column stores the unclaimed
-- candidate list per recording channel as a JSON object:
--
--   {"<channel_id>": [<candidate>, ...], ...}
--
-- A row is PENDING while this map is non-empty. Finalization removes only the
-- executing channel's candidate ids, so an admitted/discarded execution never
-- erases another channel's pending work. No backfill: legacy PENDING rows keep
-- using their existing `source_channel_id` + `candidates` pair until their next
-- write; readers support both shapes.

ALTER TABLE site_inspections ADD COLUMN IF NOT EXISTS pending_claims JSONB NOT NULL DEFAULT '{}'::jsonb;
DO $$ BEGIN
  ALTER TABLE site_inspections ADD CONSTRAINT site_inspections_pending_claims_object_check
    CHECK (jsonb_typeof(pending_claims) = 'object') NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN site_inspections.pending_claims IS
  'Per-channel unclaimed candidates keyed by recording channel id; non-empty means PENDING and never reusable.';
