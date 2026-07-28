CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS channels (
  channel_id TEXT PRIMARY KEY,
  channel_name TEXT NOT NULL,
  youtube_url TEXT NOT NULL,
  country TEXT NOT NULL,
  country_status TEXT NOT NULL,
  confidence_score INTEGER NOT NULL DEFAULT 0,
  discord_status TEXT NOT NULL,
  discord_invite TEXT,
  scan_status TEXT NOT NULL,
  scan_attempts INTEGER NOT NULL DEFAULT 0,
  discovery_source TEXT NOT NULL,
  first_seen TIMESTAMPTZ NOT NULL,
  last_checked TIMESTAMPTZ,
  next_check TIMESTAMPTZ,
  inspection_trail JSONB NOT NULL DEFAULT '[]'::jsonb,
  subscriber_count TEXT,
  channel_thumbnail_url TEXT,
  quality_score INTEGER NOT NULL DEFAULT 0,
  quality_breakdown JSONB,
  trading_status TEXT NOT NULL DEFAULT 'UNCERTAIN',
  trading_confidence_score INTEGER NOT NULL DEFAULT 0,
  trading_category TEXT NOT NULL DEFAULT 'General Trading',
  trading_relevance_breakdown JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_channels_country ON channels(country);
CREATE INDEX IF NOT EXISTS idx_channels_scan_status ON channels(scan_status);
CREATE INDEX IF NOT EXISTS idx_channels_discord_status ON channels(discord_status);
CREATE INDEX IF NOT EXISTS idx_channels_trading_status ON channels(trading_status);
CREATE INDEX IF NOT EXISTS idx_channels_next_check ON channels(next_check);

CREATE TABLE IF NOT EXISTS country_vocabularies (
  country TEXT PRIMARY KEY,
  languages JSONB NOT NULL,
  native_trading_terminology JSONB NOT NULL,
  popular_instruments JSONB NOT NULL,
  local_market_phrases JSONB NOT NULL,
  common_content_format_names JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS excluded_countries (
  country_name TEXT PRIMARY KEY,
  reason TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS queue_controls (
  queue_name TEXT PRIMARY KEY,
  is_paused BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS quota_tracker (
  id TEXT PRIMARY KEY,
  units_used INTEGER NOT NULL DEFAULT 0,
  daily_limit INTEGER NOT NULL DEFAULT 10000,
  last_reset TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS query_library (
  id SERIAL PRIMARY KEY,
  query TEXT UNIQUE NOT NULL,
  country TEXT NOT NULL,
  collection TEXT NOT NULL,
  intent TEXT NOT NULL,
  times_executed INTEGER NOT NULL DEFAULT 0,
  last_executed TIMESTAMPTZ,
  total_channels_found INTEGER NOT NULL DEFAULT 0,
  unique_channels_found INTEGER NOT NULL DEFAULT 0,
  quality_channels_found INTEGER NOT NULL DEFAULT 0,
  community_channels_found INTEGER NOT NULL DEFAULT 0,
  avg_quality_score REAL NOT NULL DEFAULT 0,
  performance_score REAL NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'ACTIVE'
);
CREATE INDEX IF NOT EXISTS idx_query_country ON query_library(country);
CREATE INDEX IF NOT EXISTS idx_query_collection ON query_library(collection);

CREATE TABLE IF NOT EXISTS query_execution_logs (
  id SERIAL PRIMARY KEY,
  query_id INTEGER REFERENCES query_library(id) ON DELETE SET NULL,
  query TEXT NOT NULL,
  country TEXT NOT NULL,
  executed_at TIMESTAMPTZ NOT NULL,
  channels_discovered INTEGER NOT NULL DEFAULT 0,
  unique_new_channels INTEGER NOT NULL DEFAULT 0,
  quality_creators_discovered INTEGER NOT NULL DEFAULT 0,
  communities_discovered INTEGER NOT NULL DEFAULT 0,
  cycle_quality_score REAL NOT NULL DEFAULT 0,
  logs JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE TABLE IF NOT EXISTS extracted_trading_vocabulary (
  id SERIAL PRIMARY KEY,
  country TEXT NOT NULL,
  term TEXT NOT NULL,
  category TEXT NOT NULL,
  source_channel_id TEXT,
  occurrences INTEGER NOT NULL DEFAULT 1,
  first_extracted TIMESTAMPTZ NOT NULL,
  last_extracted TIMESTAMPTZ NOT NULL,
  UNIQUE(country, term)
);
CREATE INDEX IF NOT EXISTS idx_extracted_vocab_country ON extracted_trading_vocabulary(country);

CREATE TABLE IF NOT EXISTS regression_runs (
  id SERIAL PRIMARY KEY,
  run_timestamp TIMESTAMPTZ NOT NULL,
  run_label TEXT NOT NULL,
  metrics JSONB NOT NULL,
  sample_results JSONB NOT NULL
);
