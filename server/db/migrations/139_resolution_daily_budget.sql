-- Bounded daily budget for concept resolution admissions (claim-time
-- enforcement; processor remains unchanged). Fail-closed default 0: nothing
-- is admittable until an explicit bounded budget is set.
ALTER TABLE concept_graph_controls
  ADD COLUMN IF NOT EXISTS daily_resolution_documents INTEGER NOT NULL DEFAULT 0 CHECK(daily_resolution_documents>=0);
-- Supports the guard's daily consumption count (created_at range) without
-- scanning accumulated history while holding the control-row lock.
CREATE INDEX IF NOT EXISTS idx_concept_resolution_proposals_created_at
  ON concept_resolution_proposals(created_at);
