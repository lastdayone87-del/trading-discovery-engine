-- Phase 2: source-bound creator relationship extraction and controlled graph trials.
CREATE TABLE IF NOT EXISTS creator_relationship_candidates (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), candidate_key TEXT NOT NULL UNIQUE,
 program_id UUID NOT NULL REFERENCES research_programs(id) ON DELETE RESTRICT,
 source_entity_id UUID NOT NULL REFERENCES canonical_entities(id) ON DELETE RESTRICT,
 target_namespace TEXT NOT NULL CHECK(target_namespace IN('YOUTUBE_CHANNEL_ID','PLATFORM_ACCOUNT')),
 target_value TEXT NOT NULL, relationship_type TEXT NOT NULL CHECK(relationship_type IN('COLLABORATES_WITH','FEATURES','MENTIONS','LINKS_TO')),
 source_family_id UUID NOT NULL REFERENCES source_families(id) ON DELETE RESTRICT,
 source_artifact_id UUID NOT NULL REFERENCES corpus_source_artifacts(id) ON DELETE RESTRICT,
 source_locator JSONB NOT NULL, confidence_basis_points INTEGER NOT NULL CHECK(confidence_basis_points BETWEEN 0 AND 10000),
 lifecycle TEXT NOT NULL DEFAULT 'PROPOSED' CHECK(lifecycle IN('PROPOSED','ACTIONED','RESOLVED','REJECTED','STALE')),
 extractor_version TEXT NOT NULL, observed_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS creator_relationship_frontier_idx ON creator_relationship_candidates(program_id,lifecycle,observed_at);
UPDATE discovery_provider_registry SET capabilities=capabilities||'["INSPECT_FEATURED_CHANNELS","INSPECT_COLLABORATOR","REFRESH_STALE_FRONTIER","RESOLVE_EXTERNAL_ENTITY"]'::jsonb,configuration_version=configuration_version+1,updated_at=now(),updated_by='system:migration-047' WHERE provider_key='youtube-search';

CREATE TABLE IF NOT EXISTS graph_search_experiment_assignments (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), assignment_key TEXT NOT NULL UNIQUE,
 relationship_candidate_id UUID NOT NULL REFERENCES creator_relationship_candidates(id) ON DELETE RESTRICT,
 arm TEXT NOT NULL CHECK(arm IN('GRAPH','SEARCH_CONTROL')),
 propensity_basis_points INTEGER NOT NULL CHECK(propensity_basis_points BETWEEN 1 AND 10000),
 cohort_block TEXT NOT NULL, policy_version TEXT NOT NULL, assigned_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS graph_search_experiment_outcomes (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), outcome_key TEXT NOT NULL UNIQUE,
 assignment_id UUID NOT NULL REFERENCES graph_search_experiment_assignments(id) ON DELETE RESTRICT,
 canonical_entity_id UUID REFERENCES canonical_entities(id) ON DELETE RESTRICT,
 channel_id TEXT NOT NULL, confirmed BOOLEAN NOT NULL, incremental BOOLEAN NOT NULL,
 provider_cost INTEGER NOT NULL CHECK(provider_cost>=0), evidence JSONB NOT NULL,
 observed_at TIMESTAMPTZ NOT NULL, policy_version TEXT NOT NULL
);
DO $$ DECLARE t TEXT; BEGIN FOREACH t IN ARRAY ARRAY['graph_search_experiment_assignments','graph_search_experiment_outcomes'] LOOP
 EXECUTE format('CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation()',t,t);
END LOOP; END $$;
