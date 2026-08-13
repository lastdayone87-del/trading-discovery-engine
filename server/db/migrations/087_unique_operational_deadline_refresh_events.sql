-- Ensure every operational investigation deadline refresh is represented by a
-- distinct immutable ledger event even when attempt-free retries reuse the same
-- job attempt number.
--
-- The runtime event key intentionally remains stable at the call site. This
-- trigger adds a database-owned monotonic identity at INSERT time, so repeated
-- refreshes cannot collide with an earlier event and be discarded by
-- ON CONFLICT(event_key) DO NOTHING.

-- Migration 039 created an inline CHECK constraint for the original event set.
-- The runtime now emits INVESTIGATION_DEADLINE_REFRESHED, so extend that ledger
-- constraint before installing the trigger below. The generated PostgreSQL name
-- for the inline column constraint is deterministic for this table/column.
ALTER TABLE investigation_events
  DROP CONSTRAINT IF EXISTS investigation_events_event_type_check;
ALTER TABLE investigation_events
  ADD CONSTRAINT investigation_events_event_type_check
  CHECK(event_type IN(
    'INVESTIGATION_STARTED',
    'STEP_SCHEDULED',
    'STEP_STARTED',
    'STEP_HEARTBEAT',
    'STEP_RETRYING',
    'STEP_COMPLETED',
    'STEP_FAILED',
    'STEP_SKIPPED',
    'INVESTIGATION_COMPLETED',
    'INVESTIGATION_REVIEW',
    'INVESTIGATION_RECOVERED',
    'INVESTIGATION_SUPERSEDED',
    'INVESTIGATION_DEADLINE_REFRESHED'
  ));

CREATE SEQUENCE IF NOT EXISTS investigation_deadline_refresh_event_seq;

CREATE OR REPLACE FUNCTION namespace_investigation_deadline_refresh_event_key()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.event_type = 'INVESTIGATION_DEADLINE_REFRESHED' THEN
    NEW.event_key := NEW.event_key
      || ':refresh:'
      || nextval('investigation_deadline_refresh_event_seq')::text;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS investigation_events_deadline_refresh_namespace
  ON investigation_events;

CREATE TRIGGER investigation_events_deadline_refresh_namespace
BEFORE INSERT ON investigation_events
FOR EACH ROW
EXECUTE FUNCTION namespace_investigation_deadline_refresh_event_key();
