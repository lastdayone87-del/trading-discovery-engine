-- Lossless, governed review reason metadata. Existing immutable rows retain a
-- legacy marker; new rows store catalog identity separately from display text.
ALTER TABLE channel_review_decisions ADD COLUMN IF NOT EXISTS reason_code TEXT NOT NULL DEFAULT 'LEGACY_FREE_TEXT';
ALTER TABLE channel_review_decisions ADD COLUMN IF NOT EXISTS reason_catalog_version TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE channel_review_decisions ADD COLUMN IF NOT EXISTS reason_other_text TEXT;
COMMENT ON COLUMN channel_review_decisions.reason_code IS 'Stable action-specific governed reason code.';
COMMENT ON COLUMN channel_review_decisions.reason_catalog_version IS 'Reason catalog version used when the immutable decision was made.';
