-- Phase E: offline, delayed verified query evaluation. No table in this
-- migration is consumed by the online deterministic planner or UCB selector.
CREATE TABLE IF NOT EXISTS query_reward_policy_versions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), policy_key TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0),
 definition JSONB NOT NULL, definition_checksum TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL CHECK(status IN('APPROVED','RETIRED')), created_by TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(policy_key,version), CHECK(jsonb_typeof(definition)='object')
);
CREATE TABLE IF NOT EXISTS query_verified_outcome_attributions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), attribution_key TEXT NOT NULL UNIQUE,
 outcome_event_key TEXT NOT NULL REFERENCES outcome_events(event_key) ON DELETE RESTRICT,
 query_id INTEGER NOT NULL REFERENCES query_library(id) ON DELETE RESTRICT,
 query_run_id UUID NOT NULL REFERENCES query_runs(id) ON DELETE RESTRICT,
 channel_id TEXT NOT NULL, verified_outcome TEXT NOT NULL CHECK(verified_outcome IN('TRADING_CONFIRMED','NON_TRADING','CORRECTIVE_UNCERTAIN')),
 verification_status TEXT NOT NULL CHECK(verification_status IN('VERIFIED','CORRECTIVE')),
 attribution_model TEXT NOT NULL, evidence JSONB NOT NULL, outcome_at TIMESTAMPTZ NOT NULL,
 policy_version TEXT NOT NULL, recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(), CHECK(jsonb_typeof(evidence)='object')
);
CREATE INDEX IF NOT EXISTS idx_query_verified_attribution_run ON query_verified_outcome_attributions(query_run_id,outcome_at,id);
CREATE TABLE IF NOT EXISTS query_feedback_evaluations (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), evaluation_key TEXT NOT NULL UNIQUE,
 reward_policy_id UUID NOT NULL REFERENCES query_reward_policy_versions(id) ON DELETE RESTRICT,
 window_start TIMESTAMPTZ NOT NULL, cutoff_at TIMESTAMPTZ NOT NULL,
 proxy_metrics JSONB NOT NULL, verified_metrics JSONB NOT NULL, segment_metrics JSONB NOT NULL,
 verified_sample_size INTEGER NOT NULL CHECK(verified_sample_size>=0),
 status TEXT NOT NULL CHECK(status IN('READY_FOR_OFFLINE_INCORPORATION','INSUFFICIENT_EVIDENCE')),
 reason_codes JSONB NOT NULL, created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK(window_start<cutoff_at), CHECK(jsonb_typeof(proxy_metrics)='object'), CHECK(jsonb_typeof(verified_metrics)='object'),
 CHECK(jsonb_typeof(segment_metrics)='object'), CHECK(jsonb_typeof(reason_codes)='array')
);
CREATE TABLE IF NOT EXISTS query_feedback_incorporation_events (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), event_key TEXT NOT NULL UNIQUE,
 evaluation_id UUID NOT NULL REFERENCES query_feedback_evaluations(id) ON DELETE RESTRICT,
 resulting_state TEXT NOT NULL CHECK(resulting_state IN('APPROVED_OFFLINE','REVOKED')),
 prior_event_id UUID REFERENCES query_feedback_incorporation_events(id) ON DELETE RESTRICT,
 reason TEXT NOT NULL, actor TEXT NOT NULL, online_query_authority BOOLEAN NOT NULL DEFAULT false CHECK(online_query_authority=false),
 occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
DO $$ DECLARE t TEXT; BEGIN FOREACH t IN ARRAY ARRAY['query_reward_policy_versions','query_verified_outcome_attributions','query_feedback_evaluations','query_feedback_incorporation_events'] LOOP
 EXECUTE format('CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation()',t,t);
END LOOP; END $$;

CREATE OR REPLACE FUNCTION reject_completed_query_run_mutation() RETURNS trigger AS $$ BEGIN
 IF OLD.status='COMPLETED' THEN RAISE EXCEPTION 'completed query_runs are immutable'; END IF; RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER query_runs_completed_immutable BEFORE UPDATE OR DELETE ON query_runs
 FOR EACH ROW EXECUTE FUNCTION reject_completed_query_run_mutation();

INSERT INTO query_reward_policy_versions(policy_key,version,definition,definition_checksum,status,created_by) VALUES
 ('verified-query-reward',1,'{"verifiedTradingReward":1,"verifiedNonTradingReward":-1,"correctiveReward":0,"minimumVerifiedSamples":30,"confidenceZ":1.96,"minimumSegmentSamples":10,"explorationFloor":0.2,"proxyOutcomesAuthoritative":false}',
  'query-reward-policy-v1','APPROVED','migration-066') ON CONFLICT DO NOTHING;
COMMENT ON TABLE query_feedback_evaluations IS 'Offline evaluation only; proxy and verified outcomes remain separate and cannot update query_library.';
