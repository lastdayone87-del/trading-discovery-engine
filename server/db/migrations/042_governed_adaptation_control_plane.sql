-- Final roadmap completion: governed corrective learning, active review, drift,
-- experiments, operational attribution, and segmented provider calibration.
CREATE TABLE IF NOT EXISTS corrective_learning_incidents (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), incident_key TEXT NOT NULL UNIQUE,
 channel_id TEXT NOT NULL, review_decision_id UUID REFERENCES channel_review_decisions(id) ON DELETE RESTRICT,
 prior_diagnostic_id UUID REFERENCES production_classification_diagnostics(id) ON DELETE RESTRICT,
 prior_status TEXT NOT NULL, confirmed_status TEXT NOT NULL,
 causal_class TEXT NOT NULL CHECK(causal_class IN('RETRIEVAL_MISS','PROVIDER_FAILURE','EVIDENCE_GAP','SEMANTIC_GAP','CORROBORATION_GAP','CALIBRATION_GAP','POLICY_GAP','UNDETERMINED')),
 diagnosis JSONB NOT NULL, evidence_checksum TEXT NOT NULL, policy_version TEXT NOT NULL,
 observed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS corrective_learning_proposals (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), proposal_key TEXT NOT NULL UNIQUE,
 incident_id UUID NOT NULL REFERENCES corrective_learning_incidents(id) ON DELETE RESTRICT,
 proposal_type TEXT NOT NULL CHECK(proposal_type IN('QUERY_CONTRIBUTION','KNOWLEDGE_CONTRIBUTION','PROVIDER_POLICY','EVIDENCE_POLICY','CALIBRATION_REVIEW','NO_ACTION')),
 payload JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'PROPOSED' CHECK(status IN('PROPOSED','APPROVED','REJECTED','SUPERSEDED')),
 policy_version TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS governed_review_allocations (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), allocation_key TEXT NOT NULL UNIQUE,
 channel_id TEXT NOT NULL, lane TEXT NOT NULL CHECK(lane IN('PROTECTED_AUDIT','OPERATIONAL_ADJUDICATION','ACTIVE_LEARNING')),
 inclusion_basis_points INTEGER NOT NULL CHECK(inclusion_basis_points BETWEEN 1 AND 10000),
 utility JSONB NOT NULL, reason_codes JSONB NOT NULL, policy_version TEXT NOT NULL,
 allocated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS adaptation_experiments (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), experiment_key TEXT NOT NULL, version INTEGER NOT NULL,
 action_family TEXT NOT NULL, baseline_policy TEXT NOT NULL, candidate_policy TEXT NOT NULL,
 allocation_basis_points INTEGER NOT NULL CHECK(allocation_basis_points BETWEEN 1 AND 5000),
 utility_contract_version TEXT NOT NULL, guardrails JSONB NOT NULL,
 status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN('DRAFT','APPROVED','CANARY','STOPPED','PROMOTED','REJECTED')),
 created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(experiment_key,version)
);
CREATE TABLE IF NOT EXISTS adaptation_experiment_events (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), event_key TEXT NOT NULL UNIQUE,
 experiment_id UUID NOT NULL REFERENCES adaptation_experiments(id) ON DELETE RESTRICT,
 event_type TEXT NOT NULL CHECK(event_type IN('ASSIGNED','OUTCOME','GUARDRAIL_STOP','PROMOTION_PROPOSED','PROMOTED','REJECTED','ROLLED_BACK')),
 subject_key TEXT, propensity_basis_points INTEGER CHECK(propensity_basis_points BETWEEN 1 AND 10000),
 payload JSONB NOT NULL, occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS operational_change_diagnoses (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), diagnosis_key TEXT NOT NULL UNIQUE,
 baseline_run_id UUID REFERENCES decision_benchmark_runs(id) ON DELETE RESTRICT,
 candidate_run_id UUID REFERENCES decision_benchmark_runs(id) ON DELETE RESTRICT,
 change_manifest JSONB NOT NULL, attribution JSONB NOT NULL, confidence_basis_points INTEGER NOT NULL CHECK(confidence_basis_points BETWEEN 0 AND 10000),
 counterevidence JSONB NOT NULL, recommended_actions JSONB NOT NULL, policy_version TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS governed_drift_alerts (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), alert_key TEXT NOT NULL UNIQUE,
 drift_type TEXT NOT NULL CHECK(drift_type IN('ACQUISITION','SEMANTIC','CALIBRATION','PROVIDER','POPULATION','SELECTION')),
 segment JSONB NOT NULL, baseline JSONB NOT NULL, current JSONB NOT NULL,
 effect_size DOUBLE PRECISION NOT NULL, sample_size INTEGER NOT NULL CHECK(sample_size>=0),
 disposition TEXT NOT NULL CHECK(disposition IN('INSUFFICIENT_EVIDENCE','OBSERVE','REACTIVATION_PROPOSED','AUDIT_PROPOSED','SHADOW_RECALIBRATION_PROPOSED','ALLOCATION_REDUCTION_PROPOSED')),
 policy_version TEXT NOT NULL, observed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS segmented_provider_calibrations (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), calibration_key TEXT NOT NULL UNIQUE,
 provider TEXT NOT NULL, segment JSONB NOT NULL, dataset_id UUID NOT NULL REFERENCES decision_evaluation_datasets(id) ON DELETE RESTRICT,
 reliability_basis_points INTEGER NOT NULL CHECK(reliability_basis_points BETWEEN 0 AND 10000),
 lower_basis_points INTEGER NOT NULL CHECK(lower_basis_points BETWEEN 0 AND 10000), upper_basis_points INTEGER NOT NULL CHECK(upper_basis_points BETWEEN 0 AND 10000),
 status TEXT NOT NULL DEFAULT 'SHADOW' CHECK(status IN('SHADOW','APPROVED','RETIRED')),
 policy_version TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), CHECK(lower_basis_points<=reliability_basis_points AND reliability_basis_points<=upper_basis_points)
);
CREATE TABLE IF NOT EXISTS adaptation_controls (
 singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton), corrective_learning_enabled BOOLEAN NOT NULL DEFAULT false,
 active_review_enabled BOOLEAN NOT NULL DEFAULT false, experiments_enabled BOOLEAN NOT NULL DEFAULT false,
 drift_detection_enabled BOOLEAN NOT NULL DEFAULT false, automatic_publication BOOLEAN NOT NULL DEFAULT false,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO adaptation_controls(singleton) VALUES(true) ON CONFLICT DO NOTHING;
INSERT INTO app_settings(setting_key,setting_value) VALUES('corrective_learning_enabled','false') ON CONFLICT(setting_key) DO NOTHING;
DO $$ DECLARE t TEXT; BEGIN FOREACH t IN ARRAY ARRAY['corrective_learning_incidents','corrective_learning_proposals','governed_review_allocations','adaptation_experiment_events','operational_change_diagnoses','governed_drift_alerts','segmented_provider_calibrations'] LOOP EXECUTE format('CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation()',t,t); END LOOP; END $$;
COMMENT ON TABLE corrective_learning_proposals IS 'Proposal-only remediation; incidents never publish knowledge or change serving policy.';
COMMENT ON TABLE operational_change_diagnoses IS 'Derived causal hypotheses with confidence and counterevidence, never autonomous operator actions.';
