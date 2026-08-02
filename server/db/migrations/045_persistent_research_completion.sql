-- Entity-level capture, replayable lifecycle, and offline policy comparison.
CREATE TABLE IF NOT EXISTS discovery_entity_captures (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), capture_key TEXT NOT NULL UNIQUE,
 action_id UUID NOT NULL REFERENCES discovery_actions(id) ON DELETE RESTRICT,
 assignment_id UUID REFERENCES discovery_action_assignments(id) ON DELETE RESTRICT,
 query_run_id UUID REFERENCES query_runs(id) ON DELETE RESTRICT,
 channel_id TEXT NOT NULL, canonical_entity_id UUID REFERENCES canonical_entities(id) ON DELETE RESTRICT,
 capture_type TEXT NOT NULL CHECK(capture_type IN('NOMINATED','KNOWN','NEW','CONFIRMED','REJECTED','UNCERTAIN')),
 first_ecosystem_capture BOOLEAN NOT NULL, rank INTEGER, coordinates JSONB NOT NULL,
 source_family_id TEXT NOT NULL, observed_at TIMESTAMPTZ NOT NULL, policy_version TEXT NOT NULL,
 UNIQUE(action_id,channel_id,capture_type)
);
CREATE INDEX IF NOT EXISTS discovery_capture_entity_time_idx ON discovery_entity_captures(canonical_entity_id,channel_id,observed_at);

CREATE TABLE IF NOT EXISTS coverage_lifecycle_decision_events (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), decision_key TEXT NOT NULL UNIQUE,
 cell_key TEXT NOT NULL REFERENCES hierarchical_coverage_cells(cell_key) ON DELETE RESTRICT,
 from_lifecycle TEXT NOT NULL, to_lifecycle TEXT NOT NULL,
 trigger_type TEXT, predicates JSONB NOT NULL, evidence_cutoff TIMESTAMPTZ NOT NULL,
 policy_version TEXT NOT NULL, decided_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS research_policy_replay_runs (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), replay_key TEXT NOT NULL UNIQUE,
 candidate_policy_id UUID NOT NULL REFERENCES portfolio_policies(id) ON DELETE RESTRICT,
 baseline_policy_id UUID NOT NULL REFERENCES portfolio_policies(id) ON DELETE RESTRICT,
 dataset_cutoff TIMESTAMPTZ NOT NULL, dataset_checksum TEXT NOT NULL,
 candidate_metrics JSONB NOT NULL, baseline_metrics JSONB NOT NULL, comparison JSONB NOT NULL,
 effective_sample_size DOUBLE PRECISION NOT NULL CHECK(effective_sample_size>=0),
 decision TEXT NOT NULL CHECK(decision IN('PASS','FAIL','ABSTAIN')),
 reason_codes JSONB NOT NULL, created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ DECLARE t TEXT; BEGIN FOREACH t IN ARRAY ARRAY['discovery_entity_captures','coverage_lifecycle_decision_events','research_policy_replay_runs'] LOOP
 EXECUTE format('CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation()',t,t);
END LOOP; END $$;
