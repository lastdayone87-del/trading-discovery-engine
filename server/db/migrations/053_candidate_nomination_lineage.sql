-- Release 1: immutable discovery nominations and replayable candidate projection.
CREATE TABLE IF NOT EXISTS discovery_nominations (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), nomination_key TEXT NOT NULL UNIQUE,
 channel_id TEXT NOT NULL, channel_entity_id UUID REFERENCES canonical_entities(id) ON DELETE RESTRICT,
 source_type TEXT NOT NULL, source_action_id UUID, query_id INTEGER REFERENCES query_library(id) ON DELETE SET NULL,
 query_run_id UUID REFERENCES query_runs(id) ON DELETE SET NULL, job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
 query_catalog_version TEXT, normalized_query TEXT, query_semantic_classes JSONB NOT NULL DEFAULT '[]'::jsonb,
 query_generation_mode TEXT, country TEXT NOT NULL, declared_language TEXT,
 retrieval_lane TEXT, search_ordering TEXT, page_number INTEGER CHECK(page_number IS NULL OR page_number>0),
 result_rank INTEGER CHECK(result_rank IS NULL OR result_rank>0), matched_document_locator JSONB NOT NULL,
 matched_document_checksum TEXT NOT NULL, raw_observation JSONB NOT NULL, observed_at TIMESTAMPTZ NOT NULL,
 policy_version TEXT NOT NULL, feature_version TEXT NOT NULL,
 CHECK(jsonb_typeof(query_semantic_classes)='array'), CHECK(jsonb_typeof(matched_document_locator)='object'),
 CHECK(jsonb_typeof(raw_observation)='object')
);
CREATE INDEX IF NOT EXISTS idx_discovery_nominations_channel ON discovery_nominations(channel_id,observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_discovery_nominations_query_rank ON discovery_nominations(query_run_id,result_rank);
CREATE INDEX IF NOT EXISTS idx_discovery_nominations_source_time ON discovery_nominations(source_type,observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_discovery_nominations_country_time ON discovery_nominations(country,observed_at DESC);
ALTER TABLE production_classification_diagnostics ADD COLUMN IF NOT EXISTS nomination_id UUID REFERENCES discovery_nominations(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_classification_diagnostics_nomination ON production_classification_diagnostics(nomination_id) WHERE nomination_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS nomination_events (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), event_key TEXT NOT NULL UNIQUE,
 nomination_id UUID NOT NULL REFERENCES discovery_nominations(id) ON DELETE RESTRICT,
 channel_id TEXT NOT NULL, event_type TEXT NOT NULL CHECK(event_type IN
 ('NOMINATION_OBSERVED','ENTITY_RESOLVED','DUPLICATE_ENTITY','POLICY_REJECTED','INVESTIGATION_QUEUED','BUDGET_DEFERRED','EXPIRED')),
 event_version INTEGER NOT NULL DEFAULT 1 CHECK(event_version>0), payload JSONB NOT NULL,
 policy_version TEXT NOT NULL, occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(), CHECK(jsonb_typeof(payload)='object')
);
CREATE INDEX IF NOT EXISTS idx_nomination_events_replay ON nomination_events(channel_id,occurred_at,id);

CREATE TABLE IF NOT EXISTS candidate_subjects (
 channel_id TEXT PRIMARY KEY, channel_entity_id UUID REFERENCES canonical_entities(id) ON DELETE RESTRICT,
 first_nomination_id UUID NOT NULL REFERENCES discovery_nominations(id) ON DELETE RESTRICT,
 latest_nomination_id UUID NOT NULL REFERENCES discovery_nominations(id) ON DELETE RESTRICT,
 nomination_count INTEGER NOT NULL DEFAULT 1 CHECK(nomination_count>0),
 nomination_state TEXT NOT NULL CHECK(nomination_state IN
 ('OBSERVED','DUPLICATE_ENTITY','POLICY_REJECTED','INVESTIGATION_QUEUED','BUDGET_DEFERRED','EXPIRED')),
 active_investigation_id UUID REFERENCES investigations(id) ON DELETE SET NULL,
 current_admission_state TEXT NOT NULL DEFAULT 'NOT_EVALUATED', projection_version INTEGER NOT NULL DEFAULT 1 CHECK(projection_version>0),
 last_event_id UUID NOT NULL REFERENCES nomination_events(id) ON DELETE RESTRICT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_candidate_subjects_pending ON candidate_subjects(updated_at)
 WHERE nomination_state IN('OBSERVED','BUDGET_DEFERRED');

DO $$ DECLARE t TEXT; BEGIN FOREACH t IN ARRAY ARRAY['discovery_nominations','nomination_events'] LOOP
 EXECUTE format('CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation()',t,t);
END LOOP; END $$;
INSERT INTO app_settings(setting_key,setting_value) VALUES('nomination_ledger_enabled','false') ON CONFLICT(setting_key) DO NOTHING;
COMMENT ON TABLE discovery_nominations IS 'Immutable source observations. A nomination has no channel-serving authority.';
COMMENT ON TABLE candidate_subjects IS 'Repairable current projection; nomination_events is authoritative.';
