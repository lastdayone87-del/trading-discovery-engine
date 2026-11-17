-- Bounded saturation sweep reads completed runs by status/completion time and
-- aggregates current sighting outcomes per run. Keep both paths indexed.
CREATE INDEX IF NOT EXISTS idx_query_runs_saturation_mature
  ON query_runs(status, completed_at, query_id)
  WHERE query_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_channel_sightings_query_run_funnel
  ON channel_sightings(query_run_id, funnel_outcome);
