-- Phase 14a: typed evidence graph and proposal-only playlist adapter foundation.
-- Expand-only: no existing table, queue payload, or online planner dependency changes.
CREATE TABLE IF NOT EXISTS evidence_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), node_type TEXT NOT NULL
    CHECK(node_type IN ('CHANNEL','PLAYLIST','VIDEO','WEBSITE','COMMUNITY','CONCEPT','ARTIFACT')),
  canonical_key TEXT NOT NULL, canonical_entity_id UUID REFERENCES concepts(id) ON DELETE RESTRICT,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(attributes)='object'),
  first_observed_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(node_type,canonical_key)
);
CREATE TABLE IF NOT EXISTS evidence_edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), from_node_id UUID NOT NULL REFERENCES evidence_nodes(id) ON DELETE RESTRICT,
  to_node_id UUID NOT NULL REFERENCES evidence_nodes(id) ON DELETE RESTRICT, edge_type TEXT NOT NULL
    CHECK(edge_type IN ('CONTAINS','PUBLISHED_BY','LINKS_TO','RELATED_TO','MENTIONS','REPRESENTS')),
  source_artifact_id UUID REFERENCES corpus_source_artifacts(id) ON DELETE RESTRICT, source_locator JSONB NOT NULL,
  confidence_basis_points INTEGER NOT NULL CHECK(confidence_basis_points BETWEEN 0 AND 10000),
  observed_at TIMESTAMPTZ NOT NULL, valid_from TIMESTAMPTZ NOT NULL, valid_until TIMESTAMPTZ,
  extractor_version TEXT NOT NULL, path JSONB NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(path)='array'),
  edge_key TEXT NOT NULL UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK(from_node_id<>to_node_id), CHECK(valid_until IS NULL OR valid_until>valid_from)
);
CREATE TABLE IF NOT EXISTS evidence_assertions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), subject_node_id UUID NOT NULL REFERENCES evidence_nodes(id) ON DELETE RESTRICT,
  predicate TEXT NOT NULL, value JSONB NOT NULL, source_artifact_id UUID REFERENCES corpus_source_artifacts(id) ON DELETE RESTRICT,
  source_locator JSONB NOT NULL, confidence_basis_points INTEGER NOT NULL CHECK(confidence_basis_points BETWEEN 0 AND 10000),
  observed_at TIMESTAMPTZ NOT NULL, extractor_version TEXT NOT NULL, assertion_key TEXT NOT NULL UNIQUE,
  supersedes_assertion_id UUID REFERENCES evidence_assertions(id) ON DELETE RESTRICT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS evidence_program_visits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), program_id UUID NOT NULL REFERENCES research_programs(id) ON DELETE RESTRICT,
  node_id UUID NOT NULL REFERENCES evidence_nodes(id) ON DELETE RESTRICT, action_id UUID REFERENCES frontier_actions(id) ON DELETE RESTRICT,
  visit_key TEXT NOT NULL, depth INTEGER NOT NULL CHECK(depth BETWEEN 0 AND 3), attribution_path JSONB NOT NULL CHECK(jsonb_typeof(attribution_path)='array'),
  status TEXT NOT NULL CHECK(status IN ('PROPOSED','VISITED','SKIPPED','FAILED')), policy_version TEXT NOT NULL,
  visited_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(program_id,visit_key)
);
CREATE TABLE IF NOT EXISTS acquisition_adapter_controls (
  adapter_type TEXT PRIMARY KEY CHECK(adapter_type IN ('INSPECT_PLAYLIST','INSPECT_CHANNEL_RELATIONS','INSPECT_WEBSITE')),
  mode TEXT NOT NULL DEFAULT 'SHADOW' CHECK(mode IN ('SHADOW','CANARY')), paused BOOLEAN NOT NULL DEFAULT true,
  kill_switch BOOLEAN NOT NULL DEFAULT true, daily_quota_cap INTEGER NOT NULL DEFAULT 0 CHECK(daily_quota_cap>=0),
  total_quota_cap INTEGER NOT NULL DEFAULT 0 CHECK(total_quota_cap>=0), consumed_quota INTEGER NOT NULL DEFAULT 0 CHECK(consumed_quota>=0),
  max_depth INTEGER NOT NULL DEFAULT 1 CHECK(max_depth BETWEEN 1 AND 3), max_fanout INTEGER NOT NULL DEFAULT 10 CHECK(max_fanout BETWEEN 1 AND 50),
  policy_version TEXT NOT NULL, configuration_version INTEGER NOT NULL DEFAULT 1 CHECK(configuration_version>0), updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK(mode='SHADOW' OR paused OR kill_switch OR (daily_quota_cap>0 AND total_quota_cap>0))
);
INSERT INTO acquisition_adapter_controls(adapter_type,policy_version,updated_by)
VALUES('INSPECT_PLAYLIST','playlist-adapter-v1','system:migration') ON CONFLICT(adapter_type) DO NOTHING;
ALTER TABLE frontier_actions DROP CONSTRAINT IF EXISTS frontier_actions_action_type_check;
ALTER TABLE frontier_actions ADD CONSTRAINT frontier_actions_action_type_check CHECK
  (action_type IN ('SEARCH_TERM','CONTINUE_RESULT_PAGE','INSPECT_PLAYLIST')) NOT VALID;
ALTER TABLE frontier_actions VALIDATE CONSTRAINT frontier_actions_action_type_check;
CREATE INDEX IF NOT EXISTS idx_evidence_edges_from_type ON evidence_edges(from_node_id,edge_type,observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_edges_to_type ON evidence_edges(to_node_id,edge_type,observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_visits_program ON evidence_program_visits(program_id,node_id,visited_at DESC);
DO $$ DECLARE t TEXT; BEGIN FOREACH t IN ARRAY ARRAY['evidence_nodes','evidence_edges','evidence_assertions'] LOOP
 EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation()',t||'_immutable',t);
END LOOP; END $$;
COMMENT ON TABLE evidence_program_visits IS 'Program-specific attribution; global evidence reuse never implies program coverage.';
COMMENT ON TABLE acquisition_adapter_controls IS 'Phase 14 adapters install paused and killed; each requires a separately approved equal-budget gate.';
