ALTER TABLE query_runs
  ADD COLUMN IF NOT EXISTS retrieval_lane TEXT NOT NULL DEFAULT 'CHANNEL';

ALTER TABLE query_runs DROP CONSTRAINT IF EXISTS query_runs_retrieval_lane_check;
ALTER TABLE query_runs
  ADD CONSTRAINT query_runs_retrieval_lane_check
  CHECK (retrieval_lane IN ('VIDEO', 'CHANNEL'));

CREATE INDEX IF NOT EXISTS idx_query_runs_lane_country
  ON query_runs(retrieval_lane, country, completed_at DESC);

CREATE INDEX IF NOT EXISTS idx_channel_sightings_lane_outcome
  ON channel_sightings(search_lane, funnel_outcome, observed_at DESC);

-- A durable many-to-many attribution intentionally lives at sighting granularity:
-- one canonical channel may be found by both lanes without duplicating the
-- channel row or the distinct result metrics of either run.
CREATE OR REPLACE VIEW query_lane_performance AS
SELECT
  qr.retrieval_lane,
  qr.country,
  q.intent AS query_family,
  c.component_type,
  c.normalized_term,
  COUNT(DISTINCT qr.id) AS runs,
  COUNT(DISTINCT s.channel_id) AS distinct_creators,
  COUNT(DISTINCT s.channel_id) FILTER (WHERE NOT s.was_known AND s.persisted) AS new_creators,
  COUNT(DISTINCT s.channel_id) FILTER (WHERE s.funnel_outcome = 'TRADING_CONFIRMED') AS trading_creators,
  COUNT(DISTINCT s.channel_id) FILTER (WHERE s.country_outcome = 'REJECTED') AS country_rejected,
  COALESCE(AVG(qr.quota_used), 0) AS average_quota_units,
  COALESCE(AVG((qr.performance_details->>'performanceScore')::numeric), 0) AS average_performance_score
FROM query_runs qr
JOIN query_library q ON q.id = qr.query_id
LEFT JOIN query_run_components c ON c.query_run_id = qr.id
LEFT JOIN channel_sightings s ON s.query_run_id = qr.id AND s.search_lane = qr.retrieval_lane
WHERE qr.status = 'COMPLETED'
GROUP BY qr.retrieval_lane, qr.country, q.intent, c.component_type, c.normalized_term;
