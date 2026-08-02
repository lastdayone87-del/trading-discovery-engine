-- Complete the repository-side persistent-research orchestration contract.
-- The rollout remains fail-closed; this migration adds leases, immutable input
-- events, governed policy pins, execution links and external nomination fixtures.
ALTER TABLE research_control
  ADD COLUMN IF NOT EXISTS lease_token UUID,
  ADD COLUMN IF NOT EXISTS lease_owner TEXT,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS checkpoint JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS active_policy_id UUID REFERENCES portfolio_policies(id) ON DELETE RESTRICT;

ALTER TABLE discovery_actions
  ADD COLUMN IF NOT EXISTS reserved_by TEXT,
  ADD COLUMN IF NOT EXISTS reserved_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS execution_attempts INTEGER NOT NULL DEFAULT 0 CHECK(execution_attempts>=0),
  ADD COLUMN IF NOT EXISTS materialization_key TEXT;
ALTER TABLE discovery_actions DROP CONSTRAINT IF EXISTS discovery_actions_lifecycle_check;
ALTER TABLE discovery_actions ADD CONSTRAINT discovery_actions_lifecycle_check CHECK(lifecycle IN('PROPOSED','ALLOCATED','RESERVED','QUEUED','RUNNING','COMPLETED','SLEEPING','REJECTED','EXPIRED')) NOT VALID;
ALTER TABLE discovery_actions VALIDATE CONSTRAINT discovery_actions_lifecycle_check;
CREATE UNIQUE INDEX IF NOT EXISTS discovery_actions_materialization_key_idx ON discovery_actions(materialization_key) WHERE materialization_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS discovery_actions_claim_idx ON discovery_actions(lifecycle,reserved_until,created_at);

CREATE TABLE IF NOT EXISTS discovery_observation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), event_key TEXT NOT NULL UNIQUE,
  program_id UUID REFERENCES research_programs(id) ON DELETE RESTRICT,
  action_id UUID REFERENCES discovery_actions(id) ON DELETE RESTRICT,
  source_event_key TEXT, observation_type TEXT NOT NULL CHECK(observation_type IN
    ('QUERY_FUNNEL','CHANNEL_DECISION','PLAYLIST_RESULT','FRONTIER_RESULT','CORPUS_TERM','PROVIDER_RESULT','COVERAGE_PROJECTION','LIFECYCLE_DECISION')),
  subject_key TEXT NOT NULL, source_family_id TEXT NOT NULL,
  coordinates JSONB NOT NULL, metrics JSONB NOT NULL, evidence JSONB NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL, policy_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK(program_id IS NOT NULL OR action_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS discovery_observation_projection_idx ON discovery_observation_events(observation_type,observed_at,event_key);

CREATE TABLE IF NOT EXISTS discovery_action_execution_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), link_key TEXT NOT NULL UNIQUE,
  action_id UUID NOT NULL REFERENCES discovery_actions(id) ON DELETE RESTRICT,
  executor_type TEXT NOT NULL CHECK(executor_type IN('QUERY_RUN','FRONTIER_ACTION','PLAYLIST_JOB','EXTERNAL_JOB','LOCAL_GENERATOR')),
  executor_id TEXT NOT NULL, job_id UUID REFERENCES jobs(id) ON DELETE RESTRICT,
  parent_link_id UUID REFERENCES discovery_action_execution_links(id) ON DELETE RESTRICT,
  policy_version TEXT NOT NULL, linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(action_id,executor_type,executor_id)
);

CREATE TABLE IF NOT EXISTS persistent_research_cycles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), cycle_key TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK(mode IN('SHADOW','CANARY')), policy_id UUID REFERENCES portfolio_policies(id) ON DELETE RESTRICT,
  lease_owner TEXT NOT NULL, input_cutoff TIMESTAMPTZ NOT NULL, input_checksum TEXT NOT NULL,
  candidate_count INTEGER NOT NULL DEFAULT 0 CHECK(candidate_count>=0), selected_count INTEGER NOT NULL DEFAULT 0 CHECK(selected_count>=0),
  materialized_count INTEGER NOT NULL DEFAULT 0 CHECK(materialized_count>=0),
  provider_cost_reserved INTEGER NOT NULL DEFAULT 0 CHECK(provider_cost_reserved>=0), review_cost_reserved INTEGER NOT NULL DEFAULT 0 CHECK(review_cost_reserved>=0),
  status TEXT NOT NULL CHECK(status IN('STARTED','COMPLETED','FAILED')), failure_class TEXT,
  checkpoint JSONB NOT NULL DEFAULT '{}'::jsonb, started_at TIMESTAMPTZ NOT NULL DEFAULT now(), completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS external_nomination_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), nomination_key TEXT NOT NULL UNIQUE,
  provider_key TEXT NOT NULL REFERENCES discovery_provider_registry(provider_key) ON DELETE RESTRICT,
  provider_native_id TEXT NOT NULL, display_name TEXT, youtube_locator TEXT,
  country TEXT, language TEXT, source_family_id TEXT NOT NULL,
  source_locator JSONB NOT NULL, observed_at TIMESTAMPTZ NOT NULL,
  payload_checksum TEXT NOT NULL, policy_version TEXT NOT NULL,
  UNIQUE(provider_key,provider_native_id,observed_at)
);

CREATE TABLE IF NOT EXISTS persistent_research_policy_evaluations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), evaluation_key TEXT NOT NULL UNIQUE,
  policy_id UUID NOT NULL REFERENCES portfolio_policies(id) ON DELETE RESTRICT,
  baseline_policy_id UUID REFERENCES portfolio_policies(id) ON DELETE RESTRICT,
  dataset_cutoff TIMESTAMPTZ NOT NULL, metrics JSONB NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN('PASS','FAIL','ABSTAIN')),
  reason_codes JSONB NOT NULL, artifact_checksum TEXT NOT NULL,
  evaluated_by TEXT NOT NULL, evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ DECLARE t TEXT; BEGIN FOREACH t IN ARRAY ARRAY[
 'discovery_observation_events','discovery_action_execution_links',
 'external_nomination_observations','persistent_research_policy_evaluations'
] LOOP EXECUTE format('CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation()',t,t); END LOOP; END $$;

COMMENT ON TABLE discovery_observation_events IS 'Immutable source events from which action outcomes and hierarchical coverage are replayed.';
COMMENT ON TABLE external_nomination_observations IS 'Normalized allowlisted nominations; never a classification decision and never an arbitrary crawl result.';
