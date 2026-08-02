-- Phase 5: allowlisted structured-provider execution. No arbitrary URL crawling.
CREATE TABLE IF NOT EXISTS external_provider_adapter_controls (
 adapter_key TEXT PRIMARY KEY REFERENCES discovery_provider_registry(provider_key) ON DELETE RESTRICT,
 mode TEXT NOT NULL DEFAULT 'SHADOW' CHECK(mode IN('SHADOW','CANARY','ACTIVE','PAUSED')),
 paused BOOLEAN NOT NULL DEFAULT true, kill_switch BOOLEAN NOT NULL DEFAULT true,
 timeout_ms INTEGER NOT NULL DEFAULT 5000 CHECK(timeout_ms BETWEEN 100 AND 30000),
 max_pages INTEGER NOT NULL DEFAULT 1 CHECK(max_pages BETWEEN 1 AND 10),
 max_items_per_page INTEGER NOT NULL DEFAULT 25 CHECK(max_items_per_page BETWEEN 1 AND 50),
 daily_request_cap INTEGER NOT NULL DEFAULT 0 CHECK(daily_request_cap>=0), configuration JSONB NOT NULL DEFAULT '{}'::jsonb,
 configuration_version INTEGER NOT NULL DEFAULT 1, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS external_provider_runs (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), run_key TEXT NOT NULL UNIQUE,
 adapter_key TEXT NOT NULL REFERENCES external_provider_adapter_controls(adapter_key) ON DELETE RESTRICT,
 job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT, program_id UUID REFERENCES research_programs(id) ON DELETE RESTRICT,
 status TEXT NOT NULL CHECK(status IN('SUCCEEDED','FAILED','ABSTAINED')), page_count INTEGER NOT NULL CHECK(page_count>=0),
 item_count INTEGER NOT NULL CHECK(item_count>=0), continuation_exhausted BOOLEAN NOT NULL,
 request_contract JSONB NOT NULL, failure_class TEXT, started_at TIMESTAMPTZ NOT NULL, completed_at TIMESTAMPTZ NOT NULL,
 policy_version TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS external_provider_pages (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), page_key TEXT NOT NULL UNIQUE,
 run_id UUID NOT NULL REFERENCES external_provider_runs(id) ON DELETE RESTRICT,
 page_number INTEGER NOT NULL CHECK(page_number BETWEEN 1 AND 10), input_cursor_hash TEXT, output_cursor_hash TEXT,
 item_count INTEGER NOT NULL CHECK(item_count BETWEEN 0 AND 50), payload_checksum TEXT NOT NULL,
 observed_at TIMESTAMPTZ NOT NULL, policy_version TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS external_identity_resolution_observations (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), observation_key TEXT NOT NULL UNIQUE,
 nomination_key TEXT NOT NULL, provider_key TEXT NOT NULL, provider_namespace TEXT NOT NULL,
 provider_native_id TEXT NOT NULL, youtube_channel_id TEXT, resolution_status TEXT NOT NULL CHECK(resolution_status IN('EXACT_NATIVE','SEARCH_REQUIRED','ABSTAINED')),
 confidence_basis_points INTEGER NOT NULL CHECK(confidence_basis_points BETWEEN 0 AND 10000),
 source_family_id TEXT NOT NULL, evidence JSONB NOT NULL, observed_at TIMESTAMPTZ NOT NULL, policy_version TEXT NOT NULL
);
INSERT INTO queue_controls(queue_name,is_paused) VALUES('external_provider_jobs',true) ON CONFLICT(queue_name) DO NOTHING;
DO $$ DECLARE t TEXT; BEGIN FOREACH t IN ARRAY ARRAY['external_provider_runs','external_provider_pages','external_identity_resolution_observations'] LOOP EXECUTE format('CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation()',t,t); END LOOP; END $$;
