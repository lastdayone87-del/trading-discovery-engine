-- Classification resolution safety.
--
-- 1. Reviewers can request another evidence pass from a PENDING review without
--    being forced to approve or reject first.
-- 2. Terminal job failures carry a structured class so the bounded recovery
--    sweep can distinguish retryable failures from permanent policy/input
--    failures without parsing provider-specific free text.

ALTER TYPE review_decision ADD VALUE IF NOT EXISTS 'REQUEST_RESCAN';

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS terminal_failure_class TEXT;

ALTER TABLE jobs
  DROP CONSTRAINT IF EXISTS jobs_terminal_failure_class_check;
ALTER TABLE jobs
  ADD CONSTRAINT jobs_terminal_failure_class_check
  CHECK (
    terminal_failure_class IS NULL
    OR terminal_failure_class IN (
      'RETRYABLE',
      'PROVIDER_QUOTA',
      'PERMANENT_INPUT',
      'POLICY_TERMINAL',
      'UNKNOWN'
    )
  );

CREATE INDEX IF NOT EXISTS idx_jobs_terminal_failure_class
  ON jobs(terminal_failure_class, updated_at DESC)
  WHERE terminal_failure_class IS NOT NULL;
