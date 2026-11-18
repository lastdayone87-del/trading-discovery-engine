-- Preserve multi-invite recall: the ledger must retain relevant optional
-- community URLs, not only required retry-owning URLs. Required work gets
-- priority 100; recall work gets priority 10 and is processed when required
-- work is not due, so finding one invite never abandons other relevant URLs.
ALTER TABLE community_acquisition_url_state
  ADD COLUMN IF NOT EXISTS required BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS recall BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 100;


COMMENT ON COLUMN community_acquisition_url_state.required IS
  'TRUE for required community work; FALSE for optional multi-invite recall.';
COMMENT ON COLUMN community_acquisition_url_state.recall IS
  'TRUE when the row exists to continue relevant URL coverage after an invite was already found.';
COMMENT ON COLUMN community_acquisition_url_state.priority IS
  'Required work 100; optional recall 10. Claim order is priority DESC.';
