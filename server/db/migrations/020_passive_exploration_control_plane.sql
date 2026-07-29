-- Phase 5 is an expand-only, passive control-plane ledger. Nothing in this
-- schema is claimable by a worker and the seeded pilot is deliberately disabled.
ALTER TABLE outcome_events DROP CONSTRAINT IF EXISTS outcome_events_event_type_check;
ALTER TABLE outcome_events ADD CONSTRAINT outcome_events_event_type_check CHECK (event_type IN
  ('QUERY_FUNNEL_RECORDED','PAGE_FUNNEL_RECORDED','CHANNEL_OBSERVED','REVIEW_VERIFIED','REVIEW_CORRECTED','QUOTA_FINALIZED')) NOT VALID;
ALTER TABLE outcome_events VALIDATE CONSTRAINT outcome_events_event_type_check;

CREATE TABLE IF NOT EXISTS research_programs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  root_concept TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'SHADOW' CHECK (mode = 'SHADOW'),
  lifecycle TEXT NOT NULL DEFAULT 'PAUSED' CHECK (lifecycle IN ('ACTIVE','SLEEPING','SATURATED','PAUSED','COMPLETE')),
  policy_version TEXT NOT NULL,
  scope JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(scope)='object'),
  owner TEXT NOT NULL,
  activation_enabled BOOLEAN NOT NULL DEFAULT false CHECK (activation_enabled = false),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS research_program_budgets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id UUID NOT NULL REFERENCES research_programs(id) ON DELETE RESTRICT,
  validity_start TIMESTAMPTZ NOT NULL,
  validity_end TIMESTAMPTZ NOT NULL,
  youtube_units INTEGER NOT NULL DEFAULT 0 CHECK (youtube_units >= 0),
  web_units INTEGER NOT NULL DEFAULT 0 CHECK (web_units >= 0),
  ai_units INTEGER NOT NULL DEFAULT 0 CHECK (ai_units >= 0),
  compute_units INTEGER NOT NULL DEFAULT 0 CHECK (compute_units >= 0),
  review_units INTEGER NOT NULL DEFAULT 0 CHECK (review_units >= 0),
  policy_version TEXT NOT NULL,
  CHECK (validity_end > validity_start),
  UNIQUE(program_id, validity_start, validity_end)
);

CREATE TABLE IF NOT EXISTS research_hypotheses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id UUID NOT NULL REFERENCES research_programs(id) ON DELETE RESTRICT,
  hypothesis_key TEXT NOT NULL,
  statement TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('OPEN','SUPPORTED','REFUTED','ABSTAINED','CLOSED')),
  policy_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(program_id, hypothesis_key)
);

CREATE TABLE IF NOT EXISTS frontier_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id UUID NOT NULL REFERENCES research_programs(id) ON DELETE RESTRICT,
  hypothesis_id UUID REFERENCES research_hypotheses(id) ON DELETE RESTRICT,
  action_type TEXT NOT NULL CHECK (action_type IN ('SEARCH_TERM','CONTINUE_RESULT_PAGE')),
  semantic_action_key TEXT NOT NULL,
  normalized_target TEXT NOT NULL,
  validity_start TIMESTAMPTZ NOT NULL,
  validity_end TIMESTAMPTZ NOT NULL,
  lifecycle TEXT NOT NULL DEFAULT 'OBSERVED' CHECK (lifecycle IN ('OBSERVED','COMPLETED','FAILED')),
  mode TEXT NOT NULL DEFAULT 'SHADOW' CHECK (mode='SHADOW'),
  policy_version TEXT NOT NULL,
  source_query_run_id UUID REFERENCES query_runs(id) ON DELETE SET NULL,
  source_job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
  parent_action_id UUID REFERENCES frontier_actions(id) ON DELETE RESTRICT,
  estimated_cost JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(estimated_cost)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (validity_end > validity_start),
  CHECK ((action_type='SEARCH_TERM' AND parent_action_id IS NULL) OR (action_type='CONTINUE_RESULT_PAGE' AND parent_action_id IS NOT NULL)),
  UNIQUE(program_id, semantic_action_key, validity_start, validity_end)
);

CREATE TABLE IF NOT EXISTS frontier_action_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action_id UUID NOT NULL REFERENCES frontier_actions(id) ON DELETE RESTRICT,
  attempt_key TEXT NOT NULL UNIQUE,
  source_job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
  source_query_run_id UUID REFERENCES query_runs(id) ON DELETE SET NULL,
  page_number INTEGER NOT NULL CHECK (page_number > 0),
  status TEXT NOT NULL CHECK (status IN ('COMPLETED','FAILED')),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ NOT NULL,
  policy_version TEXT NOT NULL,
  CHECK (started_at IS NULL OR completed_at >= started_at)
);

CREATE TABLE IF NOT EXISTS frontier_action_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action_id UUID NOT NULL REFERENCES frontier_actions(id) ON DELETE RESTRICT,
  attempt_id UUID NOT NULL REFERENCES frontier_action_attempts(id) ON DELETE RESTRICT,
  outcome_key TEXT NOT NULL UNIQUE,
  source_outcome_event_key TEXT REFERENCES outcome_events(event_key) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('PROVISIONAL','VERIFIED','CORRECTIVE')),
  observed_at TIMESTAMPTZ NOT NULL,
  metrics JSONB NOT NULL CHECK (jsonb_typeof(metrics)='object'),
  policy_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS frontier_action_lineage (
  ancestor_action_id UUID NOT NULL REFERENCES frontier_actions(id) ON DELETE RESTRICT,
  descendant_action_id UUID NOT NULL REFERENCES frontier_actions(id) ON DELETE RESTRICT,
  depth INTEGER NOT NULL CHECK (depth >= 0),
  PRIMARY KEY(ancestor_action_id, descendant_action_id),
  CHECK ((depth=0) = (ancestor_action_id=descendant_action_id))
);

CREATE TABLE IF NOT EXISTS research_shadow_write_failures (
  failure_key TEXT PRIMARY KEY,
  source_query_run_id UUID REFERENCES query_runs(id) ON DELETE SET NULL,
  source_job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
  stage TEXT NOT NULL,
  safe_error_class TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_frontier_actions_inspection ON frontier_actions(program_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_frontier_actions_source ON frontier_actions(source_query_run_id, action_type);
CREATE INDEX IF NOT EXISTS idx_action_attempts_source ON frontier_action_attempts(source_query_run_id, page_number);
CREATE INDEX IF NOT EXISTS idx_action_outcomes_action ON frontier_action_outcomes(action_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_shadow_failures_time ON research_shadow_write_failures(occurred_at DESC);

-- Outcomes are measurement facts and inherit Phase 4 append-only semantics.
DROP TRIGGER IF EXISTS frontier_action_outcomes_immutable ON frontier_action_outcomes;
CREATE TRIGGER frontier_action_outcomes_immutable BEFORE UPDATE OR DELETE ON frontier_action_outcomes
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation();

INSERT INTO research_programs(program_key,name,root_concept,mode,lifecycle,policy_version,scope,owner,activation_enabled)
VALUES('price-action-trading','Price Action Trading','price action trading','SHADOW','PAUSED','passive-exploration-v1',
       '{"countries":[],"locales":[],"source":"existing-autonomous-search"}'::jsonb,'system',false)
ON CONFLICT(program_key) DO NOTHING;

COMMENT ON TABLE frontier_actions IS 'Phase 5 passive observations only; this table is not a schedulable queue.';
COMMENT ON COLUMN research_programs.activation_enabled IS 'Hard-disabled until a later approved phase.';
