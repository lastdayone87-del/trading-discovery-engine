-- Phase 7 adds replayable coverage projections and auditable lifecycle decisions.
-- It does not add an executor, action type, provider, or source.
CREATE TABLE IF NOT EXISTS research_coverage_dimension_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id UUID NOT NULL REFERENCES research_programs(id) ON DELETE RESTRICT,
  version TEXT NOT NULL,
  dimensions JSONB NOT NULL CHECK (jsonb_typeof(dimensions) = 'array'),
  policy_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(program_id, version)
);

CREATE TABLE IF NOT EXISTS research_coverage_cells (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dimension_version_id UUID NOT NULL REFERENCES research_coverage_dimension_versions(id) ON DELETE RESTRICT,
  cell_key TEXT NOT NULL,
  coordinates JSONB NOT NULL CHECK (jsonb_typeof(coordinates) = 'object'),
  target BOOLEAN NOT NULL DEFAULT true,
  unreachable_reason TEXT,
  unreachable_recorded_by TEXT,
  unreachable_recorded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(dimension_version_id, cell_key),
  CHECK ((unreachable_reason IS NULL) = (unreachable_recorded_at IS NULL))
);

-- This is a compact, replayable projection. Source outcomes remain immutable.
CREATE TABLE IF NOT EXISTS research_coverage_statistics (
  program_id UUID NOT NULL REFERENCES research_programs(id) ON DELETE RESTRICT,
  cell_id UUID NOT NULL REFERENCES research_coverage_cells(id) ON DELETE RESTRICT,
  evidence_count BIGINT NOT NULL DEFAULT 0 CHECK (evidence_count >= 0),
  distinct_results BIGINT NOT NULL DEFAULT 0 CHECK (distinct_results >= 0),
  new_creators BIGINT NOT NULL DEFAULT 0 CHECK (new_creators >= 0),
  duplicate_results BIGINT NOT NULL DEFAULT 0 CHECK (duplicate_results >= 0),
  verified_creators BIGINT NOT NULL DEFAULT 0 CHECK (verified_creators >= 0),
  total_provider_cost BIGINT NOT NULL DEFAULT 0 CHECK (total_provider_cost >= 0),
  delayed_backlog BIGINT NOT NULL DEFAULT 0 CHECK (delayed_backlog >= 0),
  first_observed_at TIMESTAMPTZ,
  last_observed_at TIMESTAMPTZ,
  projection_version BIGINT NOT NULL DEFAULT 0 CHECK (projection_version >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(program_id, cell_id)
);

CREATE TABLE IF NOT EXISTS research_coverage_projection_events (
  outcome_key TEXT PRIMARY KEY REFERENCES frontier_action_outcomes(outcome_key) ON DELETE RESTRICT,
  program_id UUID NOT NULL REFERENCES research_programs(id) ON DELETE RESTRICT,
  cell_id UUID NOT NULL REFERENCES research_coverage_cells(id) ON DELETE RESTRICT,
  projector_version TEXT NOT NULL,
  projected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS research_lifecycle_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id UUID NOT NULL REFERENCES research_programs(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('RECOMMENDED_SLEEP','SLEPT','REACTIVATED','PAUSED','CHECKPOINTED','SATURATED','COMPLETED')),
  from_lifecycle TEXT NOT NULL CHECK (from_lifecycle IN ('ACTIVE','SLEEPING','SATURATED','PAUSED','COMPLETE')),
  to_lifecycle TEXT NOT NULL CHECK (to_lifecycle IN ('ACTIVE','SLEEPING','SATURATED','PAUSED','COMPLETE')),
  trigger_type TEXT CHECK (trigger_type IN ('TERMINOLOGY_BURST','NEW_CREATOR_CONTENT','STALE_COVERAGE','PROVIDER_CAPABILITY','HUMAN_NOMINATION','SCHEDULED_PROBE')),
  reason TEXT NOT NULL,
  predicates JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(predicates) = 'object'),
  evidence_window_start TIMESTAMPTZ,
  evidence_window_end TIMESTAMPTZ,
  policy_version TEXT NOT NULL,
  decision_version TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(program_id, idempotency_key),
  CHECK (evidence_window_start IS NULL OR evidence_window_end >= evidence_window_start)
);

CREATE TABLE IF NOT EXISTS research_reactivation_events (
  lifecycle_event_id UUID PRIMARY KEY REFERENCES research_lifecycle_events(id) ON DELETE RESTRICT,
  trigger_key TEXT NOT NULL UNIQUE,
  eligible_at TIMESTAMPTZ NOT NULL,
  freshness_probe BOOLEAN NOT NULL DEFAULT false,
  provider_cost_cap INTEGER NOT NULL DEFAULT 0 CHECK (provider_cost_cap >= 0)
);

CREATE INDEX IF NOT EXISTS idx_coverage_cells_dimension ON research_coverage_cells(dimension_version_id, target, cell_key);
CREATE INDEX IF NOT EXISTS idx_coverage_stats_program ON research_coverage_statistics(program_id, last_observed_at);
CREATE INDEX IF NOT EXISTS idx_lifecycle_events_program ON research_lifecycle_events(program_id, created_at DESC);

DROP TRIGGER IF EXISTS coverage_projection_events_immutable ON research_coverage_projection_events;
CREATE TRIGGER coverage_projection_events_immutable BEFORE UPDATE OR DELETE ON research_coverage_projection_events
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation();
DROP TRIGGER IF EXISTS research_lifecycle_events_immutable ON research_lifecycle_events;
CREATE TRIGGER research_lifecycle_events_immutable BEFORE UPDATE OR DELETE ON research_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation();
DROP TRIGGER IF EXISTS research_reactivation_events_immutable ON research_reactivation_events;
CREATE TRIGGER research_reactivation_events_immutable BEFORE UPDATE OR DELETE ON research_reactivation_events
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation();

INSERT INTO research_coverage_dimension_versions(program_id,version,dimensions,policy_version)
SELECT id,'coverage-v1','["country","language","acquisitionSource","freshnessBand","qualityTier"]'::jsonb,'coverage-lifecycle-v1'
FROM research_programs WHERE program_key='price-action-trading' ON CONFLICT DO NOTHING;

COMMENT ON TABLE research_coverage_statistics IS 'Replayable sufficient-statistics projection; never an absolute ecosystem recall percentage.';
COMMENT ON TABLE research_lifecycle_events IS 'Immutable, versioned topic lifecycle decisions and checkpoints.';
