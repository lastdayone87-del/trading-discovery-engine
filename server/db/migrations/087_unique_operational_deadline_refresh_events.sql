-- Ensure every operational investigation deadline refresh is represented by a
-- distinct immutable ledger event even when attempt-free retries reuse the same
-- job attempt number.
--
-- The runtime event key intentionally remains stable at the call site. This
-- trigger adds a database-owned monotonic identity at INSERT time, so repeated
-- refreshes cannot collide with an earlier event and be discarded by
-- ON CONFLICT(event_key) DO NOTHING.

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
