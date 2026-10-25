/**
 * Corrected YouTube per-key cap stop rule and restart-safe monitor state.
 *
 * The original monitor read cap counts from job_attempts, but cap refusals
 * happen before provider dispatch and never create a job attempt. It also read
 * the application log, which Docker rotates roughly hourly at cap-storm rates.
 * The corrected rule takes the durable per-day/key counter as its authoritative
 * `capExceeded` input, counts both cap error codes toward the event threshold,
 * and keeps the stricter independent guard for cap-unavailable failures.
 *
 * State is only an alert/stop dedupe layer. The counter itself is durable, so a
 * process restart re-reads the same total and does not need a checkpoint to
 * reconstruct it. A new Pacific quota day resets the state automatically.
 */

export const CAP_EVENT_STOP_THRESHOLD = 500;
export const CAP_UNAVAILABLE_STOP_THRESHOLD = 3;
export const QUOTA_EXHAUSTED_STOP_THRESHOLD = 20;

export type KeyCapStopReason = 'CAP_EVENTS' | 'CAP_UNAVAILABLE' | 'QUOTA_EXHAUSTED';

export interface KeyCapStopSample {
  /** Authoritative durable count for the current Pacific quota day. */
  capExceeded: number;
  /** Enforcement-unavailable count; log-derived when the DB was unreachable. */
  capUnavailable: number;
  /** Provider quotaExceeded/dailyLimitExceeded observations. */
  quotaExhausted: number;
}

export interface KeyCapStopVerdict {
  stop: boolean;
  reason: KeyCapStopReason | null;
  detail: string;
}

export interface KeyCapMonitorState {
  quotaDay: string;
  capExceeded: number;
  stopReason: KeyCapStopReason | null;
  stopAt: string | null;
}

export interface KeyCapMonitorEvaluation {
  state: KeyCapMonitorState;
  verdict: KeyCapStopVerdict;
  /** True only on the first transition to stop for this quota day. */
  shouldWriteStop: boolean;
}

function finiteCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

/**
 * Threshold semantics (preserved from the tested corrected rule):
 *  - cap-unavailable > 3 stops independently;
 *  - cap-exceeded + cap-unavailable > 500 stops;
 *  - provider quota-exhausted > 20 stops.
 * Equality does not stop.
 */
export function evaluateYouTubeKeyCapStopRule(sample: KeyCapStopSample): KeyCapStopVerdict {
  const capExceeded = finiteCount(sample.capExceeded);
  const capUnavailable = finiteCount(sample.capUnavailable);
  const quotaExhausted = finiteCount(sample.quotaExhausted);
  const combined = capExceeded + capUnavailable;
  const detail = `cap_exceeded=${capExceeded} cap_unavailable=${capUnavailable} combined=${combined} quota_exhausted=${quotaExhausted}`;

  if (capUnavailable > CAP_UNAVAILABLE_STOP_THRESHOLD) {
    return { stop: true, reason: 'CAP_UNAVAILABLE', detail };
  }
  if (combined > CAP_EVENT_STOP_THRESHOLD) {
    return { stop: true, reason: 'CAP_EVENTS', detail };
  }
  if (quotaExhausted > QUOTA_EXHAUSTED_STOP_THRESHOLD) {
    return { stop: true, reason: 'QUOTA_EXHAUSTED', detail };
  }
  return { stop: false, reason: null, detail };
}

/**
 * Lower bound for the rolling secondary signals (cap-unavailable and
 * quota-exhausted). At a Pacific quota reset, pass the reset epoch so jobs
 * blocked before the reset are not mistaken for a new post-reset spike. The
 * normal window is one hour and can never start earlier than that.
 */
export function monitorSecondaryWindowStart(
  nowMs: number,
  sinceEpochSeconds: number,
): Date {
  const oneHourAgo = nowMs - 3_600_000;
  const sinceMs = Number.isFinite(sinceEpochSeconds) && sinceEpochSeconds > 0
    ? sinceEpochSeconds * 1000
    : oneHourAgo;
  // A reset epoch in the future is not active yet. Falling back to the normal
  // one-hour window keeps recent failures visible; clamping to `now` would
  // exclude every recorded failure and silently disable both secondary guards.
  const effectiveSince = sinceMs > nowMs ? oneHourAgo : sinceMs;
  return new Date(Math.max(oneHourAgo, effectiveSince));
}

export function initialKeyCapMonitorState(quotaDay: string): KeyCapMonitorState {
  return { quotaDay, capExceeded: 0, stopReason: null, stopAt: null };
}

/**
 * Reconcile a persisted monitor state with the current durable sample.
 *
 * - Different Pacific day: drop yesterday's stop/alert state. The new day's
 *   counter starts at zero, so yesterday's refusals cannot stop the pilot.
 * - Same day after a restart: keep an existing stop (never resume on a stale
 *   lower count) but do not rewrite the stop file.
 * - Same day, first stop: persist the reason and timestamp once.
 */
