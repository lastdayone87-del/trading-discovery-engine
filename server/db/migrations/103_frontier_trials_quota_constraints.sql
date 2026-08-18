-- Add CHECK constraints for frontier_canary_trials quota bounds
ALTER TABLE frontier_canary_trials
  DROP CONSTRAINT IF EXISTS chk_frontier_trials_quota_reserved,
  DROP CONSTRAINT IF EXISTS chk_frontier_trials_quota_consumed,
  DROP CONSTRAINT IF EXISTS chk_frontier_trials_quota_consumed_lte_reserved;

ALTER TABLE frontier_canary_trials
  ADD CONSTRAINT chk_frontier_trials_quota_reserved CHECK (quota_reserved BETWEEN 1 AND 100),
  ADD CONSTRAINT chk_frontier_trials_quota_consumed CHECK (quota_consumed >= 0),
  ADD CONSTRAINT chk_frontier_trials_quota_consumed_lte_reserved CHECK (quota_consumed <= quota_reserved);
