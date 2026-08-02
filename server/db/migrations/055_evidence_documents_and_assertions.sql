-- Release 2 / Phase 3: immutable classification documents and derived assertions.
-- The pre-existing evidence_assertions table belongs to the research graph, so
-- classification assertions use an explicit name rather than overloading it.
CREATE TABLE IF NOT EXISTS evidence_documents (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), document_key TEXT NOT NULL UNIQUE,
 subject_entity_id UUID NOT NULL, channel_id TEXT NOT NULL,
 document_type TEXT NOT NULL CHECK(document_type IN
 ('CHANNEL_TITLE','CHANNEL_ABOUT','VIDEO_TITLE','VIDEO_DESCRIPTION','PLAYLIST_TITLE','PLAYLIST_DESCRIPTION',
  'TRANSCRIPT_EXCERPT','EXTERNAL_LINK','COMMUNITY_METADATA','VISUAL_OBSERVATION','SEARCH_MATCH_CONTEXT',
  'PINNED_COMMENT','LOCATION','ACTIVITY_METADATA')),
 provider TEXT NOT NULL, provider_native_id TEXT, canonical_locator JSONB NOT NULL,
 source_family_id TEXT NOT NULL, source_entity_id UUID,
 language TEXT, script TEXT, content_type TEXT, published_at TIMESTAMPTZ,
 observed_at TIMESTAMPTZ NOT NULL, normalized_text TEXT NOT NULL, text_checksum TEXT NOT NULL,
 raw_payload_checksum TEXT NOT NULL, provenance JSONB NOT NULL, schema_version TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK(jsonb_typeof(canonical_locator)='object'), CHECK(jsonb_typeof(provenance)='object')
);
CREATE INDEX IF NOT EXISTS idx_evidence_documents_subject_time ON evidence_documents(subject_entity_id,observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_documents_channel_time ON evidence_documents(channel_id,observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_documents_family ON evidence_documents(source_family_id,document_type,observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_documents_published ON evidence_documents(channel_id,published_at DESC) WHERE published_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS classification_evidence_assertions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), assertion_key TEXT NOT NULL UNIQUE,
 subject_entity_id UUID NOT NULL, channel_id TEXT NOT NULL, assertion_type TEXT NOT NULL,
 hypothesis TEXT NOT NULL, polarity TEXT NOT NULL CHECK(polarity IN('POSITIVE','NEGATIVE','ABSTAIN')),
 confidence_basis_points INTEGER NOT NULL CHECK(confidence_basis_points BETWEEN 0 AND 10000),
 reliability TEXT NOT NULL CHECK(reliability IN('VERY_HIGH','HIGH','MEDIUM','LOWER')),
 document_ids JSONB NOT NULL, source_family_ids JSONB NOT NULL,
 model_or_rule_version TEXT NOT NULL, provider TEXT NOT NULL, language_capability JSONB NOT NULL,
 reason_codes JSONB NOT NULL, derivation JSONB NOT NULL, observed_at TIMESTAMPTZ NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK(jsonb_typeof(document_ids)='array'), CHECK(jsonb_array_length(document_ids)>0),
 CHECK(jsonb_typeof(source_family_ids)='array'), CHECK(jsonb_array_length(source_family_ids)>0),
 CHECK(jsonb_typeof(language_capability)='object'), CHECK(jsonb_typeof(reason_codes)='array'),
 CHECK(jsonb_typeof(derivation)='object')
);
CREATE INDEX IF NOT EXISTS idx_classification_assertions_subject ON classification_evidence_assertions(subject_entity_id,observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_classification_assertions_channel ON classification_evidence_assertions(channel_id,observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_classification_assertions_hypothesis ON classification_evidence_assertions(hypothesis,polarity,observed_at DESC);

DO $$ DECLARE t TEXT; BEGIN FOREACH t IN ARRAY ARRAY['evidence_documents','classification_evidence_assertions'] LOOP
 EXECUTE format('CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation()',t,t);
END LOOP; END $$;

INSERT INTO app_settings(setting_key,setting_value) VALUES
 ('evidence_document_dual_write_enabled','false'),('evidence_assertion_dual_write_enabled','false')
ON CONFLICT(setting_key) DO NOTHING;
COMMENT ON TABLE evidence_documents IS 'Immutable observed documents; search-match context is distinct from authoritative channel About metadata.';
COMMENT ON TABLE classification_evidence_assertions IS 'Immutable document-attributed classifier assertions. No Release 2 serving authority.';
