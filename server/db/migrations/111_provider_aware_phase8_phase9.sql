-- Provider-aware Phase 8/9 contract. Historic quota columns retain their original
-- YouTube meaning; neutral reservation fields are additive and explicitly typed.
ALTER TABLE frontier_allocation_decisions
  ADD COLUMN IF NOT EXISTS provider_key TEXT REFERENCES discovery_provider_registry(provider_key) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS retrieval_surface TEXT,
  ADD COLUMN IF NOT EXISTS provider_capability TEXT,
  ADD COLUMN IF NOT EXISTS cost_domain TEXT,
  ADD COLUMN IF NOT EXISTS provider_reservation_id TEXT,
  ADD COLUMN IF NOT EXISTS provider_reserved_amount BIGINT,
  ADD COLUMN IF NOT EXISTS provider_consumed_amount BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS provider_eligibility_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS continuation_owner TEXT;

-- All historical autonomous rows were produced by the official-only runtime
-- protected by provider2Removal.contract.test.ts.
UPDATE frontier_allocation_decisions SET
 provider_key='youtube-search', retrieval_surface='YOUTUBE_NATIVE', provider_capability='SEARCH_YOUTUBE',
 cost_domain='YOUTUBE_DATA_API', provider_reservation_id='frontier:'||decision_id,
 provider_reserved_amount=quota_reserved, provider_consumed_amount=quota_consumed,
 provider_eligibility_snapshot=jsonb_build_object('providerKey','youtube-search','mode','ACTIVE','capability','SEARCH_YOUTUBE','costDomain','YOUTUBE_DATA_API','historicBackfill',true),
 continuation_owner='PHASE_9'
WHERE provider_key IS NULL;

ALTER TABLE frontier_allocation_decisions
  ALTER COLUMN provider_key SET DEFAULT 'youtube-search',ALTER COLUMN retrieval_surface SET DEFAULT 'YOUTUBE_NATIVE',ALTER COLUMN provider_capability SET DEFAULT 'SEARCH_YOUTUBE',ALTER COLUMN cost_domain SET DEFAULT 'YOUTUBE_DATA_API',
  ALTER COLUMN provider_reservation_id SET DEFAULT 'legacy-compatible',ALTER COLUMN provider_reserved_amount SET DEFAULT 100,
  ALTER COLUMN provider_eligibility_snapshot SET DEFAULT '{"providerKey":"youtube-search","mode":"ACTIVE","compatibilityDefault":true}'::jsonb,ALTER COLUMN continuation_owner SET DEFAULT 'PHASE_9',
  ALTER COLUMN provider_key SET NOT NULL, ALTER COLUMN retrieval_surface SET NOT NULL,
  ALTER COLUMN provider_capability SET NOT NULL, ALTER COLUMN cost_domain SET NOT NULL,
  ALTER COLUMN provider_reservation_id SET NOT NULL, ALTER COLUMN provider_reserved_amount SET NOT NULL,
  ALTER COLUMN provider_eligibility_snapshot SET NOT NULL, ALTER COLUMN continuation_owner SET NOT NULL,
  ADD CONSTRAINT frontier_provider_amounts_check CHECK(provider_reserved_amount>=0 AND provider_consumed_amount>=0),
  ADD CONSTRAINT frontier_provider_snapshot_check CHECK(jsonb_typeof(provider_eligibility_snapshot)='object'),
  ADD CONSTRAINT frontier_phase9_continuation_check CHECK(continuation_owner='PHASE_9');
CREATE INDEX IF NOT EXISTS frontier_allocation_provider_day_idx ON frontier_allocation_decisions(provider_key,cost_domain,quota_day,decision_status);

ALTER TABLE query_runs ADD COLUMN IF NOT EXISTS provider_key TEXT REFERENCES discovery_provider_registry(provider_key) ON DELETE RESTRICT,
 ADD COLUMN IF NOT EXISTS retrieval_surface TEXT, ADD COLUMN IF NOT EXISTS provider_capability TEXT,
 ADD COLUMN IF NOT EXISTS cost_domain TEXT, ADD COLUMN IF NOT EXISTS provider_allocation_snapshot JSONB,
 ADD COLUMN IF NOT EXISTS provider_cursor JSONB NOT NULL DEFAULT '{}'::jsonb;
