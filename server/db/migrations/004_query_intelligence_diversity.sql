ALTER TABLE query_library ADD COLUMN IF NOT EXISTS knowledge_tiers SMALLINT[] NOT NULL DEFAULT ARRAY[1]::SMALLINT[];
ALTER TABLE query_library ADD COLUMN IF NOT EXISTS generation_mode TEXT NOT NULL DEFAULT 'LEGACY';
ALTER TABLE query_library ADD COLUMN IF NOT EXISTS generation_reason TEXT NOT NULL DEFAULT 'Legacy query migrated without generation metadata.';
ALTER TABLE query_library ADD COLUMN IF NOT EXISTS discovery_objective TEXT NOT NULL DEFAULT 'Discover relevant trading creators.';
ALTER TABLE query_library ADD COLUMN IF NOT EXISTS primary_term TEXT;
ALTER TABLE query_library ADD COLUMN IF NOT EXISTS generation_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE extracted_trading_vocabulary ADD COLUMN IF NOT EXISTS trust_tier SMALLINT NOT NULL DEFAULT 3;
ALTER TABLE extracted_trading_vocabulary ADD COLUMN IF NOT EXISTS validation_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS extracted_vocabulary_sources (
  term_id INTEGER NOT NULL REFERENCES extracted_trading_vocabulary(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(term_id, channel_id)
);

INSERT INTO extracted_vocabulary_sources(term_id, channel_id)
SELECT v.id, v.source_channel_id
FROM extracted_trading_vocabulary v
JOIN channels c ON c.channel_id = v.source_channel_id
WHERE v.source_channel_id IS NOT NULL
  AND c.trading_status = 'TRADING_CONFIRMED'
ON CONFLICT DO NOTHING;

UPDATE extracted_trading_vocabulary v
SET validation_count = source_counts.confirmed_sources,
    trust_tier = CASE WHEN source_counts.confirmed_sources >= 2 THEN 2 ELSE 3 END
FROM (
  SELECT s.term_id, COUNT(DISTINCT s.channel_id)::int AS confirmed_sources
  FROM extracted_vocabulary_sources s
  JOIN channels c ON c.channel_id = s.channel_id AND c.trading_status = 'TRADING_CONFIRMED'
  GROUP BY s.term_id
) source_counts
WHERE source_counts.term_id = v.id;

CREATE INDEX IF NOT EXISTS idx_query_cooldown ON query_library(country, last_executed DESC);
CREATE INDEX IF NOT EXISTS idx_query_primary_term ON query_library(country, primary_term, last_executed DESC);
CREATE INDEX IF NOT EXISTS idx_extracted_vocab_trust ON extracted_trading_vocabulary(country, trust_tier, occurrences DESC);
