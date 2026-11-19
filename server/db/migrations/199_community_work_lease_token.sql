SET LOCAL lock_timeout = '10s';

-- A time-only RUNNING guard loses sub-millisecond precision through the JS
-- Date boundary and cannot distinguish a stale worker from a fresh claim.
-- Bind each slice to an opaque lease token instead.
ALTER TABLE community_acquisition_url_state
  ADD COLUMN IF NOT EXISTS lease_token UUID;
