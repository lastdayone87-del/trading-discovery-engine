-- Phase 1: NEEDS_REVIEW is a semantic serving state, not an operational fallback.
-- Release 4 deliberately constrained this ledger to shadow-only decisions.
-- Phase 1 promotes the same immutable ledger to serving authority.
ALTER TABLE review_eligibility_decisions
  DROP CONSTRAINT IF EXISTS review_eligibility_decisions_serving_authority_check;

-- The legacy trigger materialized every NEEDS_REVIEW channel into human review.
-- Serving review materialization is now owned exclusively by the authoritative
-- eligibility transaction, so the legacy projection trigger must be retired.
DROP TRIGGER IF EXISTS channels_sync_review_queue ON channels;
DROP FUNCTION IF EXISTS sync_channel_review_queue();

-- A pre-Phase-1 PENDING row is not proof of genuine human ambiguity. Preserve
-- only a pending row whose snapshot points at the current authoritative ELIGIBLE
-- serving decision for the channel; retire every other legacy pending row.
UPDATE channel_reviews r
SET state='SUPERSEDED',pending_since=NULL,updated_at=now()
WHERE r.state='PENDING'
  AND NOT EXISTS (
    SELECT 1
    FROM review_eligibility_decisions d
    JOIN review_eligibility_projection p
      ON p.channel_id=r.channel_id AND p.decision_id=d.id AND p.status='ELIGIBLE'
    WHERE d.channel_id=r.channel_id
      AND d.status='ELIGIBLE'
      AND d.serving_authority=true
      AND d.policy_version='review-eligibility-v2-serving-1'
      AND r.evidence_snapshot->>'source'='review-eligibility-v2-serving'
      AND r.evidence_snapshot->>'eligibilityDecisionId'=d.id::text
  );

-- A channel may enter NEEDS_REVIEW only when the durable queue contains the
-- PENDING review backed by the current authoritative serving decision.
CREATE OR REPLACE FUNCTION enforce_authoritative_needs_review()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.trading_status = 'NEEDS_REVIEW' OR NEW.scan_status = 'NEEDS_REVIEW' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM channel_reviews r
      JOIN review_eligibility_decisions d
        ON d.id::text=r.evidence_snapshot->>'eligibilityDecisionId'
       AND d.channel_id=NEW.channel_id
       AND d.status='ELIGIBLE'
       AND d.serving_authority=true
       AND d.policy_version='review-eligibility-v2-serving-1'
      JOIN review_eligibility_projection p
        ON p.channel_id=NEW.channel_id
       AND p.decision_id=d.id
       AND p.status='ELIGIBLE'
      WHERE r.channel_id = NEW.channel_id
        AND r.state = 'PENDING'
        AND r.evidence_snapshot->>'source'='review-eligibility-v2-serving'
    ) THEN
      NEW.trading_status := 'UNCERTAIN';
      NEW.scan_status := CASE
        WHEN TG_OP = 'UPDATE' AND OLD.scan_status = 'ENRICHING' THEN 'FAILED'
        ELSE 'COMPLETED'
      END;
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS channels_authoritative_needs_review ON channels;
CREATE TRIGGER channels_authoritative_needs_review
BEFORE INSERT OR UPDATE ON channels
FOR EACH ROW EXECUTE FUNCTION enforce_authoritative_needs_review();

-- Clear legacy review projections that no longer have authoritative lineage.
UPDATE channels c
SET trading_status='UNCERTAIN',
    scan_status=CASE WHEN c.scan_status='NEEDS_REVIEW' THEN 'COMPLETED' ELSE c.scan_status END,
    last_checked=now()
WHERE (c.trading_status='NEEDS_REVIEW' OR c.scan_status='NEEDS_REVIEW')
  AND NOT EXISTS (
    SELECT 1
    FROM channel_reviews r
    JOIN review_eligibility_decisions d
      ON d.id::text=r.evidence_snapshot->>'eligibilityDecisionId'
     AND d.channel_id=c.channel_id
     AND d.status='ELIGIBLE'
     AND d.serving_authority=true
     AND d.policy_version='review-eligibility-v2-serving-1'
    JOIN review_eligibility_projection p
      ON p.channel_id=c.channel_id
     AND p.decision_id=d.id
     AND p.status='ELIGIBLE'
    WHERE r.channel_id=c.channel_id
      AND r.state='PENDING'
      AND r.evidence_snapshot->>'source'='review-eligibility-v2-serving'
  );
