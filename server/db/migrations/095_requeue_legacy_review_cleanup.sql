-- Repair rows already transformed by migration 094 before its cleanup semantics
-- were corrected. Legacy NEEDS_REVIEW rows without authoritative review lineage
-- were converted to UNCERTAIN/COMPLETED, which can strand genuine unresolved
-- creators because the orphan-investigation reconciler only resumes
-- UNCERTAIN/ENRICHMENT_PENDING work.
--
-- Requeue only rows with evidence that they came through the retired review
-- workflow (a SUPERSEDED review row) and which are not currently governed by an
-- authoritative NOT_ELIGIBLE decision. This avoids reopening intentionally
-- completed UNCERTAIN rows such as channels with no plausible independent
-- trading hypothesis.
UPDATE channels c
SET scan_status='ENRICHMENT_PENDING',
    last_checked=now()
WHERE c.trading_status='UNCERTAIN'
  AND c.scan_status='COMPLETED'
  AND EXISTS (
    SELECT 1
    FROM channel_reviews r
    WHERE r.channel_id=c.channel_id
      AND r.state='SUPERSEDED'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM review_eligibility_projection p
    WHERE p.channel_id=c.channel_id
      AND p.status='NOT_ELIGIBLE'
  );
