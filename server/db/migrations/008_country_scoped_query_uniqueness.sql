ALTER TABLE query_library ADD COLUMN IF NOT EXISTS normalized_query TEXT;

UPDATE query_library
SET normalized_query = lower(regexp_replace(trim(query), '\s+', ' ', 'g'))
WHERE normalized_query IS NULL;

ALTER TABLE query_library ALTER COLUMN normalized_query SET NOT NULL;
ALTER TABLE query_library DROP CONSTRAINT IF EXISTS query_library_query_key;
ALTER TABLE query_library DROP CONSTRAINT IF EXISTS query_library_country_normalized_query_key;
ALTER TABLE query_library ADD CONSTRAINT query_library_country_normalized_query_key UNIQUE(country, normalized_query);

CREATE INDEX IF NOT EXISTS idx_query_library_normalized_lookup
  ON query_library(lower(country), normalized_query);
