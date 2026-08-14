-- Preserve the actual paid YouTube acquisition cost when an ENRICH_CHANNEL
-- worker crashes after persisting its enriched payload and a later attempt
-- records the successful evidence outcome from that cached payload.
--
-- quota_reservations is the durable source of truth for paid official API units:
-- its units value includes any atomic key-rotation top-ups and remains available
-- after the reservation is finalized as CONSUMED. Normal non-zero outcome costs
-- are left untouched.

CREATE OR REPLACE FUNCTION reconcile_cached_enrichment_provider_cost()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  recovered_units INTEGER;
BEGIN
  IF NEW.status = 'SUCCEEDED' AND COALESCE(NEW.provider_cost, 0) = 0 THEN
    SELECT qr.units
      INTO recovered_units
      FROM quota_reservations qr
     WHERE qr.operation_type = 'ENRICH_CHANNEL'
       AND qr.operation_id = NEW.job_id::text
       AND qr.status = 'CONSUMED'
     LIMIT 1;

    IF recovered_units IS NOT NULL AND recovered_units > 0 THEN
      NEW.provider_cost := recovered_units;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS evidence_outcome_cached_enrichment_cost ON evidence_acquisition_outcomes;
CREATE TRIGGER evidence_outcome_cached_enrichment_cost
BEFORE INSERT ON evidence_acquisition_outcomes
FOR EACH ROW
EXECUTE FUNCTION reconcile_cached_enrichment_provider_cost();
