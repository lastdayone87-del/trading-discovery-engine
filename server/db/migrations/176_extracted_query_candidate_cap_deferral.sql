-- Cap-deferred extracted candidates remain eligible for a later batch but
-- must move behind candidates that have never been offered. This is distinct
-- from an attempted/cooldown row: deferral lowers priority, it does not exclude.
ALTER TABLE extracted_query_candidates
  ADD COLUMN IF NOT EXISTS last_cap_deferred_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cap_deferral_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_extracted_query_candidates_deferral
  ON extracted_query_candidates(country, decision, standalone_eligible, query_id, last_cap_deferred_at);
