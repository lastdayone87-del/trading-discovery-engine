-- Terminal job completion is also a durable release signal for a channel lock.
-- Migration 090 only reconciled PROCESSING -> PENDING retries. A job that is
-- terminally FAILED/COMPLETED can leave the channel LOCKED when the worker
-- exits before the inspection finalizer runs.
--
-- Terminal releases stay age-bounded: a lock younger than the recovery grace
-- period may belong to an independent search-family or synchronous inspection
-- that carries no channel-keyed PROCESSING job, so only abandoned locks are
-- cleared immediately. Older locks are recovered by this trigger or by the
-- runtime sweep with the same 60-minute bound. The PENDING retry branch keeps
-- migration 090 semantics (no age bound).
--
-- Releases for the same channel are serialized with a transaction-scoped
-- advisory lock so two channel-keyed jobs exiting concurrently cannot each
-- mistake the other for a live lock owner and strand the channel until the
-- sweep runs.

CREATE OR REPLACE FUNCTION reconcile_channel_lock_after_job_release()
RETURNS TRIGGER AS $$
DECLARE
  channel_id_value TEXT;
BEGIN
  IF OLD.status <> 'PROCESSING'
    OR NEW.status NOT IN ('PENDING','FAILED','COMPLETED') THEN
    RETURN NEW;
  END IF;

  channel_id_value := NEW.payload->>'channelId';
  IF channel_id_value IS NULL OR channel_id_value = '' THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('channel_lock_release:' || channel_id_value));

  UPDATE channels c
  SET scan_status = CASE
      WHEN c.trading_status = 'NEEDS_REVIEW' THEN 'NEEDS_REVIEW'
      WHEN c.trading_status = 'UNCERTAIN'
        AND EXISTS (
          SELECT 1 FROM jobs pending
          WHERE pending.type='ENRICH_CHANNEL'
            AND pending.status='PENDING'
            AND pending.payload->>'channelId'=c.channel_id
        ) THEN 'ENRICHMENT_PENDING'
      ELSE 'PENDING'
    END,
    updated_at = now()
  WHERE c.channel_id = channel_id_value
    AND c.scan_status = 'LOCKED'
    AND (NEW.status = 'PENDING' OR c.updated_at < now() - interval '60 minutes')
    AND NOT EXISTS (
      SELECT 1 FROM jobs live
      WHERE live.status='PROCESSING'
        AND live.id <> NEW.id
        AND live.payload->>'channelId'=c.channel_id
    );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jobs_reconcile_channel_lock_after_release ON jobs;
CREATE TRIGGER jobs_reconcile_channel_lock_after_release
AFTER UPDATE OF status ON jobs
FOR EACH ROW
WHEN (
  OLD.status='PROCESSING'
  AND NEW.status IN ('PENDING','FAILED','COMPLETED')
)
EXECUTE FUNCTION reconcile_channel_lock_after_job_release();
