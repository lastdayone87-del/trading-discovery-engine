-- Migration 206: index the corpus scoring join key.
--
-- corpus_candidate_occurrences has millions of rows. SCORE_CANDIDATES filters
-- by normalized_span, so the absence of this index forced a full scan on every
-- scoring job and blocked the single corpus worker for tens of minutes.
--
-- The migration runner builds this index CONCURRENTLY before the transactional
-- migration loop. This file only adopts a valid index or verifies an empty
-- table; it never holds a write-blocking build on a populated table.
SET LOCAL lock_timeout = '10s';

DO $$
DECLARE
  index_oid oid;
  index_valid boolean;
  index_ready boolean;
BEGIN
  SELECT c.oid, i.indisvalid, i.indisready
    INTO index_oid, index_valid, index_ready
    FROM pg_class c
    JOIN pg_index i ON i.indexrelid = c.oid
   WHERE c.oid = to_regclass('public.idx_corpus_occurrences_normalized');

  IF index_oid IS NOT NULL AND (NOT index_valid OR NOT index_ready) THEN
    RAISE EXCEPTION 'idx_corpus_occurrences_normalized exists but is not valid/ready; rebuild it CONCURRENTLY out-of-band before applying migration 206';
  END IF;

  IF index_oid IS NOT NULL AND (
    pg_get_indexdef(index_oid) NOT LIKE '%corpus_candidate_occurrences%'
    OR pg_get_indexdef(index_oid) NOT LIKE '%normalized_span%'
    OR pg_get_indexdef(index_oid) NOT LIKE '%document_id%'
    OR pg_get_indexdef(index_oid) NOT LIKE '%start_offset%'
  ) THEN
    RAISE EXCEPTION 'idx_corpus_occurrences_normalized exists with the wrong table/columns; rebuild it CONCURRENTLY before applying migration 206';
  END IF;

  IF index_oid IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.corpus_candidate_occurrences LIMIT 1) THEN
      RAISE EXCEPTION 'corpus_candidate_occurrences is populated and idx_corpus_occurrences_normalized is absent; create it CONCURRENTLY out-of-band before applying migration 206';
    END IF;
    CREATE INDEX IF NOT EXISTS idx_corpus_occurrences_normalized
      ON public.corpus_candidate_occurrences(normalized_span, document_id, start_offset);
  END IF;
END $$;
