-- Migration 171: append-only acquisition lane telemetry baseline.
--
-- Phase 0 needs a durable per-lane accounting baseline before Phase 1 changes
-- scheduling. The process-local counters in operationsTelemetry reset on every
-- restart, and the existing observation provenance is per URL, so neither can
-- answer "what did DISCOVERY/ENRICHMENT/RETRY/MANUAL actually produce, and how
-- much work remained?" across deploys.
--
-- Design constraints:
--
--   * Additive only: no existing table is altered and no row is backfilled.
--   * Append-only: an event is an observation of a completed inspection/slice;
--     it must never be rewritten or deleted. Corrections are new events.
--   * Truthful outcomes: the enum is closed and mirrors the shared taxonomy in
--     server/acquisitionLaneKeys.ts. A started request is not execution, and a
--     capacity/gate wait is not an acquisition failure.
--   * Bounded detail only: `detail` is a JSON object; callers may not persist
--     URLs, page text, or unbounded payloads.
--
-- Writes are behind ACQUISITION_LANE_TELEMETRY_ENABLED (default false), so this
-- migration is safe to deploy before the flag is ever enabled. Reads are
-- operator-only; no worker consumes this table in Phase 0.

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS public.acquisition_lane_events (
  id BIGSERIAL PRIMARY KEY,
  -- Deterministic (SHA-256) dedupe key so a retried write cannot duplicate an
  -- inspection event. The caller derives it from channel/job/lane/outcome/time.
  event_key TEXT NOT NULL UNIQUE,
  lane TEXT NOT NULL CHECK (lane IN (
    'DISCOVERY',
    'ENRICHMENT',
    'RETRY',
    'MANUAL',
    'MAINTENANCE',
    'UNKNOWN'
  )),
  outcome TEXT NOT NULL CHECK (outcome IN (
    'ACQUIRED',
    'INSPECTED_NO_MATCH',
    'PARTIALLY_INSPECTED',
    'EXTERNALLY_BLOCKED',
    'ACQUISITION_FAILED',
    'CAPACITY_DEFERRED',
    'RUNTIME_UNAVAILABLE',
    'NEVER_EXECUTED',
    'INCONCLUSIVE'
  )),
  job_type TEXT,
  job_id TEXT,
  channel_id TEXT,
  -- 1-based inspection pass. Phase 0 inspections are single-pass; Phase 1
  -- bounded URL slices advance this per slice.
  slice_pass INTEGER CHECK (slice_pass IS NULL OR slice_pass > 0),
  pages_inspected INTEGER NOT NULL DEFAULT 0 CHECK (pages_inspected >= 0),
  requests_started INTEGER NOT NULL DEFAULT 0 CHECK (requests_started >= 0),
  -- Longest single gate wait observed in the pass, not a sum across seeds.
  gate_wait_ms BIGINT CHECK (gate_wait_ms IS NULL OR gate_wait_ms >= 0),
  -- Required retryable work left unexamined after this pass.
  work_remaining INTEGER NOT NULL DEFAULT 0 CHECK (work_remaining >= 0),
  -- Bounded capacity/browser wait code when the outcome is a deferral.
  capacity_event TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(detail) = 'object'),
  observed_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lane health reads scan by lane/outcome over a time window.
CREATE INDEX IF NOT EXISTS idx_acquisition_lane_events_lane_outcome_time
  ON public.acquisition_lane_events (lane, outcome, observed_at DESC);

-- Per-channel provenance reconstruction (Phase 0 audits, Phase 1 slices).
CREATE INDEX IF NOT EXISTS idx_acquisition_lane_events_channel_time
  ON public.acquisition_lane_events (channel_id, observed_at DESC)
  WHERE channel_id IS NOT NULL;

-- Retention/export scans by time even when no lane filter is supplied.
CREATE INDEX IF NOT EXISTS idx_acquisition_lane_events_observed_at
  ON public.acquisition_lane_events (observed_at DESC);

CREATE OR REPLACE FUNCTION public.reject_acquisition_lane_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'ACQUISITION_LANE_EVENT_IMMUTABLE: acquisition lane events are append-only';
END;
$$;

COMMENT ON FUNCTION public.reject_acquisition_lane_event_mutation() IS
  'Phase 0: acquisition lane events are append-only observations; a correction is a new event.';

DROP TRIGGER IF EXISTS acquisition_lane_events_append_only ON public.acquisition_lane_events;
CREATE TRIGGER acquisition_lane_events_append_only
  BEFORE UPDATE OR DELETE ON public.acquisition_lane_events
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_acquisition_lane_event_mutation();

COMMENT ON TABLE public.acquisition_lane_events IS
  'Append-only per-lane acquisition inspection/slice outcomes. Flag-gated writes; never a retry input in Phase 0.';
COMMENT ON COLUMN public.acquisition_lane_events.outcome IS
  'Closed outcome taxonomy; NEVER_EXECUTED only when no work signal exists.';
COMMENT ON COLUMN public.acquisition_lane_events.gate_wait_ms IS
  'Longest single rendered-gate wait in the pass; capacity waits are not acquisition failures.';
