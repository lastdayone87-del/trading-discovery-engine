-- Durable, observational ground-truth reconciliation keyed by the immutable
-- human review decision. No serving path reads these records.
ALTER TABLE phase_b_observation_outbox
  DROP CONSTRAINT IF EXISTS phase_b_observation_outbox_observation_type_check;
ALTER TABLE phase_b_observation_outbox
  ADD CONSTRAINT phase_b_observation_outbox_observation_type_check
  CHECK(observation_type IN('RETRIEVAL_ASSIGNMENT','PRODUCTION_DIAGNOSTIC','GROUND_TRUTH_LABEL'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_evaluation_ground_truth_review_once
  ON evaluation_ground_truth_labels(review_decision_id)
  WHERE review_decision_id IS NOT NULL;

COMMENT ON INDEX idx_evaluation_ground_truth_review_once IS
  'Exactly one immutable evaluation ground-truth label per immutable human review decision.';
