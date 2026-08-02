-- Phase 4: replayable hierarchical opportunity surface and ecosystem overlap.
CREATE TABLE IF NOT EXISTS coverage_projection_snapshots (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), snapshot_key TEXT NOT NULL UNIQUE,
 cell_key TEXT NOT NULL REFERENCES hierarchical_coverage_cells(cell_key) ON DELETE RESTRICT,
 parent_cell_key TEXT, coordinates JSONB NOT NULL, lane_entity_sets JSONB NOT NULL,
 observed_entities INTEGER NOT NULL CHECK(observed_entities>=0), estimated_unseen DOUBLE PRECISION,
 posterior_uncertainty DOUBLE PRECISION NOT NULL CHECK(posterior_uncertainty BETWEEN 0 AND 1),
 reason_codes JSONB NOT NULL, evidence_cutoff TIMESTAMPTZ NOT NULL, policy_version TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS discovery_action_ecosystem_signatures (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), signature_key TEXT NOT NULL UNIQUE,
 action_id UUID NOT NULL REFERENCES discovery_actions(id) ON DELETE RESTRICT,
 result_entities JSONB NOT NULL, semantic_terms JSONB NOT NULL, creator_components JSONB NOT NULL,
 source_families JSONB NOT NULL, evidence_cutoff TIMESTAMPTZ NOT NULL, policy_version TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS research_program_lifecycle_events (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), decision_key TEXT NOT NULL UNIQUE,
 program_id UUID NOT NULL REFERENCES research_programs(id) ON DELETE RESTRICT,
 from_lifecycle TEXT NOT NULL, to_lifecycle TEXT NOT NULL,
 trigger_type TEXT NOT NULL, predicates JSONB NOT NULL, affected_cell_keys JSONB NOT NULL,
 evidence_cutoff TIMESTAMPTZ NOT NULL, policy_version TEXT NOT NULL, decided_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS coverage_snapshot_cutoff_idx ON coverage_projection_snapshots(cell_key,evidence_cutoff);
DO $$ DECLARE t TEXT; BEGIN FOREACH t IN ARRAY ARRAY['coverage_projection_snapshots','discovery_action_ecosystem_signatures','research_program_lifecycle_events'] LOOP EXECUTE format('CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation()',t,t); END LOOP; END $$;
