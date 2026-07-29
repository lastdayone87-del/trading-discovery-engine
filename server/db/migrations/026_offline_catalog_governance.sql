-- Phase 11: offline-only candidate evaluation and catalog governance.
CREATE TABLE IF NOT EXISTS evaluation_policy_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), policy_key TEXT NOT NULL UNIQUE, version TEXT NOT NULL,
  definition JSONB NOT NULL CHECK(jsonb_typeof(definition)='object'), definition_checksum TEXT NOT NULL,
  code_version TEXT NOT NULL, created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(version,definition_checksum)
);
CREATE TABLE IF NOT EXISTS candidate_evaluation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), run_key TEXT NOT NULL UNIQUE,
  policy_id UUID NOT NULL REFERENCES evaluation_policy_versions(id), dataset_version TEXT NOT NULL,
  dataset_checksum TEXT NOT NULL, code_version TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK(status IN ('PENDING','COMPLETED','FAILED','SUPERSEDED')),
  non_comparable BOOLEAN NOT NULL DEFAULT false, non_comparable_reason TEXT,
  held_out BOOLEAN NOT NULL DEFAULT true, time_split_at TIMESTAMPTZ, created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), completed_at TIMESTAMPTZ,
  CHECK(non_comparable OR non_comparable_reason IS NULL)
);
CREATE TABLE IF NOT EXISTS offline_cached_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), dataset_version TEXT NOT NULL, dataset_checksum TEXT NOT NULL,
  observation_key TEXT NOT NULL UNIQUE, candidate_key TEXT NOT NULL, country TEXT NOT NULL, lane TEXT NOT NULL,
  verified INTEGER NOT NULL CHECK(verified>=0), relevant INTEGER NOT NULL CHECK(relevant>=0), results INTEGER NOT NULL CHECK(results>=0),
  coverage_keys JSONB NOT NULL CHECK(jsonb_typeof(coverage_keys)='array'), quota_cost INTEGER NOT NULL CHECK(quota_cost>=0),
  review_cost INTEGER NOT NULL CHECK(review_cost>=0), observed_at TIMESTAMPTZ NOT NULL,
  retention_permitted BOOLEAN NOT NULL DEFAULT false, retention_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), CHECK(verified<=relevant AND relevant<=results)
);
CREATE TABLE IF NOT EXISTS candidate_evaluation_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), run_id UUID NOT NULL REFERENCES candidate_evaluation_runs(id),
  candidate_key TEXT NOT NULL, concept_id UUID REFERENCES concepts(id), surface_id UUID REFERENCES term_surfaces(id),
  country TEXT NOT NULL, lane TEXT NOT NULL, metrics JSONB NOT NULL CHECK(jsonb_typeof(metrics)='object'),
  uncertainty JSONB NOT NULL CHECK(jsonb_typeof(uncertainty)='object'), guardrail_reasons JSONB NOT NULL CHECK(jsonb_typeof(guardrail_reasons)='array'),
  decision TEXT NOT NULL CHECK(decision IN ('ACCEPT','REJECT','INSUFFICIENT_EVIDENCE')),
  result_checksum TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(run_id,candidate_key,country,lane)
);
CREATE TABLE IF NOT EXISTS candidate_catalogs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), catalog_key TEXT NOT NULL UNIQUE, evaluation_run_id UUID NOT NULL REFERENCES candidate_evaluation_runs(id),
  policy_id UUID NOT NULL REFERENCES evaluation_policy_versions(id), version INTEGER NOT NULL CHECK(version>0),
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','REVIEWED','REJECTED','SUPERSEDED')),
  checksum TEXT NOT NULL, created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(version,checksum)
);
CREATE TABLE IF NOT EXISTS candidate_catalog_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), catalog_id UUID NOT NULL REFERENCES candidate_catalogs(id),
  evaluation_result_id UUID NOT NULL REFERENCES candidate_evaluation_results(id), ordinal INTEGER NOT NULL CHECK(ordinal>=0),
  candidate_key TEXT NOT NULL, country TEXT NOT NULL, lane TEXT NOT NULL, decision_explanation JSONB NOT NULL,
  entry_checksum TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(catalog_id,candidate_key,country,lane), UNIQUE(catalog_id,ordinal)
);
CREATE TABLE IF NOT EXISTS catalog_publication_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), catalog_id UUID NOT NULL REFERENCES candidate_catalogs(id),
  idempotency_key TEXT NOT NULL UNIQUE, decision TEXT NOT NULL CHECK(decision IN ('APPROVE_SHADOW','REJECT')),
  expected_status TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS catalog_shadow_selections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), selection_key TEXT NOT NULL UNIQUE, catalog_id UUID NOT NULL REFERENCES candidate_catalogs(id),
  country TEXT NOT NULL, lane TEXT NOT NULL, candidate_key TEXT, production_query_id UUID,
  would_select BOOLEAN NOT NULL, explanation JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS offline_evaluation_controls (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton), evaluation_paused BOOLEAN NOT NULL DEFAULT true,
  shadow_loading_enabled BOOLEAN NOT NULL DEFAULT false, publication_enabled BOOLEAN NOT NULL DEFAULT false,
  provider_access_allowed BOOLEAN NOT NULL DEFAULT false, max_concurrency INTEGER NOT NULL DEFAULT 1 CHECK(max_concurrency BETWEEN 0 AND 4),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), CHECK(publication_enabled=false), CHECK(provider_access_allowed=false)
);
INSERT INTO offline_evaluation_controls(singleton) VALUES(true) ON CONFLICT DO NOTHING;
INSERT INTO queue_controls(queue_name,is_paused) VALUES('offline_candidate_evaluation',true) ON CONFLICT(queue_name) DO NOTHING;
CREATE INDEX IF NOT EXISTS idx_evaluation_results_run ON candidate_evaluation_results(run_id,decision,country,lane);
CREATE INDEX IF NOT EXISTS idx_catalog_entries_catalog ON candidate_catalog_entries(catalog_id,ordinal);
DO $$ DECLARE t TEXT; BEGIN FOREACH t IN ARRAY ARRAY['evaluation_policy_versions','offline_cached_observations','candidate_evaluation_results','candidate_catalog_entries','catalog_publication_approvals','catalog_shadow_selections'] LOOP
 EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation()',t||'_immutable',t);
END LOOP; END $$;
COMMENT ON TABLE candidate_catalogs IS 'Phase 11 shadow catalogs. Publication into production is structurally disabled until a later approved phase.';
COMMENT ON TABLE candidate_evaluation_results IS 'Missing cached counterfactual evidence is INSUFFICIENT_EVIDENCE, never a negative outcome.';
