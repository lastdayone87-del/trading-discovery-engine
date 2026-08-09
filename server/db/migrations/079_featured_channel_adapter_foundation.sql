-- Phase 7.75: dormant adapter foundation for explicit multipleChannels sections.
-- No assignment, enqueue, worker, or authority path is installed.
ALTER TABLE acquisition_adapter_controls DROP CONSTRAINT IF EXISTS acquisition_adapter_controls_adapter_type_check;
ALTER TABLE acquisition_adapter_controls ADD CONSTRAINT acquisition_adapter_controls_adapter_type_check
  CHECK(adapter_type IN('INSPECT_PLAYLIST','INSPECT_CHANNEL_RELATIONS','INSPECT_WEBSITE','INSPECT_FEATURED_CHANNELS')) NOT VALID;
ALTER TABLE acquisition_adapter_controls VALIDATE CONSTRAINT acquisition_adapter_controls_adapter_type_check;
INSERT INTO acquisition_adapter_controls(adapter_type,mode,paused,kill_switch,daily_quota_cap,total_quota_cap,consumed_quota,max_depth,max_fanout,policy_version,updated_by)
VALUES('INSPECT_FEATURED_CHANNELS','SHADOW',true,true,0,0,0,1,10,'featured-channel-adapter-v1','system:migration-079') ON CONFLICT(adapter_type) DO NOTHING;
ALTER TABLE acquisition_adapter_controls ADD CONSTRAINT featured_channel_adapter_foundation_dormant CHECK(
  adapter_type<>'INSPECT_FEATURED_CHANNELS' OR (mode='SHADOW' AND paused AND kill_switch AND daily_quota_cap=0 AND total_quota_cap=0 AND consumed_quota=0 AND max_depth=1)
);

ALTER TABLE frontier_actions DROP CONSTRAINT IF EXISTS frontier_actions_action_type_check;
ALTER TABLE frontier_actions ADD CONSTRAINT frontier_actions_action_type_check CHECK
  (action_type IN('SEARCH_TERM','CONTINUE_RESULT_PAGE','INSPECT_PLAYLIST','INSPECT_FEATURED_CHANNELS')) NOT VALID;
ALTER TABLE frontier_actions VALIDATE CONSTRAINT frontier_actions_action_type_check;
ALTER TABLE frontier_actions DROP CONSTRAINT IF EXISTS frontier_actions_check;
ALTER TABLE frontier_actions DROP CONSTRAINT IF EXISTS frontier_actions_check1;
ALTER TABLE frontier_actions ADD CONSTRAINT frontier_actions_validity_window CHECK(validity_end>validity_start);
ALTER TABLE frontier_actions ADD CONSTRAINT frontier_actions_parent_semantics CHECK(
  (action_type='SEARCH_TERM' AND parent_action_id IS NULL) OR
  (action_type='CONTINUE_RESULT_PAGE' AND parent_action_id IS NOT NULL) OR
  action_type IN('INSPECT_PLAYLIST','INSPECT_FEATURED_CHANNELS')
);
ALTER TABLE frontier_actions ADD CONSTRAINT featured_channel_frontier_foundation_dormant CHECK(
  action_type<>'INSPECT_FEATURED_CHANNELS' OR (normalized_target~'^channel:UC[A-Za-z0-9_-]{22}$' AND mode='SHADOW' AND lifecycle='PROPOSED' AND payload_schema_version=1)
);

ALTER TABLE acquisition_adapter_runs DROP CONSTRAINT IF EXISTS acquisition_adapter_runs_adapter_type_check;
ALTER TABLE acquisition_adapter_runs ADD CONSTRAINT acquisition_adapter_runs_adapter_type_check
  CHECK(adapter_type IN('INSPECT_PLAYLIST','INSPECT_FEATURED_CHANNELS')) NOT VALID;
ALTER TABLE acquisition_adapter_runs VALIDATE CONSTRAINT acquisition_adapter_runs_adapter_type_check;
ALTER TABLE acquisition_adapter_runs ADD CONSTRAINT featured_channel_adapter_outcome_contract CHECK(
  adapter_type<>'INSPECT_FEATURED_CHANNELS' OR
  (jsonb_typeof(outcome->'sourceChannelId')='string' AND jsonb_typeof(outcome->'featuredChannelIds')='array' AND
   jsonb_typeof(outcome->'providerRequestIdentity')='string' AND jsonb_typeof(outcome->'observationTimestamp')='string' AND
   jsonb_typeof(outcome->'boundedMetadata')='object' AND outcome-ARRAY['sourceChannelId','featuredChannelIds','providerRequestIdentity','observationTimestamp','boundedMetadata']='{}'::jsonb)
);

COMMENT ON CONSTRAINT featured_channel_adapter_foundation_dormant ON acquisition_adapter_controls IS 'Phase 7.75 permanently prevents execution until a later authority migration explicitly replaces this constraint.';
