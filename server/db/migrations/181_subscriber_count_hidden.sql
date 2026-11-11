-- Owner-hidden subscriber counts are a known state, not a failed fetch.
-- A single sticky marker prevents repeated public/official attempts while
-- leaving subscriber_count NULL (hidden counts are never usable as evidence).
ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS subscriber_count_hidden BOOLEAN NOT NULL DEFAULT FALSE;
