-- Decision-grade evaluation and calibration control plane.
-- Serving observations remain immutable; datasets and promotion decisions pin
-- their exact inputs so later reviews never rewrite historical conclusions.

CREATE TABLE IF NOT EXISTS evaluation_sampling_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_key TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','APPROVED','RETIRED')),
  definition JSONB NOT NULL,
  definition_checksum TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(policy_key,version), UNIQUE(definition_checksum)
);

CREATE TABLE IF NOT EXISTS evaluation_cohort_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_key TEXT NOT NULL UNIQUE,
  channel_id TEXT NOT NULL,
  policy_key TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  cohort TEXT NOT NULL CHECK (cohort IN ('PROTECTED_AUDIT','TARGETED_AUDIT','NOT_SELECTED')),
  inclusion_basis_points INTEGER NOT NULL CHECK (inclusion_basis_points BETWEEN 0 AND 10000),
  randomization_value INTEGER NOT NULL CHECK (randomization_value BETWEEN 0 AND 9999),
  stratum JSONB NOT NULL,
  discovery_context JSONB NOT NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_evaluation_assignments_cohort_time ON evaluation_cohort_assignments(cohort,assigned_at DESC);
CREATE INDEX IF NOT EXISTS idx_evaluation_assignments_channel ON evaluation_cohort_assignments(channel_id,assigned_at DESC);

CREATE TABLE IF NOT EXISTS evaluation_ground_truth_labels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label_key TEXT NOT NULL UNIQUE,
  channel_id TEXT NOT NULL,
  review_decision_id UUID REFERENCES channel_review_decisions(id) ON DELETE RESTRICT,
  label TEXT NOT NULL CHECK (label IN ('TRADING_CONFIRMED','NON_TRADING','DISPUTED')),
  provenance TEXT NOT NULL CHECK (provenance IN ('HUMAN_REVIEW','DELAYED_PRODUCTION','ADJUDICATION')),
  reviewer_count INTEGER NOT NULL DEFAULT 1 CHECK (reviewer_count > 0),
  disagreement BOOLEAN NOT NULL DEFAULT false,
  label_policy_version TEXT NOT NULL,
  evidence_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  labeled_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_evaluation_labels_channel ON evaluation_ground_truth_labels(channel_id,labeled_at DESC);

CREATE TABLE IF NOT EXISTS decision_evaluation_datasets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_key TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'SEALED' CHECK (status IN ('SEALED','RETIRED')),
  cutoff_at TIMESTAMPTZ NOT NULL,
  definition JSONB NOT NULL,
  checksum TEXT NOT NULL UNIQUE,
  example_count INTEGER NOT NULL CHECK (example_count >= 0),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS decision_evaluation_examples (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id UUID NOT NULL REFERENCES decision_evaluation_datasets(id) ON DELETE RESTRICT,
  example_key TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  decision_diagnostic_id UUID NOT NULL REFERENCES production_classification_diagnostics(id) ON DELETE RESTRICT,
  assignment_id UUID REFERENCES evaluation_cohort_assignments(id) ON DELETE RESTRICT,
  label_id UUID NOT NULL REFERENCES evaluation_ground_truth_labels(id) ON DELETE RESTRICT,
  split TEXT NOT NULL CHECK (split IN ('TRAIN','CALIBRATION','TEST')),
  segment JSONB NOT NULL,
  production_status TEXT NOT NULL,
  production_score DOUBLE PRECISION NOT NULL,
  ground_truth_label TEXT NOT NULL,
  inclusion_probability DOUBLE PRECISION NOT NULL CHECK (inclusion_probability > 0 AND inclusion_probability <= 1),
  observed_at TIMESTAMPTZ NOT NULL,
  UNIQUE(dataset_id,example_key)
);
CREATE INDEX IF NOT EXISTS idx_evaluation_examples_dataset_split ON decision_evaluation_examples(dataset_id,split);

CREATE TABLE IF NOT EXISTS decision_benchmark_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_key TEXT NOT NULL UNIQUE,
  dataset_id UUID NOT NULL REFERENCES decision_evaluation_datasets(id) ON DELETE RESTRICT,
  candidate_key TEXT NOT NULL,
  candidate_version TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  metrics JSONB NOT NULL,
  segments JSONB NOT NULL,
  calibration JSONB NOT NULL,
  guardrail_reasons JSONB NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('PASS','FAIL','INSUFFICIENT_EVIDENCE')),
  checksum TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS calibration_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_key TEXT NOT NULL UNIQUE,
  benchmark_run_id UUID NOT NULL REFERENCES decision_benchmark_runs(id) ON DELETE RESTRICT,
  method TEXT NOT NULL CHECK (method IN ('IDENTITY','BINNED_ISOTONIC')),
  parameters JSONB NOT NULL,
  segment_scope JSONB NOT NULL,
  checksum TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'SHADOW' CHECK (status IN ('SHADOW','APPROVED','RETIRED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS decision_promotion_gates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gate_key TEXT NOT NULL UNIQUE,
  baseline_run_id UUID NOT NULL REFERENCES decision_benchmark_runs(id) ON DELETE RESTRICT,
  candidate_run_id UUID NOT NULL REFERENCES decision_benchmark_runs(id) ON DELETE RESTRICT,
  policy JSONB NOT NULL,
  comparison JSONB NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('PROMOTE','REJECT','INSUFFICIENT_EVIDENCE')),
  reason_codes JSONB NOT NULL,
  decided_by TEXT NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY[
    'evaluation_sampling_policies','evaluation_cohort_assignments','evaluation_ground_truth_labels',
    'decision_evaluation_datasets','decision_evaluation_examples','decision_benchmark_runs',
    'calibration_artifacts','decision_promotion_gates'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_immutable ON %I',t,t);
    EXECUTE format('CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation()',t,t);
  END LOOP;
END $$;

COMMENT ON TABLE evaluation_cohort_assignments IS 'Immutable retrieval-boundary sampling assignments with known inclusion propensity.';
COMMENT ON TABLE decision_evaluation_datasets IS 'Sealed, checksummed evaluation population; production serving never reads this table.';
COMMENT ON TABLE decision_promotion_gates IS 'Evidence-based comparison records. A PROMOTE result is necessary but does not itself activate production.';

INSERT INTO evaluation_sampling_policies(policy_key,version,status,definition,definition_checksum,created_by)
VALUES('protected-audit',1,'APPROVED','{"protectedAuditBasisPoints":100,"targetedAuditBasisPoints":0,"strata":{}}','8c10a2059ee32baed03128e72d51a90eb125baf8159c425f8632c913cc99aabf','migration-037')
ON CONFLICT DO NOTHING;
INSERT INTO app_settings(setting_key,setting_value) VALUES('decision_evaluation_sampling_enabled','false') ON CONFLICT(setting_key) DO NOTHING;
