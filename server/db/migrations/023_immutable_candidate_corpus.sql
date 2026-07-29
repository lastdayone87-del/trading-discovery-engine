-- Phase 8: shadow-only, immutable corpus and source-bound deterministic candidates.
-- Unicode offsets are Unicode scalar-value (code point) indexes, not UTF-16 bytes.
CREATE TABLE IF NOT EXISTS corpus_source_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), source_type TEXT NOT NULL,
  source_key TEXT NOT NULL, creator_channel_id TEXT REFERENCES channels(channel_id) ON DELETE RESTRICT,
  discovery_lineage TEXT NOT NULL CHECK (discovery_lineage IN ('AUTONOMOUS','HUMAN_APPROVED','MANUAL_UNAPPROVED','LEGACY')),
  entity_cluster_key TEXT NOT NULL, source_uri_hash TEXT, observed_at TIMESTAMPTZ NOT NULL,
  policy_version TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(source_type,source_key,observed_at)
);
CREATE TABLE IF NOT EXISTS corpus_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), artifact_id UUID NOT NULL REFERENCES corpus_source_artifacts(id) ON DELETE RESTRICT,
  document_kind TEXT NOT NULL, language TEXT NOT NULL DEFAULT 'und', content_hash TEXT NOT NULL,
  retained_excerpt TEXT, retention_class TEXT NOT NULL CHECK (retention_class IN ('HASH_ONLY','MINIMAL_EXCERPT','APPROVED_TEXT')),
  offset_scheme TEXT NOT NULL DEFAULT 'UNICODE_CODE_POINT_V1' CHECK (offset_scheme IN ('UNICODE_CODE_POINT_V1','LEGACY_UNAVAILABLE')),
  extractor_eligible BOOLEAN NOT NULL DEFAULT false, retention_expires_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ,
  deletion_reason TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(content_hash,document_kind)
);
CREATE TABLE IF NOT EXISTS corpus_extraction_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), document_id UUID NOT NULL REFERENCES corpus_documents(id) ON DELETE RESTRICT,
  extractor_version TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('COMPLETED','REJECTED')),
  token_count INTEGER NOT NULL DEFAULT 0 CHECK(token_count>=0), candidate_count INTEGER NOT NULL DEFAULT 0 CHECK(candidate_count>=0),
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(document_id,extractor_version)
);
CREATE TABLE IF NOT EXISTS corpus_candidate_occurrences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), extraction_run_id UUID NOT NULL REFERENCES corpus_extraction_runs(id) ON DELETE RESTRICT,
  document_id UUID NOT NULL REFERENCES corpus_documents(id) ON DELETE RESTRICT, literal_span TEXT NOT NULL,
  normalized_span TEXT NOT NULL, start_offset INTEGER NOT NULL CHECK(start_offset>=0), end_offset INTEGER NOT NULL CHECK(end_offset>start_offset),
  ngram_size INTEGER NOT NULL CHECK(ngram_size BETWEEN 1 AND 5), occurrence_key TEXT NOT NULL UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS corpus_qualification_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), document_id UUID NOT NULL REFERENCES corpus_documents(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK(decision IN ('QUALIFIED','REJECTED','CAPPED','DELETED')),
  reason_codes JSONB NOT NULL CHECK(jsonb_typeof(reason_codes)='array'), policy_version TEXT NOT NULL,
  entity_cluster_key TEXT NOT NULL, window_start TIMESTAMPTZ NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS corpus_controls (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton), paused BOOLEAN NOT NULL DEFAULT true,
  max_concurrency INTEGER NOT NULL DEFAULT 1 CHECK(max_concurrency BETWEEN 0 AND 8), daily_compute_documents INTEGER NOT NULL DEFAULT 0 CHECK(daily_compute_documents>=0),
  cluster_window_cap INTEGER NOT NULL DEFAULT 5 CHECK(cluster_window_cap>0), policy_version TEXT NOT NULL DEFAULT 'corpus-policy-v1', updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO corpus_controls(singleton) VALUES(true) ON CONFLICT DO NOTHING;
INSERT INTO queue_controls(queue_name,is_paused) VALUES('term_harvest',true) ON CONFLICT(queue_name) DO NOTHING;
CREATE INDEX IF NOT EXISTS idx_corpus_documents_artifact ON corpus_documents(artifact_id,created_at);
CREATE INDEX IF NOT EXISTS idx_corpus_occurrences_document ON corpus_candidate_occurrences(document_id,start_offset);
CREATE INDEX IF NOT EXISTS idx_corpus_qualification_cluster ON corpus_qualification_decisions(entity_cluster_key,window_start);
DROP TRIGGER IF EXISTS corpus_artifacts_immutable ON corpus_source_artifacts;
CREATE TRIGGER corpus_artifacts_immutable BEFORE UPDATE OR DELETE ON corpus_source_artifacts FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation();
DROP TRIGGER IF EXISTS corpus_extraction_runs_immutable ON corpus_extraction_runs;
CREATE TRIGGER corpus_extraction_runs_immutable BEFORE UPDATE OR DELETE ON corpus_extraction_runs FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation();
DROP TRIGGER IF EXISTS corpus_occurrences_immutable ON corpus_candidate_occurrences;
CREATE TRIGGER corpus_occurrences_immutable BEFORE UPDATE OR DELETE ON corpus_candidate_occurrences FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation();
DROP TRIGGER IF EXISTS corpus_qualification_immutable ON corpus_qualification_decisions;
CREATE TRIGGER corpus_qualification_immutable BEFORE UPDATE OR DELETE ON corpus_qualification_decisions FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation();
COMMENT ON TABLE corpus_documents IS 'Minimal retained source material; deletion is a tombstone and policy erasure of retained_excerpt, never evidence-row deletion.';
COMMENT ON TABLE corpus_candidate_occurrences IS 'Shadow-only exact source spans. No row grants Phase F or search eligibility.';
