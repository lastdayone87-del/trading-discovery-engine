-- Reconcile channel-level LOCKED projections when durable processing ownership is gone.
-- The jobs table remains the source of truth for active work. A channel must not
-- remain visually "Scanning" after its PROCESSING job has been returned to PENDING
-- or after an older worker disappeared.

CREATE OR REPLACE FUNCTION reconcile_channel_lock_after_job_release()
RETURNS TRIGGER AS $$
DECLARE
  channel_id_value TEXT;
BEGIN
  IF OLD.status <> 'PROCESSING' OR NEW.status <> 'PENDING' THEN
    RETURN NEW;
  END IF;

  channel_id_value := NEW.payload->>'channelId';
  IF channel_id_value IS NULL OR channel_id_value = '' THEN
    RETURN NEW;
  END IF;

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
WHEN (OLD.status='PROCESSING' AND NEW.status='PENDING')
EXECUTE FUNCTION reconcile_channel_lock_after_job_release();

-- One-time recovery for projections stranded before this trigger existed.
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
WHERE c.scan_status='LOCKED'
  AND c.updated_at < now()-interval '60 minutes'
  AND NOT EXISTS (
    SELECT 1 FROM jobs live
    WHERE live.status='PROCESSING'
      AND live.payload->>'channelId'=c.channel_id
  );
