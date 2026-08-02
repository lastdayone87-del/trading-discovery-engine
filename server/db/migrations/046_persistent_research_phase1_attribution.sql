-- Phase 1 completion: immutable multi-path credit and control-aware incrementality.
CREATE TABLE IF NOT EXISTS discovery_entity_credit_snapshots (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), credit_key TEXT NOT NULL UNIQUE,
 canonical_entity_id UUID REFERENCES canonical_entities(id) ON DELETE RESTRICT,
 channel_id TEXT NOT NULL, action_id UUID NOT NULL REFERENCES discovery_actions(id) ON DELETE RESTRICT,
 assignment_id UUID REFERENCES discovery_action_assignments(id) ON DELETE RESTRICT,
 credit_model TEXT NOT NULL CHECK(credit_model IN('FIRST_TOUCH','EQUAL_PATH')),
 credit_basis_points INTEGER NOT NULL CHECK(credit_basis_points BETWEEN 0 AND 10000),
 path_count INTEGER NOT NULL CHECK(path_count>0), evidence_cutoff TIMESTAMPTZ NOT NULL,
 source_capture_ids JSONB NOT NULL, policy_version TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS discovery_incrementality_snapshots (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), snapshot_key TEXT NOT NULL UNIQUE,
 program_id UUID REFERENCES research_programs(id) ON DELETE RESTRICT,
 coordinates JSONB NOT NULL, evidence_cutoff TIMESTAMPTZ NOT NULL,
 treatment_actions INTEGER NOT NULL CHECK(treatment_actions>=0), control_actions INTEGER NOT NULL CHECK(control_actions>=0),
 treatment_entities INTEGER NOT NULL CHECK(treatment_entities>=0), control_entities INTEGER NOT NULL CHECK(control_entities>=0),
 overlap_entities INTEGER NOT NULL CHECK(overlap_entities>=0), incremental_entities INTEGER NOT NULL CHECK(incremental_entities>=0),
 treatment_cost INTEGER NOT NULL CHECK(treatment_cost>=0), control_cost INTEGER NOT NULL CHECK(control_cost>=0),
 incremental_per_cost DOUBLE PRECISION NOT NULL, estimator_version TEXT NOT NULL,
 evidence JSONB NOT NULL, policy_version TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ DECLARE t TEXT; BEGIN FOREACH t IN ARRAY ARRAY['discovery_entity_credit_snapshots','discovery_incrementality_snapshots'] LOOP
 EXECUTE format('CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation()',t,t);
END LOOP; END $$;
CREATE INDEX IF NOT EXISTS discovery_credit_entity_cutoff_idx ON discovery_entity_credit_snapshots(canonical_entity_id,channel_id,evidence_cutoff);
