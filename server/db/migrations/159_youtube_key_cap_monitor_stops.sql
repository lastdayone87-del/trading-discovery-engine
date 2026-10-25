-- Migration 159: durable per-quota-day YouTube cap monitor stops.
--
-- The monitor's /tmp stop and state files are only a cache. A container
-- replacement loses them, and a cap-unavailable or quota-exhausted stop is
-- derived from a rolling window that can decay before the monitor restarts.
-- Persisting the first stop for each Pacific quota day makes an enforcing stop
-- restart-safe and lets a new monitor recreate the stop file before sampling.
--
-- Only the three quota-day cap reasons are stored. Health, queue, and monitor
-- availability stops remain fail-closed file signals; they are not tied to a
-- quota day and should not be silently cleared by the next day's sample.

CREATE TABLE IF NOT EXISTS youtube_key_cap_monitor_stops (
  quota_day TEXT PRIMARY KEY,
  reason TEXT NOT NULL CHECK (reason IN ('CAP_EVENTS', 'CAP_UNAVAILABLE', 'QUOTA_EXHAUSTED')),
  detail TEXT NOT NULL,
  stopped_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE youtube_key_cap_monitor_stops IS
  'First durable cap-monitor stop per Pacific quota day. Recreates the /tmp stop marker after a monitor or container restart.';
