-- Migration 160: index the cap monitor's rolling attempt window.
--
-- The monitor counts cap-unavailable and provider-quota failures from
-- job_attempts every 60 seconds. Without an index on finished_at, each sample
-- scans the full attempt history (twice when a sample crosses quota midnight),
-- and the leading-wildcard error predicates cannot use an error index. A
-- partial index on finished_at keeps the one-hour range small and skips rows
-- that have no error to classify.
CREATE INDEX IF NOT EXISTS idx_job_attempts_finished_error
  ON job_attempts (finished_at)
  WHERE error IS NOT NULL;

COMMENT ON INDEX idx_job_attempts_finished_error IS
  'Supports the YouTube cap monitor rolling secondary-signal window.';
