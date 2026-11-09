-- Migration 173: allow the ordinary retry event on investigation steps.
-- retryInvestigationStep() restores a FAILED step before reopening its stable
-- enrichment job; the audit event must be accepted or the whole transaction
-- rolls back and the retry silently loses workflow linkage.
SET LOCAL lock_timeout = '10s';

ALTER TABLE public.investigation_events
  DROP CONSTRAINT IF EXISTS investigation_events_event_type_check;

ALTER TABLE public.investigation_events
  ADD CONSTRAINT investigation_events_event_type_check CHECK(event_type IN (
    'INVESTIGATION_STARTED',
    'STEP_SCHEDULED',
    'STEP_STARTED',
    'STEP_HEARTBEAT',
    'STEP_RETRYING',
    'STEP_RETRY_REQUESTED',
    'STEP_COMPLETED',
    'STEP_FAILED',
    'STEP_SKIPPED',
    'INVESTIGATION_COMPLETED',
    'INVESTIGATION_REVIEW',
    'INVESTIGATION_RECOVERED',
    'INVESTIGATION_SUPERSEDED'
  ));
