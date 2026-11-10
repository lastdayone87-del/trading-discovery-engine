-- Integrated extraction candidate ledger. This is the durable source for
-- standalone extracted queries and the LCB projection; rejected rows are kept
-- so operators can audit what was discarded and why.
CREATE TABLE IF NOT EXISTS extracted_query_candidates (
  id BIGSERIAL PRIMARY KEY,
  candidate_key TEXT NOT NULL,
  country TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'und',
  script TEXT NOT NULL DEFAULT 'Zyyy',
  candidate_text TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_channel_id TEXT,
  source_video_id TEXT,
  source_title TEXT,
  intent TEXT NOT NULL DEFAULT 'strategy',
  confidence NUMERIC(4,3) NOT NULL DEFAULT 0,
  decision TEXT NOT NULL CHECK (decision IN ('ACCEPTED','REJECTED')),
  rejection_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  standalone_eligible BOOLEAN NOT NULL DEFAULT false,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  duplicate_sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  query_id INTEGER REFERENCES query_library(id) ON DELETE SET NULL,
  last_attempted_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(country, language, candidate_key)
);
CREATE INDEX IF NOT EXISTS idx_extracted_query_candidates_serving
  ON extracted_query_candidates(country, decision, standalone_eligible, query_id, last_attempted_at);
CREATE INDEX IF NOT EXISTS idx_extracted_query_candidates_query
  ON extracted_query_candidates(query_id) WHERE query_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_extracted_query_candidates_recent
  ON extracted_query_candidates(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_query_runs_query_id
  ON query_runs(query_id);
CREATE INDEX IF NOT EXISTS idx_query_execution_logs_query_id
  ON query_execution_logs(query_id);
