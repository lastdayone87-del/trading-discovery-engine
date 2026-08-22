-- Stage 5: persist the effective provider-request locale for auditable retrieval history.
-- Additive and backward-compatible; existing provider events retain an empty object.
ALTER TABLE provider_call_events
  ADD COLUMN IF NOT EXISTS request_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'provider_call_events_request_metadata_object'
      AND conrelid = 'provider_call_events'::regclass
  ) THEN
    ALTER TABLE provider_call_events
      ADD CONSTRAINT provider_call_events_request_metadata_object
      CHECK (jsonb_typeof(request_metadata) = 'object');
  END IF;
END $$;
