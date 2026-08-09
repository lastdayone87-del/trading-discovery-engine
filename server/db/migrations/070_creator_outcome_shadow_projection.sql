-- Phase 1 immutable shadow projection. No trigger, view, job, or runtime path
-- consumes these records, and projection is disabled by default.
CREATE TABLE IF NOT EXISTS creator_outcome_projection_control (
 singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton),
 enabled BOOLEAN NOT NULL DEFAULT false,
 mode TEXT NOT NULL DEFAULT 'SHADOW' CHECK(mode='SHADOW'),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_by TEXT NOT NULL DEFAULT 'system:migration'
);
INSERT INTO creator_outcome_projection_control(singleton) VALUES(true) ON CONFLICT(singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS creator_outcome_projection_runs (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), run_key TEXT NOT NULL UNIQUE,
 cutoff_at TIMESTAMPTZ NOT NULL, projection_version TEXT NOT NULL, contract_version TEXT NOT NULL, policy_version TEXT NOT NULL,
 input_checksum TEXT NOT NULL CHECK(input_checksum ~ '^[a-f0-9]{64}$'), output_checksum TEXT NOT NULL CHECK(output_checksum ~ '^[a-f0-9]{64}$'),
 input_count INTEGER NOT NULL CHECK(input_count>=0), output_count INTEGER NOT NULL CHECK(output_count>=0),
 status TEXT NOT NULL CHECK(status='COMPLETED'), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS creator_outcome_records (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), outcome_key TEXT NOT NULL UNIQUE,
 projection_run_id UUID NOT NULL REFERENCES creator_outcome_projection_runs(id) ON DELETE RESTRICT,
 action_key TEXT NOT NULL, objective_key TEXT NOT NULL,
 query_run_id UUID NOT NULL REFERENCES query_runs(id) ON DELETE RESTRICT, query_id INTEGER NOT NULL REFERENCES query_library(id) ON DELETE RESTRICT,
 channel_id TEXT NOT NULL, canonical_creator_id UUID REFERENCES canonical_entities(id) ON DELETE RESTRICT,
 identity_confidence TEXT NOT NULL CHECK(identity_confidence IN('CONFIRMED','PROBABLE','UNRESOLVED','DISPUTED')),
 entity_cluster_key TEXT, outcome_type TEXT NOT NULL CHECK(outcome_type IN('NEW_VERIFIED_CREATOR','KNOWN_VERIFIED_CREATOR','DUPLICATE_ACCOUNT','COUNTRY_REJECTED','NON_TRADING','UNCERTAIN','NEEDS_REVIEW','HUMAN_REJECTED','OPERATIONALLY_UNRESOLVED')),
 maturity TEXT NOT NULL CHECK(maturity IN('PROVISIONAL','ENRICHED','REVIEWED','TERMINAL')),
 incremental BOOLEAN NOT NULL, verified_creator_credit BOOLEAN NOT NULL, active_creator_credit BOOLEAN NOT NULL,
 provider_units NUMERIC(14,4) NOT NULL CHECK(provider_units>=0), review_units NUMERIC(14,4) NOT NULL CHECK(review_units>=0),
 evidence JSONB NOT NULL CHECK(jsonb_typeof(evidence)='object'), observed_at TIMESTAMPTZ NOT NULL, effective_at TIMESTAMPTZ NOT NULL,
 policy_version TEXT NOT NULL, contract_version TEXT NOT NULL, recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK(NOT verified_creator_credit OR canonical_creator_id IS NOT NULL),
 CHECK(NOT active_creator_credit OR verified_creator_credit)
);
CREATE INDEX IF NOT EXISTS creator_outcomes_query_run_idx ON creator_outcome_records(query_run_id,outcome_type,effective_at);
CREATE INDEX IF NOT EXISTS creator_outcomes_creator_idx ON creator_outcome_records(canonical_creator_id,effective_at) WHERE canonical_creator_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS creator_outcome_source_events (
 outcome_id UUID NOT NULL REFERENCES creator_outcome_records(id) ON DELETE RESTRICT,
 source_event_key TEXT NOT NULL, source_kind TEXT NOT NULL CHECK(source_kind IN('OUTCOME_EVENT','DECISION_EVENT','REVIEW_DECISION','CLASSIFICATION_DIAGNOSTIC','ENTITY_EVENT','ACTIVITY_OBSERVATION')),
 PRIMARY KEY(outcome_id,source_event_key,source_kind)
);

DO $$ DECLARE t TEXT; BEGIN FOREACH t IN ARRAY ARRAY['creator_outcome_projection_runs','creator_outcome_records','creator_outcome_source_events'] LOOP
 EXECUTE format('CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation()',t,t);
END LOOP; END $$;

COMMENT ON TABLE creator_outcome_records IS 'Non-authoritative Phase 1 creator outcomes projected from existing immutable and operational evidence at an explicit cutoff.';
