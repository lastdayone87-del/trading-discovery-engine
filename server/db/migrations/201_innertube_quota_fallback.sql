-- Admission-pending pages are a provisional evidence wait, not a terminal
-- page stop. Widen the deferred_reason taxonomy so the page can be re-opened
-- for continuation while the admission verdicts settle.
ALTER TABLE autonomous_query_page_observations
  DROP CONSTRAINT IF EXISTS chk_page_obs_deferred_reason;
ALTER TABLE autonomous_query_page_observations
  ADD CONSTRAINT chk_page_obs_deferred_reason
  CHECK (deferred_reason IS NULL OR deferred_reason IN ('QUOTA', 'TIME', 'ADMISSION')) NOT VALID;
ALTER TABLE autonomous_query_page_observations
  VALIDATE CONSTRAINT chk_page_obs_deferred_reason;

-- Official-quota fallback: a run that has not retrieved any page yet may move
-- from the official YouTube Data API to the quota-free InnerTube provider.
-- This is the only provider-identity transition allowed after creation, and it
-- is gated on both the zero-page precondition and an explicit provider_cursor
-- marker written by the fallback transaction. All other lineage rewrites stay
-- immutable.
CREATE OR REPLACE FUNCTION protect_query_run_provider_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.provider_key,NEW.retrieval_surface,NEW.provider_capability,NEW.cost_domain,NEW.provider_allocation_snapshot)
     IS DISTINCT FROM (OLD.provider_key,OLD.retrieval_surface,OLD.provider_capability,OLD.cost_domain,OLD.provider_allocation_snapshot)
  THEN
    IF OLD.provider_key='youtube-search'
       AND OLD.cost_domain='YOUTUBE_DATA_API'
       AND OLD.pages_completed=0
       AND OLD.allocation_origin <> 'FRONTIER_CANARY'
       AND OLD.search_ordering='RELEVANCE'
       AND OLD.retrieval_treatment_origin='CONTROL'
       AND NOT (OLD.metadata ? 'searchWindow')
       AND OLD.status NOT IN ('COMPLETED','FAILED')
       AND OLD.continued_to_run_id IS NULL
       AND OLD.continued_from_run_id IS NULL
       AND NEW.provider_key='youtube-innertube'
       AND NEW.cost_domain='YOUTUBE_INNERTUBE_FREE'
       AND NEW.quota_reserved=0
       AND NEW.provider_cursor->>'quotaFallbackFrom'='youtube-search'
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'IMMUTABLE_QUERY_RUN_PROVIDER_LINEAGE';
  END IF;
  RETURN NEW;
END $$;
