-- Preserve the actual paid YouTube acquisition cost when an ENRICH_CHANNEL
-- worker crashes after persisting its enriched payload and a later attempt
-- records the successful evidence outcome from that cached payload.
--
-- A durable candidate with enrichmentStage > 0 is proof that the paid official
-- YouTube acquisition completed. Such a reservation must never be released from
-- accounting merely because stale-job recovery happens after its TTL.

CREATE OR REPLACE FUNCTION preserve_cached_enrichment_reservation_on_expiry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  cached_stage INTEGER;
BEGIN
  IF OLD.status = 'RESERVED'
     AND NEW.status = 'EXPIRED'
     AND NEW.operation_type = 'ENRICH_CHANNEL' THEN
    SELECT COALESCE(NULLIF(j.payload->'candidate'->>'enrichmentStage','')::INTEGER, 0)
      INTO cached_stage
      FROM jobs j
     WHERE j.id::text = NEW.operation_id
     LIMIT 1;

    IF COALESCE(cached_stage, 0) > 0 THEN
      NEW.status := 'CONSUMED';
      NEW.consumed_at := COALESCE(NEW.consumed_at, now());
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS preserve_cached_enrichment_reservation_on_expiry ON quota_reservations;
CREATE TRIGGER preserve_cached_enrichment_reservation_on_expiry
BEFORE UPDATE OF status ON quota_reservations
FOR EACH ROW
EXECUTE FUNCTION preserve_cached_enrichment_reservation_on_expiry();

CREATE OR REPLACE FUNCTION reconcile_cached_enrichment_provider_cost()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  recovered_units INTEGER;
BEGIN
  IF NEW.status = 'SUCCEEDED' AND COALESCE(NEW.provider_cost, 0) = 0 THEN
    -- Repair either side of the crash/TTL race. If the reservation already
    -- expired before this migration/trigger observed it, the successful cached
    -- outcome proves the paid acquisition occurred, so restore CONSUMED first.
    UPDATE quota_reservations
       SET status = 'CONSUMED',
           consumed_at = COALESCE(consumed_at, now())
     WHERE operation_type = 'ENRICH_CHANNEL'
       AND operation_id = NEW.job_id::text
       AND status IN ('RESERVED','EXPIRED')
     RETURNING units INTO recovered_units;

    IF recovered_units IS NULL THEN
      SELECT qr.units
        INTO recovered_units
        FROM quota_reservations qr
       WHERE qr.operation_type = 'ENRICH_CHANNEL'
         AND qr.operation_id = NEW.job_id::text
         AND qr.status = 'CONSUMED'
       LIMIT 1;
    END IF;

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