UPDATE query_runs SET provider_key='youtube-search',retrieval_surface='YOUTUBE_NATIVE',provider_capability='SEARCH_YOUTUBE',cost_domain='YOUTUBE_DATA_API',
 provider_allocation_snapshot=jsonb_build_object('providerKey','youtube-search','retrievalSurface','YOUTUBE_NATIVE','capability','SEARCH_YOUTUBE','costDomain','YOUTUBE_DATA_API','continuationOwner','PHASE_9','historicBackfill',true)
WHERE provider_key IS NULL;
ALTER TABLE query_runs ALTER COLUMN provider_key SET NOT NULL,ALTER COLUMN retrieval_surface SET NOT NULL,
 ALTER COLUMN provider_key SET DEFAULT 'youtube-search',ALTER COLUMN retrieval_surface SET DEFAULT 'YOUTUBE_NATIVE',ALTER COLUMN provider_capability SET DEFAULT 'SEARCH_YOUTUBE',ALTER COLUMN cost_domain SET DEFAULT 'YOUTUBE_DATA_API',
 ALTER COLUMN provider_allocation_snapshot SET DEFAULT '{"providerKey":"youtube-search","retrievalSurface":"YOUTUBE_NATIVE","capability":"SEARCH_YOUTUBE","costDomain":"YOUTUBE_DATA_API","continuationOwner":"PHASE_9","compatibilityDefault":true}'::jsonb,
 ALTER COLUMN provider_capability SET NOT NULL,ALTER COLUMN cost_domain SET NOT NULL,ALTER COLUMN provider_allocation_snapshot SET NOT NULL,
 ADD CONSTRAINT query_run_provider_snapshot_check CHECK(jsonb_typeof(provider_allocation_snapshot)='object'),
 ADD CONSTRAINT query_run_provider_cursor_check CHECK(jsonb_typeof(provider_cursor)='object');
CREATE INDEX IF NOT EXISTS query_runs_provider_completed_idx ON query_runs(provider_key,retrieval_surface,completed_at);

CREATE OR REPLACE FUNCTION protect_provider_allocation_lineage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.provider_key,NEW.retrieval_surface,NEW.provider_capability,NEW.cost_domain,NEW.provider_reservation_id,NEW.provider_eligibility_snapshot,NEW.continuation_owner)
 IS DISTINCT FROM (OLD.provider_key,OLD.retrieval_surface,OLD.provider_capability,OLD.cost_domain,OLD.provider_reservation_id,OLD.provider_eligibility_snapshot,OLD.continuation_owner)
 THEN RAISE EXCEPTION 'IMMUTABLE_PROVIDER_ALLOCATION_LINEAGE'; END IF; RETURN NEW; END $$;
DROP TRIGGER IF EXISTS frontier_provider_lineage_immutable ON frontier_allocation_decisions;
CREATE TRIGGER frontier_provider_lineage_immutable BEFORE UPDATE ON frontier_allocation_decisions FOR EACH ROW EXECUTE FUNCTION protect_provider_allocation_lineage();

CREATE OR REPLACE FUNCTION protect_query_run_provider_lineage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.provider_key,NEW.retrieval_surface,NEW.provider_capability,NEW.cost_domain,NEW.provider_allocation_snapshot)
 IS DISTINCT FROM (OLD.provider_key,OLD.retrieval_surface,OLD.provider_capability,OLD.cost_domain,OLD.provider_allocation_snapshot)
 THEN RAISE EXCEPTION 'IMMUTABLE_QUERY_RUN_PROVIDER_LINEAGE'; END IF; RETURN NEW; END $$;
DROP TRIGGER IF EXISTS query_run_provider_lineage_immutable ON query_runs;
CREATE TRIGGER query_run_provider_lineage_immutable BEFORE UPDATE ON query_runs FOR EACH ROW EXECUTE FUNCTION protect_query_run_provider_lineage();
