ALTER TABLE channels ADD COLUMN IF NOT EXISTS country_metadata_status TEXT NOT NULL DEFAULT 'NOT_REQUESTED';
ALTER TABLE channels ADD COLUMN IF NOT EXISTS country_metadata_checked_at TIMESTAMPTZ;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS latest_upload_at TIMESTAMPTZ;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS uploads_last_30_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS uploads_last_90_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS uploads_last_365_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS activity_band TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE channels ADD COLUMN IF NOT EXISTS activity_score INTEGER NOT NULL DEFAULT 50;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS activity_observed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_channels_first_seen_desc ON channels(first_seen DESC, channel_id);
CREATE INDEX IF NOT EXISTS idx_channels_active_listing ON channels(first_seen DESC, channel_id)
  WHERE country_status <> 'REJECTED' AND scan_status <> 'SKIPPED_EXCLUDED' AND trading_status <> 'NON_TRADING';
CREATE INDEX IF NOT EXISTS idx_channels_activity_priority ON channels(activity_score DESC, latest_upload_at DESC NULLS LAST);
