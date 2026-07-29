ALTER TABLE query_runs
  ADD COLUMN IF NOT EXISTS search_ordering TEXT NOT NULL DEFAULT 'RELEVANCE';
ALTER TABLE query_runs DROP CONSTRAINT IF EXISTS query_runs_search_ordering_check;
ALTER TABLE query_runs ADD CONSTRAINT query_runs_search_ordering_check
  CHECK(search_ordering IN ('RELEVANCE','DATE') AND (search_ordering <> 'DATE' OR retrieval_lane = 'VIDEO'));

ALTER TABLE autonomous_query_page_observations
  ADD COLUMN IF NOT EXISTS search_ordering TEXT NOT NULL DEFAULT 'RELEVANCE';
ALTER TABLE autonomous_query_page_observations DROP CONSTRAINT IF EXISTS autonomous_pages_search_ordering_check;
ALTER TABLE autonomous_query_page_observations ADD CONSTRAINT autonomous_pages_search_ordering_check
  CHECK(search_ordering IN ('RELEVANCE','DATE') AND (search_ordering <> 'DATE' OR retrieval_lane = 'VIDEO'));

ALTER TABLE terminology_performance
  ADD COLUMN IF NOT EXISTS search_ordering TEXT NOT NULL DEFAULT 'RELEVANCE';
ALTER TABLE terminology_performance DROP CONSTRAINT IF EXISTS terminology_performance_search_ordering_check;
ALTER TABLE terminology_performance ADD CONSTRAINT terminology_performance_search_ordering_check
  CHECK(search_ordering IN ('RELEVANCE','DATE'));

CREATE INDEX IF NOT EXISTS idx_query_runs_ordering_lane
  ON query_runs(search_ordering,retrieval_lane,completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_terminology_performance_ordering_lane
  ON terminology_performance(search_ordering,retrieval_lane,executed_at DESC);

INSERT INTO app_settings(setting_key,setting_value)
VALUES('discovery_date_ordering_video_percent','10')
ON CONFLICT(setting_key) DO NOTHING;
