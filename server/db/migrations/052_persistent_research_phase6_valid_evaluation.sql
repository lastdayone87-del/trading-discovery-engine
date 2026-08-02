-- Complete Phase 6 with logged-behavior support and an explicit evaluation window.
ALTER TABLE research_replay_datasets ADD COLUMN IF NOT EXISTS evaluation_window_start TIMESTAMPTZ;
ALTER TABLE research_replay_action_decisions ADD COLUMN IF NOT EXISTS assignment_id UUID REFERENCES discovery_action_assignments(id) ON DELETE RESTRICT;
ALTER TABLE research_replay_action_decisions ADD COLUMN IF NOT EXISTS supported BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE research_replay_action_decisions ADD COLUMN IF NOT EXISTS behavior_propensity_basis_points INTEGER CHECK(behavior_propensity_basis_points BETWEEN 1 AND 10000);
ALTER TABLE research_replay_action_decisions ADD COLUMN IF NOT EXISTS target_propensity_basis_points INTEGER NOT NULL DEFAULT 0 CHECK(target_propensity_basis_points BETWEEN 0 AND 10000);
ALTER TABLE persistent_research_policy_evaluations ADD COLUMN IF NOT EXISTS evaluation_window_start TIMESTAMPTZ;
ALTER TABLE persistent_research_policy_evaluations ADD COLUMN IF NOT EXISTS minimum_assignments INTEGER CHECK(minimum_assignments > 0);

COMMENT ON COLUMN research_replay_action_decisions.behavior_propensity_basis_points IS 'Immutable propensity recorded by the historical behavior-policy assignment; never a replay-policy propensity.';
COMMENT ON COLUMN research_replay_action_decisions.target_propensity_basis_points IS 'Candidate or baseline target-policy probability used as the IPS numerator.';
