-- Scope YouTube invalid-input quarantine to the exact provider request shape.
--
-- The old identity was (input_kind, input_value). A provider-parameter defect
-- (for example an unsupported relevanceLanguage) therefore blocked the same
-- query on every surface for seven days even when another provider could serve
-- it. The new identity includes provider, operation, and a hash of the request
-- parameters. Legacy rows keep an empty signature and no longer match new
-- requests; they expire naturally.
ALTER TABLE youtube_invalid_input_quarantine
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'youtube',
  ADD COLUMN IF NOT EXISTS request_signature text NOT NULL DEFAULT '';

ALTER TABLE youtube_invalid_input_quarantine
  DROP CONSTRAINT IF EXISTS youtube_invalid_input_quarantine_pkey;

ALTER TABLE youtube_invalid_input_quarantine
  ADD CONSTRAINT youtube_invalid_input_quarantine_pkey
  PRIMARY KEY (provider, input_kind, input_value, operation, request_signature);

CREATE INDEX IF NOT EXISTS idx_youtube_invalid_input_expiry
  ON youtube_invalid_input_quarantine(expires_at);
