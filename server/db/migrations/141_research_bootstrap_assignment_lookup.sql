-- Expression index for the provisional bootstrap usage lookup
-- (bootstrapUsage counts one run's selected assignments by
-- context_snapshot->>'bootstrapRunId'). Without it every bootstrap
-- allocation scans the growing append-only assignment history.
CREATE INDEX IF NOT EXISTS discovery_action_assignments_bootstrap_run_idx
  ON discovery_action_assignments ((context_snapshot ->> 'bootstrapRunId'))
  WHERE selected = true;
