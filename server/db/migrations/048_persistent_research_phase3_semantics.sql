-- Phase 3: governed multi-source corpus, semantic trials, burst reactivation and publication handoff.
CREATE TABLE IF NOT EXISTS emerging_terminology_bursts (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), burst_key TEXT NOT NULL UNIQUE,
 normalized_surface TEXT NOT NULL, country TEXT NOT NULL, language TEXT NOT NULL,
 current_window_start TIMESTAMPTZ NOT NULL, baseline_window_start TIMESTAMPTZ NOT NULL,
 current_independent_sources INTEGER NOT NULL CHECK(current_independent_sources>=0),
 baseline_independent_sources INTEGER NOT NULL CHECK(baseline_independent_sources>=0),
 burst_ratio NUMERIC NOT NULL CHECK(burst_ratio>=0), source_family_ids JSONB NOT NULL,
 disposition TEXT NOT NULL CHECK(disposition IN('OBSERVED','REACTIVATED','INSUFFICIENT')),
 policy_version TEXT NOT NULL, observed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS terminology_trial_assignments (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), assignment_key TEXT NOT NULL UNIQUE,
 hypothesis_id UUID NOT NULL REFERENCES discovery_hypotheses(id) ON DELETE RESTRICT,
 action_id UUID NOT NULL REFERENCES discovery_actions(id) ON DELETE RESTRICT,
 arm TEXT NOT NULL CHECK(arm IN('TERMINOLOGY','BASELINE_CONTROL')),
 propensity_basis_points INTEGER NOT NULL CHECK(propensity_basis_points BETWEEN 1 AND 10000),
 assignment_cap INTEGER NOT NULL CHECK(assignment_cap>0), quota_cap INTEGER NOT NULL CHECK(quota_cap>0),
 policy_version TEXT NOT NULL, assigned_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS terminology_trial_evaluations (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), evaluation_key TEXT NOT NULL UNIQUE,
 assignment_id UUID NOT NULL REFERENCES terminology_trial_assignments(id) ON DELETE RESTRICT,
 unique_creators INTEGER NOT NULL CHECK(unique_creators>=0), confirmed_creators INTEGER NOT NULL CHECK(confirmed_creators>=0),
 provider_cost INTEGER NOT NULL CHECK(provider_cost>=0), decision TEXT NOT NULL CHECK(decision IN('PASS','FAIL','ABSTAIN')),
 reason_codes JSONB NOT NULL, evidence JSONB NOT NULL, evaluated_at TIMESTAMPTZ NOT NULL, policy_version TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS terminology_catalog_publication_requests (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), request_key TEXT NOT NULL UNIQUE,
 evaluation_id UUID NOT NULL REFERENCES terminology_trial_evaluations(id) ON DELETE RESTRICT,
 concept_id UUID NOT NULL REFERENCES concepts(id) ON DELETE RESTRICT,
 surface_id UUID NOT NULL REFERENCES term_surfaces(id) ON DELETE RESTRICT,
 country TEXT NOT NULL, locale TEXT NOT NULL, lane TEXT NOT NULL DEFAULT 'SEARCH',
 status TEXT NOT NULL DEFAULT 'AWAITING_GOVERNANCE' CHECK(status IN('AWAITING_GOVERNANCE','APPROVED','REJECTED','PUBLISHED')),
 publication_contract JSONB NOT NULL, policy_version TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS terminology_burst_segment_idx ON emerging_terminology_bursts(country,language,observed_at);
UPDATE discovery_provider_registry SET capabilities=capabilities||'["MINE_CHANNEL_CORPUS","MINE_TRANSCRIPT_KEYPHRASES"]'::jsonb,configuration_version=configuration_version+1,updated_at=now(),updated_by='system:migration-048' WHERE provider_key='youtube-corpus';
DO $$ DECLARE t TEXT; BEGIN FOREACH t IN ARRAY ARRAY['emerging_terminology_bursts','terminology_trial_assignments','terminology_trial_evaluations'] LOOP EXECUTE format('CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation()',t,t); END LOOP; END $$;
