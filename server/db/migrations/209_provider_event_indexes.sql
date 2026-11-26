-- Migration 209: index the provider-capacity and query-run accounting reads.
--
-- provider_call_events is multi-million rows and every semantic attempt reads
-- per-account recent/rate-limited history. The existing time index scans the
-- whole two-day window and filters JSONB, and query_runs completion counts had
-- no run_id index. These partial indexes target the exact predicates and
-- exclude local capacity-deferral echoes that never reached a provider.
--
-- The migration runner builds these indexes CONCURRENTLY before the
-- transactional migration loop. This file only adopts valid indexes or
-- verifies an empty table; it never holds a write-blocking build on a populated
-- table.
SET LOCAL lock_timeout = '10s';

DO $$
DECLARE
  target_oid oid := to_regclass('public.provider_call_events');
  expected record;
  found record;
BEGIN
  IF target_oid IS NULL THEN
    RETURN;
  END IF;

  FOR expected IN
    SELECT * FROM (VALUES
      ('idx_provider_events_gemini_active_org_time',
       'CREATE INDEX IF NOT EXISTS idx_provider_events_gemini_active_org_time ON public.provider_call_events ((request_metadata->>''geminiOrg''), occurred_at DESC) WHERE provider=''gemini'' AND COALESCE(request_metadata->>''geminiCapacityDeferral'','''') <> ''true''',
       2,
       ARRAY['geminiOrg', 'occurred_at DESC', 'provider = ''gemini''', 'geminiCapacityDeferral']::text[]),
      ('idx_provider_events_groq_rate_org_time',
       'CREATE INDEX IF NOT EXISTS idx_provider_events_groq_rate_org_time ON public.provider_call_events ((request_metadata->>''groqOrg''), occurred_at DESC) WHERE provider=''groq'' AND status=''RATE_LIMITED'' AND COALESCE(request_metadata->>''groqCooldownDeferral'','''') <> ''true''',
       2,
       ARRAY['groqOrg', 'occurred_at DESC', 'provider = ''groq''', 'status = ''RATE_LIMITED''', 'groqCooldownDeferral']::text[]),
      ('idx_provider_events_rate_provider_time',
       'CREATE INDEX IF NOT EXISTS idx_provider_events_rate_provider_time ON public.provider_call_events (provider, occurred_at DESC) WHERE status=''RATE_LIMITED''',
       2,
       ARRAY['provider', 'occurred_at DESC', 'status = ''RATE_LIMITED''']::text[]),
      ('idx_provider_events_run_id',
       'CREATE INDEX IF NOT EXISTS idx_provider_events_run_id ON public.provider_call_events (run_id, provider, operation, status) WHERE run_id IS NOT NULL',
       4,
       ARRAY['run_id', 'provider', 'operation', 'status', 'run_id IS NOT NULL']::text[])
    ) AS t(name, create_sql, key_count, fragments)
  LOOP
    SELECT c.oid, i.indisvalid, i.indisready, i.indisunique, i.indnkeyatts,
           i.indpred IS NOT NULL AS has_predicate,
           i.indrelid = target_oid AS correct_table,
           pg_get_indexdef(i.indexrelid) AS definition
      INTO found
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
     WHERE c.oid = to_regclass('public.' || expected.name);

    IF found.oid IS NOT NULL THEN
      IF NOT found.indisvalid OR NOT found.indisready OR found.indisunique
         OR NOT found.has_predicate OR NOT found.correct_table
         OR found.indnkeyatts <> expected.key_count
         OR EXISTS (
           SELECT 1 FROM unnest(expected.fragments) fragment
            WHERE found.definition NOT LIKE '%' || fragment || '%'
         ) THEN
        RAISE EXCEPTION '% exists with the wrong definition; rebuild it CONCURRENTLY before applying migration 209', expected.name;
      END IF;
    ELSE
      IF EXISTS (SELECT 1 FROM public.provider_call_events LIMIT 1) THEN
        RAISE EXCEPTION 'provider_call_events is populated and % is absent; create it CONCURRENTLY out-of-band before applying migration 209', expected.name;
      END IF;
      EXECUTE expected.create_sql;
    END IF;
  END LOOP;
END $$;
