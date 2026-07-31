-- Priority 10: unified governed knowledge publications. Expand-first; mutable graph remains offline.
CREATE TABLE IF NOT EXISTS knowledge_publications (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), version INTEGER NOT NULL CHECK(version>0), schema_version TEXT NOT NULL,
 country TEXT NOT NULL, locale TEXT NOT NULL, lane TEXT NOT NULL CHECK(lane IN ('CLASSIFICATION','DISCOVERY','SEMANTICS','LANGUAGE','TERMINOLOGY')),
 policy_version TEXT NOT NULL, checksum TEXT NOT NULL UNIQUE, artifact JSONB NOT NULL CHECK(jsonb_typeof(artifact)='object'),
 status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','APPROVED','RETIRED')), created_by TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(country,locale,lane,version)
);
CREATE TABLE IF NOT EXISTS knowledge_publication_approvals (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), publication_id UUID NOT NULL REFERENCES knowledge_publications(id), idempotency_key TEXT NOT NULL UNIQUE,
 expected_status TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT NOT NULL, approved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS active_knowledge_pointers (
 scope_key TEXT PRIMARY KEY, country TEXT NOT NULL, locale TEXT NOT NULL, lane TEXT NOT NULL,
 publication_id UUID NOT NULL REFERENCES knowledge_publications(id), pointer_version INTEGER NOT NULL CHECK(pointer_version>0), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(country,locale,lane)
);
CREATE TABLE IF NOT EXISTS knowledge_publication_events (
 id UUID PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, scope_key TEXT NOT NULL,
 from_publication_id UUID REFERENCES knowledge_publications(id), to_publication_id UUID NOT NULL REFERENCES knowledge_publications(id),
 from_pointer_version INTEGER NOT NULL CHECK(from_pointer_version>=0), to_pointer_version INTEGER NOT NULL CHECK(to_pointer_version>0),
 action TEXT NOT NULL CHECK(action IN ('PUBLISH','ROLLBACK')), checksum TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT NOT NULL, occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS knowledge_contributions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), contribution_key TEXT NOT NULL UNIQUE, concept_id UUID NOT NULL REFERENCES concepts(id),
 subsystem TEXT NOT NULL CHECK(subsystem IN ('DISCOVERY','CLASSIFICATION','SEMANTICS','LANGUAGE','TERMINOLOGY','QUERY_GENERATION')),
 evidence_ref TEXT NOT NULL, evidence_checksum TEXT NOT NULL, payload JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'PROPOSED' CHECK(status IN ('PROPOSED','REVIEWED','REJECTED')),
 observed_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS knowledge_consumption_records (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), consumer_run_id TEXT NOT NULL, consumer TEXT NOT NULL, publication_id UUID NOT NULL REFERENCES knowledge_publications(id),
 pointer_version INTEGER NOT NULL CHECK(pointer_version>0), publication_checksum TEXT NOT NULL, policy_version TEXT NOT NULL, recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(consumer_run_id,consumer)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_scope ON knowledge_publications(country,locale,lane,status,version DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_concept_contributions ON knowledge_contributions(concept_id,subsystem,observed_at DESC);
DO $$ DECLARE t TEXT; BEGIN FOREACH t IN ARRAY ARRAY['knowledge_publication_approvals','knowledge_publication_events','knowledge_contributions','knowledge_consumption_records'] LOOP
 EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation()',t||'_immutable',t);
END LOOP; END $$;
COMMENT ON TABLE knowledge_publications IS 'Immutable compact production knowledge; consumers pin checksum, version, policy, and pointer. Mutable concept state is never read online.';
COMMENT ON TABLE knowledge_contributions IS 'Append-only subsystem proposals. Contribution does not grant production eligibility.';
