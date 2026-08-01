-- Phase 20: temporal, entity-resolved research frontier. Expand-first and shadow-only.
CREATE TABLE IF NOT EXISTS temporal_relationship_observations (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), observation_key TEXT NOT NULL UNIQUE,
 from_entity_id UUID NOT NULL REFERENCES canonical_entities(id) ON DELETE RESTRICT,
 to_entity_id UUID NOT NULL REFERENCES canonical_entities(id) ON DELETE RESTRICT,
 relationship_type TEXT NOT NULL CHECK(relationship_type IN('COLLABORATES_WITH','FEATURES','OWNS','MEMBER_OF','MENTIONS','LINKS_TO','PUBLISHES','USES_CONCEPT')),
 source_family_id UUID NOT NULL REFERENCES source_families(id) ON DELETE RESTRICT,
 source_artifact_id UUID REFERENCES corpus_source_artifacts(id) ON DELETE RESTRICT,
 source_locator JSONB NOT NULL, confidence_basis_points INTEGER NOT NULL CHECK(confidence_basis_points BETWEEN 0 AND 10000),
 assertion TEXT NOT NULL CHECK(assertion IN('ASSERTED','RETRACTED')),
 observed_at TIMESTAMPTZ NOT NULL, valid_from TIMESTAMPTZ NOT NULL, valid_until TIMESTAMPTZ,
 extractor_version TEXT NOT NULL, provenance_checksum TEXT NOT NULL,
 CHECK(from_entity_id<>to_entity_id), CHECK(valid_until IS NULL OR valid_until>valid_from)
);
CREATE INDEX IF NOT EXISTS idx_temporal_relationship_from ON temporal_relationship_observations(from_entity_id,relationship_type,valid_from DESC);
CREATE INDEX IF NOT EXISTS idx_temporal_relationship_to ON temporal_relationship_observations(to_entity_id,relationship_type,valid_from DESC);

CREATE TABLE IF NOT EXISTS research_frontier_snapshots (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), snapshot_key TEXT NOT NULL UNIQUE,
 as_of TIMESTAMPTZ NOT NULL, policy_version TEXT NOT NULL, entity_resolution_policy_version TEXT NOT NULL,
 definition JSONB NOT NULL, relationship_count INTEGER NOT NULL CHECK(relationship_count>=0),
 checksum TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'SEALED' CHECK(status IN('SEALED','RETIRED')),
 created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS research_frontier_runs (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), run_key TEXT NOT NULL UNIQUE,
 snapshot_id UUID NOT NULL REFERENCES research_frontier_snapshots(id) ON DELETE RESTRICT,
 program_id UUID REFERENCES research_programs(id) ON DELETE RESTRICT,
 mode TEXT NOT NULL CHECK(mode IN('SHADOW','CANARY')), seed_entity_ids JSONB NOT NULL CHECK(jsonb_typeof(seed_entity_ids)='array'),
 policy JSONB NOT NULL, policy_version TEXT NOT NULL, propensity_basis_points INTEGER NOT NULL CHECK(propensity_basis_points BETWEEN 1 AND 10000),
 status TEXT NOT NULL CHECK(status IN('PLANNED','EVALUATED','REJECTED')), created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS research_frontier_candidates (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), run_id UUID NOT NULL REFERENCES research_frontier_runs(id) ON DELETE RESTRICT,
 candidate_key TEXT NOT NULL, entity_id UUID NOT NULL REFERENCES canonical_entities(id) ON DELETE RESTRICT,
 depth INTEGER NOT NULL CHECK(depth BETWEEN 1 AND 3), parent_entity_id UUID NOT NULL REFERENCES canonical_entities(id) ON DELETE RESTRICT,
 attribution_path JSONB NOT NULL CHECK(jsonb_typeof(attribution_path)='array'), independent_source_families INTEGER NOT NULL CHECK(independent_source_families>=1),
 score_basis_points INTEGER NOT NULL CHECK(score_basis_points BETWEEN 0 AND 10000), disposition TEXT NOT NULL CHECK(disposition IN('ELIGIBLE','HUB_CAPPED','COMPONENT_CAPPED','INSUFFICIENT_INDEPENDENCE','STALE')),
 reason_codes JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(run_id,candidate_key)
);
CREATE TABLE IF NOT EXISTS research_frontier_outcomes (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), outcome_key TEXT NOT NULL UNIQUE,
 run_id UUID NOT NULL REFERENCES research_frontier_runs(id) ON DELETE RESTRICT,
 candidate_id UUID REFERENCES research_frontier_candidates(id) ON DELETE RESTRICT,
 evaluation_assignment_id UUID REFERENCES evaluation_cohort_assignments(id) ON DELETE RESTRICT,
 outcome TEXT NOT NULL CHECK(outcome IN('NEW_CONFIRMED_CREATOR','KNOWN_CREATOR','REVIEW','REJECTED','UNREACHABLE')),
 provider_cost INTEGER NOT NULL CHECK(provider_cost>=0), confirmation_latency_ms INTEGER CHECK(confirmation_latency_ms>=0),
 evidence JSONB NOT NULL, observed_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS research_frontier_controls (
 singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton), mode TEXT NOT NULL DEFAULT 'SHADOW' CHECK(mode IN('SHADOW','CANARY')),
 paused BOOLEAN NOT NULL DEFAULT true, kill_switch BOOLEAN NOT NULL DEFAULT true,
 max_depth INTEGER NOT NULL DEFAULT 2 CHECK(max_depth BETWEEN 1 AND 3), max_fanout INTEGER NOT NULL DEFAULT 10 CHECK(max_fanout BETWEEN 1 AND 50),
 max_hub_degree INTEGER NOT NULL DEFAULT 100 CHECK(max_hub_degree BETWEEN 2 AND 10000), max_component_candidates INTEGER NOT NULL DEFAULT 100 CHECK(max_component_candidates BETWEEN 1 AND 1000),
 daily_provider_cost_cap INTEGER NOT NULL DEFAULT 0 CHECK(daily_provider_cost_cap>=0), canary_basis_points INTEGER NOT NULL DEFAULT 0 CHECK(canary_basis_points BETWEEN 0 AND 1000),
 policy_version TEXT NOT NULL DEFAULT 'temporal-frontier-v1', configuration_version INTEGER NOT NULL DEFAULT 1 CHECK(configuration_version>0),
 updated_by TEXT NOT NULL DEFAULT 'system:migration', updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK(mode='SHADOW' OR paused OR kill_switch OR (daily_provider_cost_cap>0 AND canary_basis_points>0))
);
INSERT INTO research_frontier_controls(singleton) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS research_frontier_control_events (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), idempotency_key TEXT NOT NULL UNIQUE,
 from_version INTEGER NOT NULL, to_version INTEGER NOT NULL, configuration JSONB NOT NULL,
 actor TEXT NOT NULL, reason TEXT NOT NULL, occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
DO $$ DECLARE t TEXT; BEGIN FOREACH t IN ARRAY ARRAY['temporal_relationship_observations','research_frontier_snapshots','research_frontier_runs','research_frontier_candidates','research_frontier_outcomes','research_frontier_control_events'] LOOP EXECUTE format('CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation()',t,t); END LOOP; END $$;
COMMENT ON TABLE temporal_relationship_observations IS 'Append-only bitemporal, source-bound relationship assertions; latest observations never rewrite history.';
COMMENT ON TABLE research_frontier_candidates IS 'Offline attributed candidates only. A candidate cannot confirm, classify, or activate itself.';
