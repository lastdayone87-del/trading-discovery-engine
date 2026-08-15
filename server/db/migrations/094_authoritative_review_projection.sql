-- Phase 1: NEEDS_REVIEW is a semantic serving state, not an operational fallback.
-- Release 4 deliberately constrained this ledger to shadow-only decisions.
-- Phase 1 promotes the same immutable ledger to serving authority.
ALTER TABLE review_eligibility_decisions
  DROP CONSTRAINT IF EXISTS review_eligibility_decisions_serving_authority_check;

-- A channel may enter NEEDS_REVIEW only when the durable review queue already
-- contains a pending review created from an authoritative eligibility decision.
CREATE OR REPLACE FUNCTION enforce_authoritative_needs_review()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.trading_status = 'NEEDS_REVIEW' OR NEW.scan_status = 'NEEDS_REVIEW' THEN
    IF NOT EXISTS (
      SELECT 1 FROM channel_reviews r
      WHERE r.channel_id = NEW.channel_id AND r.state = 'PENDING'
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

-- Clean up legacy operational review debt only when there is no durable human
-- review row backing it. Genuine pending human reviews are preserved.
UPDATE channels c
SET trading_status='UNCERTAIN',
    scan_status=CASE WHEN c.scan_status='NEEDS_REVIEW' THEN 'COMPLETED' ELSE c.scan_status END,
    last_checked=now()
WHERE (c.trading_status='NEEDS_REVIEW' OR c.scan_status='NEEDS_REVIEW')
  AND NOT EXISTS (
    SELECT 1 FROM channel_reviews r
    WHERE r.channel_id=c.channel_id AND r.state='PENDING'
  );
