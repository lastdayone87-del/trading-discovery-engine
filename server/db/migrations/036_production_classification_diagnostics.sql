CREATE TABLE IF NOT EXISTS production_classification_diagnostics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id TEXT NOT NULL,
  job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
  query_run_id UUID REFERENCES query_runs(id) ON DELETE SET NULL,
  enrichment_stage SMALLINT NOT NULL DEFAULT 0 CHECK(enrichment_stage BETWEEN 0 AND 3),
  normalized_input JSONB NOT NULL,
  provider_execution JSONB NOT NULL,
  evidence_items JSONB NOT NULL,
  staged_report JSONB NOT NULL,
  decision JSONB NOT NULL,
  policy_versions JSONB NOT NULL,
  catalog_versions JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK(jsonb_typeof(normalized_input)='object'),
  CHECK(jsonb_typeof(provider_execution)='array'),
  CHECK(jsonb_typeof(evidence_items)='array'),
  CHECK(jsonb_typeof(staged_report)='object'),
  CHECK(jsonb_typeof(decision)='object'),
  CHECK(jsonb_typeof(policy_versions)='object'),
  CHECK(jsonb_typeof(catalog_versions)='array')
);
CREATE INDEX IF NOT EXISTS idx_classification_diagnostics_channel ON production_classification_diagnostics(channel_id,created_at DESC);
CREATE TRIGGER production_classification_diagnostics_immutable BEFORE UPDATE OR DELETE ON production_classification_diagnostics
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation();

INSERT INTO app_settings(setting_key,setting_value) VALUES('governed_classifier_production_enabled','false')
ON CONFLICT(setting_key) DO NOTHING;
