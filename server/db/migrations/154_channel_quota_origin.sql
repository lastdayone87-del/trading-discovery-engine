-- Migration 154: durable probe-origin fence marker for official YouTube quota.
--
-- Additive only. PROBE is sticky: once a channel is persisted by a probe,
-- every downstream official YouTube Data API call (hydration, ENRICH_CHANNEL,
-- retries, recovery) is charged to the independent probe allocation. NORMAL is
-- the legacy path. Neither marker bypasses quota enforcement.
--
-- There is no reliable backfill for channels ingested by earlier probe runs:
-- the probe ledger stores candidate keys and channel summaries but not the
-- final channel IDs. Such rows remain NORMAL and must be identified by a
-- separate audited migration if that becomes necessary.

ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS quota_origin TEXT NOT NULL DEFAULT 'NORMAL';

ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_quota_origin_check;
ALTER TABLE channels ADD CONSTRAINT channels_quota_origin_check
  CHECK (quota_origin IN ('NORMAL', 'PROBE'));

CREATE INDEX IF NOT EXISTS channels_quota_origin_probe_idx
  ON channels(channel_id)
  WHERE quota_origin = 'PROBE';

COMMENT ON COLUMN channels.quota_origin IS
  'Official YouTube Data API quota provenance. PROBE is sticky and spends only from the independent probe allocation; NORMAL uses the ordinary budget.';
