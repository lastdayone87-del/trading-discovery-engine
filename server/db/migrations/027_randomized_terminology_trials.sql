-- Phase 12: randomized, capped terminology trials. Expand-only and disabled by default.
CREATE TABLE IF NOT EXISTS terminology_experiments (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), experiment_key TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','SHADOW','RUNNING','PAUSED','STOPPED')),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), randomization_seed TEXT NOT NULL,
 policy JSONB NOT NULL CHECK(jsonb_typeof(policy)='object'), policy_checksum TEXT NOT NULL,
 catalog_id UUID NOT NULL REFERENCES candidate_catalogs(id), created_by TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS terminology_experiment_arms (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), experiment_id UUID NOT NULL REFERENCES terminology_experiments(id),
 arm_key TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('CURATED_CONTROL','CANDIDATE','CURATED_AA')),
 candidate_key TEXT, weight INTEGER NOT NULL CHECK(weight>0), query_spec JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(experiment_id,arm_key),
 CHECK((kind='CANDIDATE')=(candidate_key IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS terminology_experiment_strata (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), experiment_id UUID NOT NULL REFERENCES terminology_experiments(id),
 stratum_key TEXT NOT NULL, country TEXT NOT NULL, lane TEXT NOT NULL, ordering TEXT NOT NULL,
 time_block TEXT NOT NULL, daily_assignment_cap INTEGER NOT NULL CHECK(daily_assignment_cap>=0),
 daily_quota_cap INTEGER NOT NULL CHECK(daily_quota_cap>=0), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(experiment_id,stratum_key)
);
CREATE TABLE IF NOT EXISTS terminology_eligibility_snapshots (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), experiment_id UUID NOT NULL REFERENCES terminology_experiments(id),
 eligibility_key TEXT NOT NULL UNIQUE, stratum_id UUID NOT NULL REFERENCES terminology_experiment_strata(id),
 action_key TEXT NOT NULL, facts JSONB NOT NULL, eligible BOOLEAN NOT NULL, reasons JSONB NOT NULL,
 policy_checksum TEXT NOT NULL, observed_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS terminology_assignments (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), experiment_id UUID NOT NULL REFERENCES terminology_experiments(id),
 stratum_id UUID NOT NULL REFERENCES terminology_experiment_strata(id), eligibility_snapshot_id UUID NOT NULL REFERENCES terminology_eligibility_snapshots(id),
 action_key TEXT NOT NULL, arm_id UUID NOT NULL REFERENCES terminology_experiment_arms(id), propensity NUMERIC NOT NULL CHECK(propensity>0 AND propensity<=1),
 randomization_value NUMERIC NOT NULL CHECK(randomization_value>=0 AND randomization_value<1),
 mode TEXT NOT NULL CHECK(mode IN ('SHADOW','LIVE')), quota_reserved INTEGER NOT NULL CHECK(quota_reserved>=0),
 job_id UUID REFERENCES jobs(id), assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(experiment_id,action_key)
);
CREATE TABLE IF NOT EXISTS terminology_exposures (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), assignment_id UUID NOT NULL REFERENCES terminology_assignments(id),
 exposure_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status IN ('ENQUEUED','EXECUTED','CANCELLED_SAFE','FAILED')),
 provider_cost INTEGER NOT NULL DEFAULT 0 CHECK(provider_cost>=0), occurred_at TIMESTAMPTZ NOT NULL,
 details JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS terminology_reward_events (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), assignment_id UUID NOT NULL REFERENCES terminology_assignments(id),
 reward_key TEXT NOT NULL UNIQUE, component TEXT NOT NULL CHECK(component IN ('NET_NEW_VERIFIED','DUPLICATE','RELEVANT','COUNTRY_FIT','COMMUNITY_VALUE','REVIEW_COST','QUOTA_COST','HARM','NEGATIVE')),
 value NUMERIC NOT NULL, provisional BOOLEAN NOT NULL DEFAULT true, source_event_key TEXT NOT NULL,
 occurred_at TIMESTAMPTZ NOT NULL, recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS terminology_sufficient_statistics (
 experiment_id UUID NOT NULL REFERENCES terminology_experiments(id), stratum_id UUID NOT NULL REFERENCES terminology_experiment_strata(id),
 arm_id UUID NOT NULL REFERENCES terminology_experiment_arms(id), statistic_version INTEGER NOT NULL,
 sample_size INTEGER NOT NULL CHECK(sample_size>=0), reward_sum NUMERIC NOT NULL, reward_square_sum NUMERIC NOT NULL,
 finalized_sample_size INTEGER NOT NULL CHECK(finalized_sample_size>=0), computed_through TIMESTAMPTZ NOT NULL,
 checksum TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(experiment_id,stratum_id,arm_id,statistic_version)
);
CREATE TABLE IF NOT EXISTS terminology_guardrail_events (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), experiment_id UUID NOT NULL REFERENCES terminology_experiments(id),
 event_key TEXT NOT NULL UNIQUE, guardrail TEXT NOT NULL, observed_value NUMERIC NOT NULL, threshold NUMERIC NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('ALERT','AUTO_PAUSE','AUTO_STOP')), details JSONB NOT NULL,
 occurred_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS terminology_stop_decisions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), experiment_id UUID NOT NULL REFERENCES terminology_experiments(id),
 idempotency_key TEXT NOT NULL UNIQUE, from_status TEXT NOT NULL, to_status TEXT NOT NULL CHECK(to_status IN ('PAUSED','STOPPED')),
 expected_version INTEGER NOT NULL, reason TEXT NOT NULL, actor TEXT NOT NULL, automatic BOOLEAN NOT NULL DEFAULT false,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS terminology_trial_controls (
 singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton), kill_switch BOOLEAN NOT NULL DEFAULT true,
 live_allocation_basis_points INTEGER NOT NULL DEFAULT 0 CHECK(live_allocation_basis_points BETWEEN 0 AND 500),
 protected_curated_basis_points INTEGER NOT NULL DEFAULT 10000 CHECK(protected_curated_basis_points BETWEEN 9500 AND 10000),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO terminology_trial_controls(singleton) VALUES(true) ON CONFLICT DO NOTHING;
CREATE INDEX IF NOT EXISTS idx_term_assignments_reconcile ON terminology_assignments(experiment_id,assigned_at,mode);
CREATE INDEX IF NOT EXISTS idx_term_rewards_assignment ON terminology_reward_events(assignment_id,occurred_at);
DO $$ DECLARE t TEXT; BEGIN FOREACH t IN ARRAY ARRAY['terminology_experiment_arms','terminology_experiment_strata','terminology_eligibility_snapshots','terminology_assignments','terminology_exposures','terminology_reward_events','terminology_sufficient_statistics','terminology_guardrail_events','terminology_stop_decisions'] LOOP
 EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation()',t||'_immutable',t);
END LOOP; END $$;
COMMENT ON TABLE terminology_assignments IS 'Immutable pre-enqueue Phase 12 assignment and propensity; historical Phase F observations are excluded.';
