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