export function evaluateDurableKeyCapMonitorSample(
  previous: KeyCapMonitorState | null,
  sample: KeyCapStopSample & { quotaDay: string },
  now: Date = new Date(),
): KeyCapMonitorEvaluation {
  const quotaDay = String(sample.quotaDay || '');
  const sameDay = previous?.quotaDay === quotaDay;
  const base = sameDay && previous ? previous : initialKeyCapMonitorState(quotaDay);
  const capExceeded = Math.max(finiteCount(base.capExceeded), finiteCount(sample.capExceeded));
  const verdict = evaluateYouTubeKeyCapStopRule({ ...sample, capExceeded });

  if (base.stopReason) {
    // A stop already recorded for this day is sticky across restarts. If the
    // durable count somehow moved backwards, keep the stop rather than
    // silently resuming traffic.
    return {
      state: { ...base, capExceeded, stopReason: base.stopReason, stopAt: base.stopAt },
      verdict: { stop: true, reason: base.stopReason, detail: verdict.detail },
      shouldWriteStop: false,
    };
  }

  if (!verdict.stop) {
    return {
      state: { ...base, capExceeded, stopReason: null, stopAt: null },
      verdict,
      shouldWriteStop: false,
    };
  }

  const stopAt = now.toISOString();
  return {
    state: { quotaDay, capExceeded, stopReason: verdict.reason, stopAt },
    verdict,
    shouldWriteStop: true,
  };
}

const QUOTA_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const QUOTA_STOP_REASONS = new Set<KeyCapStopReason>([
  'CAP_EVENTS',
  'CAP_UNAVAILABLE',
  'QUOTA_EXHAUSTED',
]);

export interface KeyCapStopMarker {
  reason: string;
  detail: string;
  stoppedAt: string;
  quotaDay: string | null;
}

/**
 * Serialize a stop marker. The quota day is part of the marker so a new-day
 * healthy sample can distinguish yesterday's cap stop from a current stop
 * without guessing from the timestamp or deleting an unrelated health stop.
 */
export function formatKeyCapStopMarker(input: {
  reason: string;
  detail: string;
  at: Date;
  quotaDay?: string | null;
}): string {
  const quotaDay = input.quotaDay && QUOTA_DAY_PATTERN.test(input.quotaDay)
    ? input.quotaDay
    : 'unknown';
  return `STOP|${input.reason}|${input.detail}|${input.at.toISOString()}|quota_day=${quotaDay}\n`;
}

/**
 * Parse the fixed marker shape from the right so a detail containing `|`
 * cannot corrupt the quota day or timestamp. Legacy markers without a quota
 * day parse with `quotaDay: null` and are never auto-cleared.
 */
export function parseKeyCapStopMarker(content: string): KeyCapStopMarker | null {
  const line = String(content || '').trim();
  if (!line.startsWith('STOP|')) return null;
  const parts = line.split('|');
  if (parts.length < 5) return null;
  const quotaDayToken = parts[parts.length - 1] || '';
  if (!quotaDayToken.startsWith('quota_day=')) return null;
  const stoppedAt = parts[parts.length - 2] || '';
  const reason = parts[1] || '';
  const detail = parts.slice(2, -2).join('|');
  if (!reason || !stoppedAt) return null;
  return {
    reason,
    detail,
    stoppedAt,
    quotaDay: quotaDayToken.slice('quota_day='.length) || null,
  };
}

export function keyCapStopMarkerQuotaDay(content: string): string | null {
  return parseKeyCapStopMarker(content)?.quotaDay ?? null;
}

/**
 * Only a quota-day cap stop from an earlier day is stale at a new-day healthy
 * sample. Health, queue, monitor-availability, legacy, current-day, and
 * malformed markers stay in place so a real fail-closed signal is never
 * removed by inference.
 */
export function shouldClearPriorDayStopMarker(content: string, currentQuotaDay: string): boolean {
  const marker = parseKeyCapStopMarker(content);
  if (!marker || !marker.quotaDay) return false;
  if (!QUOTA_STOP_REASONS.has(marker.reason as KeyCapStopReason)) return false;
  if (!QUOTA_DAY_PATTERN.test(marker.quotaDay) || !QUOTA_DAY_PATTERN.test(currentQuotaDay)) return false;
  return marker.quotaDay < currentQuotaDay;
}

/**
 * A prior-day marker may only be retired by an enforcing sample that passed
 * every health and queue check. An alert-only or partially unhealthy sample
 * must leave the old fail-closed signal in place.
 */
export function shouldClearPriorDayStopMarkerForSample(input: {
  content: string;
  currentQuotaDay: string;
  alertOnly: boolean;
  sampleHealthy: boolean;
}): boolean {
  if (input.alertOnly || !input.sampleHealthy) return false;
  return shouldClearPriorDayStopMarker(input.content, input.currentQuotaDay);
}

/**
 * A stop only counts as already persisted when it belongs to the current
 * Pacific quota day. Yesterday's stop must not cause an alert-only sample to
 * retain today's newly evaluated stop and arm a later enforcing run.
 */
export function stopAlreadyPersistedForQuotaDay(
  state: KeyCapMonitorState | null,
  quotaDay: string,
): boolean {
  return state?.quotaDay === quotaDay && Boolean(state.stopReason);
}

/**
 * An alert-only observation must not arm enforcement. If a stop was already
 * persisted by an enforcing run, keep it; otherwise drop the stop fields from
 * the dedupe state while retaining the durable-count high-water mark.
 */
export function stateForAlertOnlySample(
  state: KeyCapMonitorState,
  stopAlreadyPersisted: boolean,
): KeyCapMonitorState {
  if (stopAlreadyPersisted) return state;
  return { ...state, stopReason: null, stopAt: null };
}

/** Whether an enforcing sample should (re)write the stop marker. */
export function shouldWriteStopMarker(input: {
  alertOnly: boolean;
  shouldWriteStop: boolean;
  markerQuotaDay: string | null;
  currentQuotaDay: string;
}): boolean {
  if (input.alertOnly) return false;
  return input.shouldWriteStop || input.markerQuotaDay !== input.currentQuotaDay;
}
