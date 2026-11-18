-- A time-only RUNNING guard loses sub-millisecond precision through the JS
-- Date boundary and cannot distinguish a stale worker from a fresh claim.
-- Bind each slice to an opaque lease token instead.
ALTER TABLE community_acquisition_url_state
  ADD COLUMN IF NOT EXISTS lease_token UUID;

CREATE INDEX IF NOT EXISTS idx_community_url_state_lease
  ON community_acquisition_url_state (lease_token)
  WHERE state='RUNNING' AND lease_token IS NOT NULL;
