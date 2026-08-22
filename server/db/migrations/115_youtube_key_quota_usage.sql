CREATE TABLE IF NOT EXISTS youtube_key_quota_usage (
  quota_day TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL,
  key_index INTEGER NOT NULL CHECK (key_index > 0),
  units_used INTEGER NOT NULL DEFAULT 0 CHECK (units_used >= 0),
  daily_limit INTEGER NOT NULL DEFAULT 10000 CHECK (daily_limit > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (quota_day, key_fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_youtube_key_quota_usage_day_index
  ON youtube_key_quota_usage(quota_day, key_index);
