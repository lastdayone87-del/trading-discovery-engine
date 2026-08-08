-- Generalized false-negative and community-acquisition reliability projections.
-- Evidence/attempt history remains append-only; channels stays a compatibility projection.
ALTER TABLE channels ADD COLUMN IF NOT EXISTS discord_discovery_status TEXT NOT NULL DEFAULT 'NOT_DISCOVERED'
 CHECK(discord_discovery_status IN('NOT_DISCOVERED','DISCOVERED_VALIDATION_FAILED','VALIDATED'));
ALTER TABLE channels ADD COLUMN IF NOT EXISTS discord_candidate_locator TEXT;
CREATE INDEX IF NOT EXISTS idx_channels_discord_discovery_status ON channels(discord_discovery_status,scan_status);
COMMENT ON COLUMN channels.discord_candidate_locator IS 'Non-serving current locator projection retained when validation fails; immutable attempts remain authoritative.';
