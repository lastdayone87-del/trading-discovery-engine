-- Release 2 / Phase 3: immutable, replayable evidence coverage per evaluation.
CREATE TABLE IF NOT EXISTS evidence_coverage_snapshots (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), snapshot_key TEXT NOT NULL UNIQUE,
 channel_id TEXT NOT NULL, subject_entity_id UUID NOT NULL,
 classification_diagnostic_id UUID REFERENCES production_classification_diagnostics(id) ON DELETE RESTRICT,
 requested_sampling_strategy JSONB NOT NULL, observed_document_counts JSONB NOT NULL,
 temporal_coverage JSONB NOT NULL, language_coverage JSONB NOT NULL,
 independent_family_count INTEGER NOT NULL CHECK(independent_family_count>=0),
 provider_availability JSONB NOT NULL, acquisition_failures JSONB NOT NULL,
 oldest_document_at TIMESTAMPTZ, latest_document_at TIMESTAMPTZ,
 expected_document_count INTEGER NOT NULL CHECK(expected_document_count>=0),
 observed_document_count INTEGER NOT NULL CHECK(observed_document_count>=0),
 completeness_disposition TEXT NOT NULL CHECK(completeness_disposition IN('MISSING','INSUFFICIENT','SUFFICIENT')),
 reason_codes JSONB NOT NULL, input_checksum TEXT NOT NULL, policy_version TEXT NOT NULL,
 schema_version TEXT NOT NULL, observed_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK(jsonb_typeof(requested_sampling_strategy)='object'), CHECK(jsonb_typeof(observed_document_counts)='object'),
 CHECK(jsonb_typeof(temporal_coverage)='object'), CHECK(jsonb_typeof(language_coverage)='object'),
 CHECK(jsonb_typeof(provider_availability)='array'), CHECK(jsonb_typeof(acquisition_failures)='array'),
 CHECK(jsonb_typeof(reason_codes)='array'), CHECK(oldest_document_at IS NULL OR latest_document_at IS NULL OR oldest_document_at<=latest_document_at)
);
CREATE INDEX IF NOT EXISTS idx_evidence_coverage_channel ON evidence_coverage_snapshots(channel_id,observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_coverage_disposition ON evidence_coverage_snapshots(completeness_disposition,observed_at DESC);
CREATE TRIGGER evidence_coverage_snapshots_immutable BEFORE UPDATE OR DELETE ON evidence_coverage_snapshots
 FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation();
COMMENT ON TABLE evidence_coverage_snapshots IS 'Pinned coverage envelope for replay; production decisions do not read this table in Release 2.';
