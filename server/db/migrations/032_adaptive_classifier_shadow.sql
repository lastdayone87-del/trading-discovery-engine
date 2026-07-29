-- Governed next-generation classifier observations. Append-only and never read by production decisions.
CREATE TABLE IF NOT EXISTS adaptive_classifier_shadow_runs (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), channel_id TEXT NOT NULL,
 production_status TEXT NOT NULL, production_confidence INTEGER NOT NULL,
 shadow_status TEXT NOT NULL, shadow_confidence INTEGER NOT NULL, agreement BOOLEAN NOT NULL,
 production_evidence JSONB NOT NULL, shadow_evidence JSONB NOT NULL, evidence_difference JSONB NOT NULL,
 review_rate_delta INTEGER NOT NULL, classifier_version TEXT NOT NULL, policy_version TEXT NOT NULL,
 feature_snapshot_checksum TEXT NOT NULL, catalog_versions JSONB NOT NULL, reason_codes JSONB NOT NULL,
 classified_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_adaptive_shadow_metrics ON adaptive_classifier_shadow_runs(classified_at,production_status,shadow_status);
CREATE TRIGGER adaptive_classifier_shadow_runs_immutable BEFORE UPDATE OR DELETE ON adaptive_classifier_shadow_runs FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation();
COMMENT ON TABLE adaptive_classifier_shadow_runs IS 'Append-only shadow comparisons; production classification never reads this table.';
CREATE TABLE IF NOT EXISTS adaptive_classifier_shadow_labels (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), shadow_run_id UUID NOT NULL REFERENCES adaptive_classifier_shadow_runs(id) ON DELETE RESTRICT,
 review_decision_id UUID NOT NULL REFERENCES channel_review_decisions(id) ON DELETE RESTRICT,
 ground_truth_status TEXT NOT NULL CHECK(ground_truth_status IN ('TRADING_CONFIRMED','NON_TRADING')),
 labeled_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(shadow_run_id,review_decision_id)
);
CREATE TRIGGER adaptive_classifier_shadow_labels_immutable BEFORE UPDATE OR DELETE ON adaptive_classifier_shadow_labels FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation();
