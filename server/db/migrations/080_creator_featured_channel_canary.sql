-- Phase 8: one bounded non-query authority extension for INSPECT_FEATURED_CHANNELS.
ALTER TABLE creator_search_canary_control
  ADD COLUMN featured_channel_authority_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN featured_channel_rollout_basis_points INTEGER NOT NULL DEFAULT 0 CHECK(featured_channel_rollout_basis_points BETWEEN 0 AND 10000);
ALTER TABLE creator_search_canary_control DROP CONSTRAINT creator_canary_serving_authority_bounded;
ALTER TABLE creator_search_canary_control ADD CONSTRAINT creator_canary_serving_authority_bounded CHECK(
  NOT serving_authority_enabled OR (enabled AND NOT kill_switch AND (rollout_basis_points>0 OR playlist_rollout_basis_points>0 OR featured_channel_rollout_basis_points>0) AND global_daily_allocation_cap>0 AND global_daily_quota_cap>0)
);
ALTER TABLE creator_search_canary_control ADD CONSTRAINT creator_featured_channel_authority_bounded CHECK(
  NOT featured_channel_authority_enabled OR (enabled AND serving_authority_enabled AND NOT kill_switch AND featured_channel_rollout_basis_points>0 AND global_daily_allocation_cap>0 AND global_daily_quota_cap>0)
);

ALTER TABLE creator_search_canary_assignments DROP CONSTRAINT creator_canary_assignment_action_type_check;
ALTER TABLE creator_search_canary_assignments ADD CONSTRAINT creator_canary_assignment_action_type_check CHECK(action_type IN('SEARCH_YOUTUBE','INSPECT_PLAYLIST','INSPECT_FEATURED_CHANNELS')) NOT VALID;
ALTER TABLE creator_search_canary_assignments VALIDATE CONSTRAINT creator_canary_assignment_action_type_check;
ALTER TABLE creator_search_canary_assignments DROP CONSTRAINT creator_playlist_proposal_required;
ALTER TABLE creator_search_canary_assignments ADD CONSTRAINT creator_non_query_proposal_required CHECK(
  (action_type='SEARCH_YOUTUBE' AND non_query_proposal_id IS NULL) OR (action_type IN('INSPECT_PLAYLIST','INSPECT_FEATURED_CHANNELS') AND non_query_proposal_id IS NOT NULL)
);

ALTER TABLE acquisition_adapter_controls DROP CONSTRAINT featured_channel_adapter_foundation_dormant;
ALTER TABLE acquisition_adapter_controls ADD CONSTRAINT featured_channel_adapter_canary_bounded CHECK(
 adapter_type<>'INSPECT_FEATURED_CHANNELS' OR (max_depth=1 AND ((mode='SHADOW' AND paused AND kill_switch AND daily_quota_cap=0 AND total_quota_cap=0 AND consumed_quota=0) OR (mode='CANARY' AND daily_quota_cap BETWEEN 1 AND 10 AND total_quota_cap BETWEEN 1 AND 100 AND consumed_quota<=total_quota_cap)))
);
ALTER TABLE frontier_actions DROP CONSTRAINT featured_channel_frontier_foundation_dormant;
ALTER TABLE frontier_actions ADD CONSTRAINT featured_channel_frontier_identity CHECK(action_type<>'INSPECT_FEATURED_CHANNELS' OR normalized_target~'^channel:UC[A-Za-z0-9_-]{22}$');

CREATE TABLE creator_featured_channel_canary_execution_links (
 link_key TEXT PRIMARY KEY, assignment_id UUID NOT NULL UNIQUE REFERENCES creator_search_canary_assignments(id) ON DELETE RESTRICT,
 proposal_id UUID NOT NULL UNIQUE REFERENCES creator_non_query_shadow_proposals(id) ON DELETE RESTRICT,
 frontier_action_id UUID NOT NULL UNIQUE REFERENCES frontier_actions(id) ON DELETE RESTRICT, job_id UUID REFERENCES jobs(id) ON DELETE RESTRICT,
 disposition TEXT NOT NULL CHECK(disposition IN('CONTROL','QUEUED','ADAPTER_FALLBACK')), reason_codes JSONB NOT NULL CHECK(jsonb_typeof(reason_codes)='array'),
 readiness_run_id UUID NOT NULL REFERENCES creator_readiness_shadow_runs(id) ON DELETE RESTRICT, source_allocation_run_id UUID NOT NULL REFERENCES creator_program_allocation_shadow_runs(id) ON DELETE RESTRICT,
 lineage_checksum TEXT NOT NULL CHECK(lineage_checksum~'^[a-f0-9]{64}$'), assignment_policy_version TEXT NOT NULL, adapter_policy_version TEXT NOT NULL,
 linked_at TIMESTAMPTZ NOT NULL
);
CREATE TRIGGER creator_featured_channel_canary_execution_links_immutable BEFORE UPDATE OR DELETE ON creator_featured_channel_canary_execution_links FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation();

CREATE TABLE creator_featured_channel_lineage_reconciliation_control(singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton),enabled BOOLEAN NOT NULL DEFAULT false,policy_version TEXT NOT NULL DEFAULT 'creator-featured-channel-lineage-reconciliation-v1',updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_by TEXT NOT NULL DEFAULT 'system:migration-080');
INSERT INTO creator_featured_channel_lineage_reconciliation_control(singleton) VALUES(true);
CREATE TABLE creator_featured_channel_lineage_reconciliation_events(
 event_key TEXT PRIMARY KEY,assignment_id UUID REFERENCES creator_search_canary_assignments(id) ON DELETE RESTRICT,proposal_id UUID REFERENCES creator_non_query_shadow_proposals(id) ON DELETE RESTRICT,
 result TEXT NOT NULL CHECK(result IN('PASS','ABSTAIN')),reason_codes JSONB NOT NULL CHECK(jsonb_typeof(reason_codes)='array'),candidate_count INTEGER NOT NULL CHECK(candidate_count>=0),
 reconstructed_link_key TEXT REFERENCES creator_featured_channel_canary_execution_links(link_key) ON DELETE RESTRICT,evidence_checksum TEXT NOT NULL CHECK(evidence_checksum~'^[a-f0-9]{64}$'),
 detail JSONB NOT NULL CHECK(jsonb_typeof(detail)='object'),cutoff_at TIMESTAMPTZ NOT NULL,policy_version TEXT NOT NULL,serving_authority BOOLEAN NOT NULL DEFAULT false CHECK(serving_authority=false),created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK((result='PASS' AND reconstructed_link_key IS NOT NULL) OR (result='ABSTAIN' AND reconstructed_link_key IS NULL))
);
CREATE TRIGGER creator_featured_channel_lineage_reconciliation_events_immutable BEFORE UPDATE OR DELETE ON creator_featured_channel_lineage_reconciliation_events FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation();
