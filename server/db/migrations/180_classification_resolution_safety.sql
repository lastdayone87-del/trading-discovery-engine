-- Classification resolution safety.
--
-- 1. Reviewers can request another evidence pass from a PENDING review without
--    being forced to approve or reject first.
-- 2. Terminal job failures carry a structured class so the bounded recovery
--    sweep can distinguish retryable failures from permanent policy/input
--    failures without parsing provider-specific free text.
--
-- The terminal_failure_class constraint is intentionally not added here: a
-- validated CHECK would scan the hot jobs table inside the migration
-- transaction. The application writes only the closed value set documented in
-- server/db.ts.

ALTER TYPE review_decision ADD VALUE IF NOT EXISTS 'REQUEST_RESCAN';

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS terminal_failure_class TEXT;

COMMENT ON COLUMN jobs.terminal_failure_class IS
  'Closed recovery classification: RETRYABLE, PROVIDER_QUOTA, PERMANENT_INPUT, POLICY_TERMINAL, UNKNOWN.';
