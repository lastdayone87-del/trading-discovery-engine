-- Release 3 / Phase 5: gap-specific, bounded investigation planning.
CREATE TABLE IF NOT EXISTS gap_specific_investigation_plans (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), plan_key TEXT NOT NULL UNIQUE,
 channel_id TEXT NOT NULL, investigation_id UUID REFERENCES investigations(id) ON DELETE RESTRICT,
 classification_diagnostic_id UUID REFERENCES production_classification_diagnostics(id) ON DELETE RESTRICT,
 creator_focus_snapshot_id UUID REFERENCES creator_focus_classification_snapshots(id) ON DELETE RESTRICT,
 mode TEXT NOT NULL CHECK(mode IN('SHADOW','CANARY')), gaps JSONB NOT NULL,
 action_assessments JSONB NOT NULL, selected_action TEXT NOT NULL, applied_action TEXT,
 provider_quota_remaining INTEGER NOT NULL CHECK(provider_quota_remaining>=0), case_quota_remaining INTEGER NOT NULL CHECK(case_quota_remaining>=0),
 deadline_at TIMESTAMPTZ NOT NULL, policy_version TEXT NOT NULL, utility_contract_version TEXT NOT NULL,
 assignment_basis_points INTEGER NOT NULL CHECK(assignment_basis_points BETWEEN 0 AND 10000), randomization_value INTEGER NOT NULL CHECK(randomization_value BETWEEN 0 AND 9999),
 controller_assigned BOOLEAN NOT NULL, reason_codes JSONB NOT NULL, plan_checksum TEXT NOT NULL,
 planned_at TIMESTAMPTZ NOT NULL DEFAULT now(), CHECK(jsonb_typeof(gaps)='array'),
 CHECK(jsonb_typeof(action_assessments)='object'), CHECK(jsonb_typeof(reason_codes)='array')
);
CREATE INDEX IF NOT EXISTS idx_gap_plans_channel ON gap_specific_investigation_plans(channel_id,planned_at DESC);
CREATE TABLE IF NOT EXISTS investigation_cost_events (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), event_key TEXT NOT NULL UNIQUE,
 investigation_id UUID NOT NULL REFERENCES investigations(id) ON DELETE RESTRICT,
 step_id UUID REFERENCES investigation_steps(id) ON DELETE RESTRICT, action_type TEXT NOT NULL,
 event_type TEXT NOT NULL CHECK(event_type IN('RESERVED','CONSUMED','RELEASED','REVIEW_RESERVED','REVIEW_CONSUMED')),
 provider_cost INTEGER NOT NULL CHECK(provider_cost>=0), review_cost INTEGER NOT NULL CHECK(review_cost>=0),
 policy_version TEXT NOT NULL, occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_investigation_cost_events_case ON investigation_cost_events(investigation_id,occurred_at,id);
DO $$ DECLARE t TEXT; BEGIN FOREACH t IN ARRAY ARRAY['gap_specific_investigation_plans','investigation_cost_events'] LOOP
 EXECUTE format('CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation()',t,t);
END LOOP; END $$;

INSERT INTO evidence_action_definitions(action_key,version,enrichment_stage,provider_cost,review_cost,latency_ms,resolves,governed,definition_checksum) VALUES
 ('HYDRATE_CHANNEL_ABOUT',2,1,1,0,1500,'["CHANNEL_METADATA_MISSING"]',true,'gap-action-hydrate-about-v2'),
 ('FETCH_RECENT_VIDEO_SAMPLE',2,1,101,0,3000,'["RECENT_DOCUMENT_COVERAGE_INSUFFICIENT","INDEPENDENCE_MISSING"]',true,'gap-action-recent-videos-v2'),
 ('FETCH_TEMPORAL_VIDEO_SAMPLE',2,2,202,0,6000,'["TEMPORAL_COVERAGE_INSUFFICIENT","ALTERNATIVE_FOCUS_AMBIGUOUS"]',true,'gap-action-temporal-videos-v2'),
 ('FETCH_VIDEO_DESCRIPTIONS',2,2,1,0,2500,'["TRADING_HYPOTHESIS_AMBIGUOUS","ALTERNATIVE_FOCUS_AMBIGUOUS"]',true,'gap-action-video-descriptions-v2'),
 ('FETCH_PLAYLIST_SAMPLE',2,2,100,0,4000,'["RECENT_DOCUMENT_COVERAGE_INSUFFICIENT"]',true,'gap-action-playlists-v2'),
 ('FETCH_TRANSCRIPT_EXCERPT',2,NULL,1,0,4000,'["TRADING_HYPOTHESIS_AMBIGUOUS","LANGUAGE_LOW_CONFIDENCE"]',true,'gap-action-transcript-v2'),
 ('RESOLVE_LANGUAGE',2,NULL,0,0,2000,'["LANGUAGE_UNSUPPORTED","LANGUAGE_LOW_CONFIDENCE"]',true,'gap-action-language-v2'),
 ('RESOLVE_ENTITY',2,NULL,0,0,2000,'["IDENTITY_UNRESOLVED"]',true,'gap-action-entity-v2'),
 ('CLASSIFY_DOCUMENTS',2,NULL,0,0,1000,'["TRADING_HYPOTHESIS_AMBIGUOUS"]',true,'gap-action-classify-documents-v2'),
 ('ASSESS_CREATOR_FOCUS',2,NULL,0,0,1000,'["ALTERNATIVE_FOCUS_AMBIGUOUS","TRADING_HYPOTHESIS_AMBIGUOUS"]',true,'gap-action-assess-focus-v2'),
 ('RETRY_PROVIDER',2,NULL,0,0,3000,'["PROVIDER_TRANSIENT_FAILURE"]',true,'gap-action-retry-provider-v2'),
 ('WAIT_FOR_QUOTA',2,NULL,0,0,0,'["QUOTA_DEFERRED"]',true,'gap-action-wait-quota-v2'),
 ('PREPARE_HUMAN_REVIEW',2,NULL,0,1,0,'["REVIEW_JUDGMENT_REQUIRED"]',true,'gap-action-review-v2')
ON CONFLICT(action_key) DO NOTHING;
INSERT INTO app_settings(setting_key,setting_value) VALUES
 ('gap_specific_scheduler_mode','OFF'),('gap_specific_scheduler_canary_basis_points','0'),
 ('gap_specific_case_quota_cap','303'),('gap_specific_deadline_minutes','30')
ON CONFLICT(setting_key) DO NOTHING;
COMMENT ON TABLE gap_specific_investigation_plans IS 'Immutable counterfactual/action plan; unsupported adapters fail closed and are never materialized.';
