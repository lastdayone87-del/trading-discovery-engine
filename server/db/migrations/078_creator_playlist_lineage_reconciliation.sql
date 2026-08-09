-- Phase 7 prerequisite: append-only repair of missing playlist canary lineage.
-- Disabled by default and incapable of scheduling or executing acquisition work.
CREATE TABLE IF NOT EXISTS creator_playlist_lineage_reconciliation_control (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton),
  enabled BOOLEAN NOT NULL DEFAULT false,
  policy_version TEXT NOT NULL DEFAULT 'creator-playlist-lineage-reconciliation-v1',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT NOT NULL DEFAULT 'system:migration'
);
INSERT INTO creator_playlist_lineage_reconciliation_control(singleton) VALUES(true) ON CONFLICT(singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS creator_playlist_lineage_reconciliation_events (
  event_key TEXT PRIMARY KEY,
  assignment_id UUID REFERENCES creator_search_canary_assignments(id) ON DELETE RESTRICT,
  proposal_id UUID REFERENCES creator_non_query_shadow_proposals(id) ON DELETE RESTRICT,
  result TEXT NOT NULL CHECK(result IN('PASS','ABSTAIN')),
  reason_codes JSONB NOT NULL CHECK(jsonb_typeof(reason_codes)='array'),
  candidate_count INTEGER NOT NULL CHECK(candidate_count>=0),
  reconstructed_link_key TEXT REFERENCES creator_playlist_canary_execution_links(link_key) ON DELETE RESTRICT,
  evidence_checksum TEXT NOT NULL CHECK(evidence_checksum~'^[a-f0-9]{64}$'),
  detail JSONB NOT NULL CHECK(jsonb_typeof(detail)='object'),
  cutoff_at TIMESTAMPTZ NOT NULL,
  policy_version TEXT NOT NULL,
  serving_authority BOOLEAN NOT NULL DEFAULT false CHECK(serving_authority=false),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK((result='PASS' AND reconstructed_link_key IS NOT NULL) OR (result='ABSTAIN' AND reconstructed_link_key IS NULL))
);
CREATE TRIGGER creator_playlist_lineage_reconciliation_events_immutable BEFORE UPDATE OR DELETE ON creator_playlist_lineage_reconciliation_events
FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation();

COMMENT ON TABLE creator_playlist_lineage_reconciliation_events IS 'Immutable, replayable Phase 7 lineage reconciliation evidence; never grants serving authority or initiates provider work.';
