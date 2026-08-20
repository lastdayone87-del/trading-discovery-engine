-- Phase 10 lifecycle closure: historical proposal neighborhoods were descriptive
-- (`ORGANIC` / `frontier_proposal`) rather than executable Phase 9 identities.
-- Terminally quarantine only unconsumed COUNTRY_NATIVE rows; regenerated proposals
-- use VIDEO / RELEVANCE / automated_query and therefore a distinct dedup identity.
UPDATE frontier_discovery_proposals
SET trial_status = 'EXPIRED'
WHERE proposal_family = 'COUNTRY_NATIVE'
  AND trial_status = 'PENDING'
  AND (
    COALESCE(target_dimensions->>'retrievalLane', '') NOT IN ('VIDEO', 'CHANNEL') OR
    COALESCE(target_dimensions->>'searchOrdering', '') NOT IN ('RELEVANCE', 'DATE') OR
    COALESCE(target_dimensions->>'sourceFamily', '') <> 'automated_query'
  );

CREATE INDEX IF NOT EXISTS idx_frontier_alloc_stale_reserved
  ON frontier_allocation_decisions(created_at)
  WHERE allocation_origin='FRONTIER_CANARY' AND decision_status='RESERVED';
