-- Migration 186: backfill legacy generated-query materialization markers.
--
-- Before the materialization fix, a generated COUNTRY_NATIVE proposal could
-- collide with an existing query_library row and be marked TRIED without
-- persisting countryNativeAllocation.materialized=true. Those rows are valid,
-- already-published queries, but normal scheduling treats them as
-- frontier-only lineage and rejects them with
-- FRONTIER_ALLOCATION_NEIGHBORHOOD_LINEAGE_MISMATCH.
--
-- Backfill only rows that carry the complete generated lineage (proposal id,
-- target neighborhood key, and target dimensions). Rows without that lineage
-- are intentionally left untouched.

UPDATE query_library
SET generation_metadata = jsonb_set(
  generation_metadata,
  '{countryNativeAllocation,materialized}',
  'true'::jsonb,
  true
)
WHERE generation_metadata->'countryNativeAllocation'->>'proposalId' IS NOT NULL
  AND generation_metadata->'countryNativeAllocation'->>'targetNeighborhoodKey' IS NOT NULL
  AND generation_metadata->'countryNativeAllocation'->'targetNeighborhoodDimensions' IS NOT NULL
  AND COALESCE(generation_metadata->'countryNativeAllocation'->>'materialized', '') <> 'true';

-- Complete the audit link on the already-TRIED proposal so operators can see
-- which library row consumed it. This does not change trial status.
UPDATE frontier_discovery_proposals p
SET supporting_evidence = p.supporting_evidence || jsonb_build_object(
  'materializedQueryId', q.id,
  'materializedAt', COALESCE(q.last_executed, q.created_at)
)
FROM query_library q
WHERE q.generation_metadata->'countryNativeAllocation'->>'proposalId' = p.proposal_id::text
  AND q.generation_metadata->'countryNativeAllocation'->>'targetNeighborhoodKey' = p.target_neighborhood_key
  AND q.generation_metadata->'countryNativeAllocation'->>'materialized' = 'true'
  AND p.proposal_family = 'COUNTRY_NATIVE'
  AND p.trial_status = 'TRIED'
  AND NOT (p.supporting_evidence ? 'materializedQueryId');
