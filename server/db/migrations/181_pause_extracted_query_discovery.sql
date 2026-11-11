-- Pause extracted-query discovery while the semantic extractor is rebuilt.
-- Scope is intentionally limited to the feature introduced by PR #613:
--   * disable generation and planner serving through app_settings;
--   * quarantine only EXTRACTED_STANDALONE query rows (no other query source);
--   * clear only the extracted-query candidate audit ledger.
-- Query runs, execution logs, channel sightings, and the rest of query_library
-- remain untouched. Tables are retained for the future rewrite.
INSERT INTO app_settings(setting_key, setting_value)
VALUES ('extracted_query_discovery_enabled', 'false')
ON CONFLICT (setting_key) DO UPDATE SET setting_value = 'false';

UPDATE query_library
SET status = 'INACTIVE',
    collection = 'REJECTED',
    generation_metadata = COALESCE(generation_metadata, '{}'::jsonb)
      || jsonb_build_object('extractedQueryPaused', true)
WHERE generation_metadata->>'queryTemplate' = 'EXTRACTED_STANDALONE'
  AND status IS DISTINCT FROM 'INACTIVE';

DELETE FROM extracted_query_candidates;
