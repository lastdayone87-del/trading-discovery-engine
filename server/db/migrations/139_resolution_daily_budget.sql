-- Bounded daily budget for concept resolution admissions (claim-time
-- enforcement; processor remains unchanged). Fail-closed default 0: nothing
-- is admittable until an explicit bounded budget is set.
ALTER TABLE concept_graph_controls
  ADD COLUMN IF NOT EXISTS daily_resolution_documents INTEGER NOT NULL DEFAULT 0 CHECK(daily_resolution_documents>=0);
