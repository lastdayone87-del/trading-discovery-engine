-- Phase 7 generalizes the existing bounded assignment ledger for exactly one
-- non-query adapter. All other Phase 6 proposal types remain shadow-only.
ALTER TABLE creator_search_canary_control
  ADD COLUMN IF NOT EXISTS playlist_authority_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS playlist_rollout_basis_points INTEGER NOT NULL DEFAULT 0 CHECK(playlist_rollout_basis_points BETWEEN 0 AND 10000);
ALTER TABLE creator_search_canary_control DROP CONSTRAINT IF EXISTS creator_search_canary_control_check;
ALTER TABLE creator_search_canary_control ADD CONSTRAINT creator_canary_serving_authority_bounded CHECK(
  NOT serving_authority_enabled OR
  (enabled AND NOT kill_switch AND (rollout_basis_points>0 OR playlist_rollout_basis_points>0) AND global_daily_allocation_cap>0 AND global_daily_quota_cap>0)
);
ALTER TABLE creator_search_canary_control
  ADD CONSTRAINT creator_playlist_authority_bounded CHECK(
    NOT playlist_authority_enabled OR
    (enabled AND serving_authority_enabled AND NOT kill_switch AND playlist_rollout_basis_points>0 AND global_daily_allocation_cap>0 AND global_daily_quota_cap>0)
  );

ALTER TABLE creator_search_canary_assignments
  ADD COLUMN IF NOT EXISTS non_query_proposal_id UUID REFERENCES creator_non_query_shadow_proposals(id) ON DELETE RESTRICT;
ALTER TABLE creator_search_canary_assignments DROP CONSTRAINT IF EXISTS creator_search_canary_assignments_action_type_check;
ALTER TABLE creator_search_canary_assignments ADD CONSTRAINT creator_canary_assignment_action_type_check
  CHECK(action_type IN('SEARCH_YOUTUBE','INSPECT_PLAYLIST')) NOT VALID;
ALTER TABLE creator_search_canary_assignments VALIDATE CONSTRAINT creator_canary_assignment_action_type_check;
ALTER TABLE creator_search_canary_assignments ADD CONSTRAINT creator_playlist_proposal_required CHECK(
  (action_type='SEARCH_YOUTUBE' AND non_query_proposal_id IS NULL) OR
  (action_type='INSPECT_PLAYLIST' AND non_query_proposal_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS creator_playlist_canary_execution_links (
  link_key TEXT PRIMARY KEY,
  assignment_id UUID NOT NULL UNIQUE REFERENCES creator_search_canary_assignments(id) ON DELETE RESTRICT,
  proposal_id UUID NOT NULL UNIQUE REFERENCES creator_non_query_shadow_proposals(id) ON DELETE RESTRICT,
  frontier_action_id UUID NOT NULL UNIQUE REFERENCES frontier_actions(id) ON DELETE RESTRICT,
  job_id UUID REFERENCES jobs(id) ON DELETE RESTRICT,
  disposition TEXT NOT NULL CHECK(disposition IN('CONTROL','QUEUED','ADAPTER_FALLBACK')),
  reason_codes JSONB NOT NULL CHECK(jsonb_typeof(reason_codes)='array'),
  readiness_run_id UUID NOT NULL REFERENCES creator_readiness_shadow_runs(id) ON DELETE RESTRICT,
  lineage_checksum TEXT NOT NULL CHECK(lineage_checksum~'^[a-f0-9]{64}$'),
  policy_version TEXT NOT NULL,
  linked_at TIMESTAMPTZ NOT NULL
);
CREATE TRIGGER creator_playlist_canary_execution_links_immutable BEFORE UPDATE OR DELETE ON creator_playlist_canary_execution_links
FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation();

COMMENT ON TABLE creator_playlist_canary_execution_links IS 'Single-adapter Phase 7 canary lineage; only INSPECT_PLAYLIST may materialize through the pre-existing adapter.';
