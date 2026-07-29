ALTER TABLE manual_search_page_observations
  ADD COLUMN IF NOT EXISTS raw_result_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS distinct_creator_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS confirmed_creator_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS quality_confirmed_creator_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS average_quality_score NUMERIC(8,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS country_precision NUMERIC(8,5) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS community_diversity NUMERIC(8,5) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS marginal_utility NUMERIC(8,5) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS should_continue BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS decision_reason_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS primary_reason TEXT;

CREATE TABLE IF NOT EXISTS autonomous_query_page_observations (
  id BIGSERIAL PRIMARY KEY,
  query_run_id UUID NOT NULL REFERENCES query_runs(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL CHECK(page_number > 0), input_page_token TEXT, next_page_token TEXT,
  retrieval_lane TEXT NOT NULL CHECK(retrieval_lane IN ('VIDEO','CHANNEL')),
  raw_result_count INTEGER NOT NULL DEFAULT 0, distinct_creator_count INTEGER NOT NULL DEFAULT 0,
  known_creators INTEGER NOT NULL DEFAULT 0, new_creators INTEGER NOT NULL DEFAULT 0,
  confirmed_creators INTEGER NOT NULL DEFAULT 0, quality_confirmed_creators INTEGER NOT NULL DEFAULT 0,
  average_quality_score NUMERIC(8,3) NOT NULL DEFAULT 0, country_precision NUMERIC(8,5) NOT NULL DEFAULT 0,
  community_diversity NUMERIC(8,5) NOT NULL DEFAULT 0, novelty_ratio NUMERIC(8,5) NOT NULL DEFAULT 0,
  duplicate_ratio NUMERIC(8,5) NOT NULL DEFAULT 0, quota_units INTEGER NOT NULL DEFAULT 0,
  marginal_utility NUMERIC(8,5) NOT NULL DEFAULT 0, should_continue BOOLEAN NOT NULL DEFAULT false,
  decision_reason_codes JSONB NOT NULL DEFAULT '[]'::jsonb, primary_reason TEXT NOT NULL,
  stopping_reason TEXT, page_metrics JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(query_run_id,page_number)
);
CREATE INDEX IF NOT EXISTS idx_autonomous_pages_run ON autonomous_query_page_observations(query_run_id,page_number);
INSERT INTO app_settings(setting_key,setting_value) VALUES
 ('autonomous_pagination_enabled','false'),('autonomous_pagination_max_pages','3'),
 ('autonomous_pagination_max_low_yield_pages','2') ON CONFLICT(setting_key) DO NOTHING;
