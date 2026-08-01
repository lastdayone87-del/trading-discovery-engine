-- Conservative entity resolution and source-family independence.
-- Exact provider-native identifiers may create an entity; ambiguous cross-source
-- links remain proposals until an immutable moderation decision approves them.

CREATE TABLE IF NOT EXISTS canonical_entities (
 id UUID PRIMARY KEY, entity_type TEXT NOT NULL CHECK(entity_type IN('CREATOR','CHANNEL','FIRM','BROKER','EXCHANGE','PLATFORM','WEBSITE','COMMUNITY','OTHER')),
 status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN('ACTIVE','MERGED','SPLIT','RETIRED')),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), display_name TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS source_families (
 id UUID PRIMARY KEY, family_key TEXT NOT NULL UNIQUE,
 family_type TEXT NOT NULL CHECK(family_type IN('PROVIDER_NATIVE','CANONICAL_DOCUMENT','CONTENT_FINGERPRINT','EXPLICIT_SYNDICATION','UNKNOWN_ARTIFACT')),
 root_locator TEXT NOT NULL, policy_version TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS source_family_memberships (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), family_id UUID NOT NULL REFERENCES source_families(id) ON DELETE RESTRICT,
 evidence_node_id UUID REFERENCES evidence_nodes(id) ON DELETE RESTRICT, source_artifact_id UUID REFERENCES corpus_source_artifacts(id) ON DELETE RESTRICT,
 membership_key TEXT NOT NULL UNIQUE, method TEXT NOT NULL, confidence_basis_points INTEGER NOT NULL CHECK(confidence_basis_points BETWEEN 0 AND 10000),
 source_locator JSONB NOT NULL, observed_at TIMESTAMPTZ NOT NULL, policy_version TEXT NOT NULL,
 CHECK(evidence_node_id IS NOT NULL OR source_artifact_id IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS entity_identifier_observations (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), observation_key TEXT NOT NULL UNIQUE,
 namespace TEXT NOT NULL, normalized_value TEXT NOT NULL, literal_value TEXT NOT NULL,
 evidence_node_id UUID REFERENCES evidence_nodes(id) ON DELETE RESTRICT,
 source_artifact_id UUID REFERENCES corpus_source_artifacts(id) ON DELETE RESTRICT,
 source_family_id UUID NOT NULL REFERENCES source_families(id) ON DELETE RESTRICT,
 source_entity_id UUID REFERENCES canonical_entities(id) ON DELETE RESTRICT,
 observed_at TIMESTAMPTZ NOT NULL, policy_version TEXT NOT NULL, provenance JSONB NOT NULL,
 CHECK(evidence_node_id IS NOT NULL OR source_artifact_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_entity_identifiers_lookup ON entity_identifier_observations(namespace,normalized_value,observed_at DESC);
CREATE TABLE IF NOT EXISTS entity_bindings (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), entity_id UUID NOT NULL REFERENCES canonical_entities(id) ON DELETE RESTRICT,
 namespace TEXT NOT NULL, normalized_value TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN('PROPOSED','APPROVED','REJECTED','SUPERSEDED')),
 confidence_basis_points INTEGER NOT NULL CHECK(confidence_basis_points BETWEEN 0 AND 10000),
 resolution_basis TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(entity_id,namespace,normalized_value)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_binding_approved_identifier ON entity_bindings(namespace,normalized_value) WHERE status='APPROVED';
CREATE TABLE IF NOT EXISTS entity_resolution_proposals (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), proposal_key TEXT NOT NULL UNIQUE,
 subject_entity_id UUID NOT NULL REFERENCES canonical_entities(id) ON DELETE RESTRICT,
 candidate_entity_id UUID REFERENCES canonical_entities(id) ON DELETE RESTRICT,
 namespace TEXT NOT NULL, normalized_value TEXT NOT NULL,
 independent_source_families INTEGER NOT NULL CHECK(independent_source_families>=0),
 independent_source_entities INTEGER NOT NULL CHECK(independent_source_entities>=0),
 disposition TEXT NOT NULL CHECK(disposition IN('EXACT_NATIVE','PROPOSE_LINK','ABSTAIN_CONFLICT','ABSTAIN_INSUFFICIENT')),
 evidence JSONB NOT NULL, policy_version TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS entity_resolution_decisions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), idempotency_key TEXT NOT NULL UNIQUE,
 action TEXT NOT NULL CHECK(action IN('APPROVE_BINDING','REJECT_BINDING','SUPERSEDE_BINDING')),
 binding_id UUID NOT NULL REFERENCES entity_bindings(id) ON DELETE RESTRICT,
 expected_version INTEGER NOT NULL, actor TEXT NOT NULL, reason TEXT NOT NULL,
 evidence_checksum TEXT NOT NULL, decided_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS entity_projection_events (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), event_key TEXT NOT NULL UNIQUE,
 entity_id UUID NOT NULL REFERENCES canonical_entities(id) ON DELETE RESTRICT,
 event_type TEXT NOT NULL CHECK(event_type IN('ENTITY_CREATED','NATIVE_IDENTIFIER_BOUND','BINDING_APPROVED','BINDING_REJECTED','BINDING_SUPERSEDED')),
 payload JSONB NOT NULL, policy_version TEXT NOT NULL, actor TEXT NOT NULL, occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
DO $$ DECLARE t TEXT; BEGIN FOREACH t IN ARRAY ARRAY['source_families','source_family_memberships','entity_identifier_observations','entity_resolution_proposals','entity_resolution_decisions','entity_projection_events'] LOOP EXECUTE format('CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation()',t,t); END LOOP; END $$;
INSERT INTO app_settings(setting_key,setting_value) VALUES('entity_observation_enabled','false') ON CONFLICT(setting_key) DO NOTHING;
COMMENT ON TABLE entity_bindings IS 'Governed projection. Only provider-native exact identifiers are approved without a separate moderation decision.';
COMMENT ON TABLE source_families IS 'Correlation units for evidence independence; occurrence volume within one family counts once.';
