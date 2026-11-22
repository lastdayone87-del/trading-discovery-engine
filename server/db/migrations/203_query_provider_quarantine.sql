-- Query/provider scoped quarantine. A failed provider request must not cool
-- the whole query row (which blocks every provider and retrieval shape).
CREATE TABLE IF NOT EXISTS query_provider_quarantine (
  query_id integer NOT NULL REFERENCES query_library(id) ON DELETE CASCADE,
  provider text NOT NULL,
  until timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (query_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_query_provider_quarantine_until
  ON query_provider_quarantine(until);
