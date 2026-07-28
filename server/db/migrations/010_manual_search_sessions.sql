CREATE TABLE IF NOT EXISTS manual_search_sessions (
  id UUID PRIMARY KEY,
  original_query TEXT NOT NULL,
  country TEXT NOT NULL,
  generated_query_variants JSONB NOT NULL DEFAULT '[]'::jsonb,
  retrieval_lane TEXT NOT NULL CHECK (retrieval_lane IN ('VIDEO', 'CHANNEL')),
  page_tokens JSONB NOT NULL DEFAULT '[]'::jsonb,
  pages_processed INTEGER NOT NULL DEFAULT 0,
  raw_channel_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  unique_channel_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  known_channel_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  accepted_channel_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  quota_consumed INTEGER NOT NULL DEFAULT 0,
  progress NUMERIC(5,2) NOT NULL DEFAULT 0,
  current_page INTEGER,
  estimated_completion TIMESTAMPTZ,
  consecutive_low_yield_pages INTEGER NOT NULL DEFAULT 0,
  stop_reason TEXT,
  status TEXT NOT NULL CHECK (status IN ('RUNNING','COMPLETED','CANCEL_REQUESTED','CANCELLED','FAILED')),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS manual_search_page_observations (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES manual_search_sessions(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL CHECK (page_number > 0),
  query_variant TEXT NOT NULL,
  retrieval_lane TEXT NOT NULL CHECK (retrieval_lane IN ('VIDEO', 'CHANNEL')),
  input_page_token TEXT,
  next_page_token TEXT,
  raw_channel_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  unique_channel_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  known_channel_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  accepted_channel_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  novelty_ratio NUMERIC(8,5) NOT NULL DEFAULT 0,
  duplicate_ratio NUMERIC(8,5) NOT NULL DEFAULT 0,
  quota_units INTEGER NOT NULL DEFAULT 100,
  quota_efficiency NUMERIC(10,5) NOT NULL DEFAULT 0,
  creator_yield INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(session_id, page_number)
);

CREATE INDEX IF NOT EXISTS idx_manual_search_sessions_status ON manual_search_sessions(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_manual_search_page_metrics ON manual_search_page_observations(retrieval_lane, created_at DESC);

INSERT INTO app_settings(setting_key,setting_value) VALUES
  ('manual_search_max_pages','8'),
  ('manual_search_max_unique_creators','150'),
  ('manual_search_min_new_channel_ratio','0.20'),
  ('manual_search_max_duplicate_ratio','0.80'),
  ('manual_search_max_low_yield_pages','2'),
  ('manual_search_quota_percent','20')
ON CONFLICT(setting_key) DO NOTHING;
