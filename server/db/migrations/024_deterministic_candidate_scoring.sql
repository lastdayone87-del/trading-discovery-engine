-- Phase 9: shadow-only deterministic scoring and bounded semantic assertions.
CREATE TABLE IF NOT EXISTS candidate_feature_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), candidate_key TEXT NOT NULL,
  normalized_span TEXT NOT NULL, feature_set_version TEXT NOT NULL,
  features JSONB NOT NULL CHECK(jsonb_typeof(features)='object'), decision TEXT NOT NULL
    CHECK(decision IN ('REJECTED','ACCEPTED','AMBIGUOUS')),
  reason_codes JSONB NOT NULL CHECK(jsonb_typeof(reason_codes)='array'),
  evidence_checksum TEXT NOT NULL, computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(candidate_key,feature_set_version,evidence_checksum)
);
CREATE TABLE IF NOT EXISTS classification_assertions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), candidate_key TEXT NOT NULL,
  feature_snapshot_id UUID NOT NULL REFERENCES candidate_feature_snapshots(id) ON DELETE RESTRICT,
  assertion_source TEXT NOT NULL CHECK(assertion_source IN ('DETERMINISTIC','AI','HUMAN')),
  label TEXT NOT NULL CHECK(label IN ('TRADING','NON_TRADING','AMBIGUOUS','SPAM','BRAND','PERSON','GENERIC','OTHER')),
  confidence NUMERIC(5,4) NOT NULL CHECK(confidence BETWEEN 0 AND 1), abstained BOOLEAN NOT NULL,
  reason_codes JSONB NOT NULL CHECK(jsonb_typeof(reason_codes)='array'),
  context_start_offset INTEGER, context_end_offset INTEGER, literal_span TEXT NOT NULL,
  classifier_version TEXT NOT NULL, model_version TEXT, prompt_version TEXT, schema_version TEXT NOT NULL,
  raw_response_hash TEXT, assertion_key TEXT NOT NULL UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK((context_start_offset IS NULL AND context_end_offset IS NULL) OR
        (context_start_offset >= 0 AND context_end_offset > context_start_offset))
);
CREATE TABLE IF NOT EXISTS candidate_adjudication_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), candidate_key TEXT NOT NULL,
  feature_snapshot_id UUID NOT NULL REFERENCES candidate_feature_snapshots(id) ON DELETE RESTRICT,
  classifier_version TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('COMPLETED','ABSTAINED','FAILED_CLOSED')),
  error_code TEXT, input_tokens INTEGER NOT NULL DEFAULT 0 CHECK(input_tokens>=0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK(output_tokens>=0), cost_microunits BIGINT NOT NULL DEFAULT 0 CHECK(cost_microunits>=0),
  result_key TEXT NOT NULL UNIQUE, completed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS candidate_anomaly_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), candidate_key TEXT NOT NULL, feature_snapshot_id UUID NOT NULL REFERENCES candidate_feature_snapshots(id) ON DELETE RESTRICT,
  flag TEXT NOT NULL CHECK(flag IN ('TEMPORAL_BURST','CORRELATED_SOURCES','PROMPT_INJECTION','LANGUAGE_MISMATCH')),
  severity NUMERIC(5,4) NOT NULL CHECK(severity BETWEEN 0 AND 1), evidence JSONB NOT NULL,
  flag_key TEXT NOT NULL UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS candidate_scoring_controls (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton), scoring_paused BOOLEAN NOT NULL DEFAULT true,
  ai_paused BOOLEAN NOT NULL DEFAULT true, daily_scoring_candidates INTEGER NOT NULL DEFAULT 0 CHECK(daily_scoring_candidates>=0),
  daily_ai_assertions INTEGER NOT NULL DEFAULT 0 CHECK(daily_ai_assertions>=0), max_ai_cost_microunits BIGINT NOT NULL DEFAULT 0 CHECK(max_ai_cost_microunits>=0),
  feature_set_version TEXT NOT NULL DEFAULT 'candidate-features-v1', classifier_version TEXT NOT NULL DEFAULT 'bounded-semantic-v1', updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO candidate_scoring_controls(singleton) VALUES(true) ON CONFLICT DO NOTHING;
INSERT INTO queue_controls(queue_name,is_paused) VALUES('candidate_scoring',true),('candidate_ai_adjudication',true) ON CONFLICT(queue_name) DO NOTHING;
CREATE INDEX IF NOT EXISTS idx_candidate_features_key ON candidate_feature_snapshots(candidate_key,computed_at);
CREATE INDEX IF NOT EXISTS idx_classification_assertions_candidate ON classification_assertions(candidate_key,created_at);
DO $$ DECLARE t TEXT; BEGIN FOREACH t IN ARRAY ARRAY['candidate_feature_snapshots','classification_assertions','candidate_adjudication_results','candidate_anomaly_flags'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I',t||'_immutable',t);
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation()',t||'_immutable',t);
END LOOP; END $$;
COMMENT ON TABLE classification_assertions IS 'Parallel immutable Phase 9 claims; never grants search eligibility or overwrites Phase F.';
