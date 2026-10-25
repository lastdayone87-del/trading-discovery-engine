/**
 * Durable per-quota-day monitor stops.
 *
 * The monitor writes a stop file for the runner and a local state file for
 * alert/stop dedupe, but both default to /tmp and disappear when a container
 * is replaced. The durable cap-refusal counter reconstructs a CAP_EVENTS stop;
 * CAP_UNAVAILABLE and QUOTA_EXHAUSTED are rolling-window signals that can
 * decay before the restart. Persisting the first stop per Pacific day closes
 * that gap and lets the restarted monitor recreate the stop marker.
 */

import type { KeyCapStopReason } from './youtubeKeyCapStopRule';

export interface MonitorStopQueryClient {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface KeyCapMonitorStop {
  quotaDay: string;
  reason: KeyCapStopReason;
  detail: string;
  stoppedAt: string;
}

const QUOTA_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const STOP_REASONS = new Set<KeyCapStopReason>([
  'CAP_EVENTS',
  'CAP_UNAVAILABLE',
  'QUOTA_EXHAUSTED',
]);

export const READ_KEY_CAP_MONITOR_STOP_SQL = `
SELECT quota_day, reason, detail, stopped_at
  FROM youtube_key_cap_monitor_stops
 WHERE quota_day = $1
`;

export const RECORD_KEY_CAP_MONITOR_STOP_SQL = `
INSERT INTO youtube_key_cap_monitor_stops (quota_day, reason, detail, stopped_at)
VALUES ($1, $2, $3, $4)
ON CONFLICT (quota_day) DO NOTHING
RETURNING quota_day, reason, detail, stopped_at
`;

function normalizeStop(row: Record<string, unknown>): KeyCapMonitorStop {
  const quotaDay = String(row.quota_day || '');
  const reason = String(row.reason || '') as KeyCapStopReason;
  const stoppedAt = new Date(row.stopped_at as string | Date);
  if (
    !QUOTA_DAY_PATTERN.test(quotaDay) ||
    !STOP_REASONS.has(reason) ||
    !Number.isFinite(stoppedAt.getTime())
  ) {
    throw new Error('INVALID_KEY_CAP_MONITOR_STOP');
  }
  return {
    quotaDay,
    reason,
    detail: String(row.detail || ''),
    stoppedAt: stoppedAt.toISOString(),
  };
}

export async function readKeyCapMonitorStop(
  client: MonitorStopQueryClient,
  quotaDay: string,
): Promise<KeyCapMonitorStop | null> {
  const result = await client.query(READ_KEY_CAP_MONITOR_STOP_SQL, [quotaDay]);
  const row = result.rows?.[0];
  return row ? normalizeStop(row) : null;
}

export const KEY_CAP_MONITOR_STOP_PERSIST_ATTEMPTS = 5;

/**
 * Retry a transient durable-stop failure before the monitor exits. The local
 * stop file remains the immediate signal; this reduces the window where a
 * container replacement could lose a rolling-window stop because the durable
 * row was never written.
 */
export async function recordKeyCapMonitorStopWithRetry(
  client: MonitorStopQueryClient,
  input: {
    quotaDay: string;
    reason: KeyCapStopReason;
    detail: string;
    at: Date;
  },
  options: {
    attempts?: number;
    delayMs?: (attempt: number) => number;
  } = {},
): Promise<KeyCapMonitorStop> {
  const configuredAttempts = Number(options.attempts);
  const attempts = Number.isSafeInteger(configuredAttempts) && configuredAttempts >= 1
    ? configuredAttempts
    : KEY_CAP_MONITOR_STOP_PERSIST_ATTEMPTS;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await recordKeyCapMonitorStop(client, input);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      const delay = options.delayMs ? options.delayMs(attempt) : attempt * 1_000;
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

/**
 * First stop wins. A concurrent monitor or a retry cannot replace the reason
 * or timestamp that the runner already observed.
 */
export async function recordKeyCapMonitorStop(
  client: MonitorStopQueryClient,
  input: {
    quotaDay: string;
    reason: KeyCapStopReason;
    detail: string;
    at: Date;
  },
): Promise<KeyCapMonitorStop> {
  if (!QUOTA_DAY_PATTERN.test(input.quotaDay) || !STOP_REASONS.has(input.reason)) {
    throw new Error('INVALID_KEY_CAP_MONITOR_STOP');
  }
  const result = await client.query(RECORD_KEY_CAP_MONITOR_STOP_SQL, [
    input.quotaDay,
    input.reason,
    input.detail,
    input.at.toISOString(),
  ]);
  const inserted = result.rows?.[0];
  if (inserted) return normalizeStop(inserted);
  const existing = await readKeyCapMonitorStop(client, input.quotaDay);
  if (!existing) throw new Error('KEY_CAP_MONITOR_STOP_NOT_READABLE');
  return existing;
}
