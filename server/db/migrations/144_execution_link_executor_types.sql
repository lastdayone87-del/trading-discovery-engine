-- The executor_type allowlist predates the corpus/external materializers:
-- materializeCorpusMiningActions inserts 'CORPUS_DOCUMENT' and
-- materializeExternalActions inserts 'ENTITY_RESOLUTION' /
-- 'EXTERNAL_PROVIDER_JOB', all rejected by the old CHECK, so those paths
-- could never commit an execution link. Extend the allowlist to exactly the
-- values the live code writes; nothing previously valid becomes invalid.
ALTER TABLE discovery_action_execution_links
  DROP CONSTRAINT IF EXISTS discovery_action_execution_links_executor_type_check;
ALTER TABLE discovery_action_execution_links
  ADD CONSTRAINT discovery_action_execution_links_executor_type_check
  CHECK(executor_type IN('QUERY_RUN','FRONTIER_ACTION','PLAYLIST_JOB','EXTERNAL_JOB','LOCAL_GENERATOR','CORPUS_DOCUMENT','ENTITY_RESOLUTION','EXTERNAL_PROVIDER_JOB'));
