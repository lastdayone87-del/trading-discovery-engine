import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CAP_EVENT_STOP_THRESHOLD,
  CAP_UNAVAILABLE_STOP_THRESHOLD,
  QUOTA_EXHAUSTED_STOP_THRESHOLD,
  evaluateDurableKeyCapMonitorSample,
  evaluateYouTubeKeyCapStopRule,
  formatKeyCapStopMarker,
  initialKeyCapMonitorState,
  keyCapStopMarkerQuotaDay,
  monitorSecondaryWindowStart,
  parseKeyCapStopMarker,
  shouldClearPriorDayStopMarker,
  shouldClearPriorDayStopMarkerForSample,
  shouldWriteStopMarker,
  stateForAlertOnlySample,
  stopAlreadyPersistedForQuotaDay,
} from './youtubeKeyCapStopRule';

test('corrected stop rule counts both cap codes and keeps the unavailable guard', () => {
  assert.equal(CAP_EVENT_STOP_THRESHOLD, 500);
  assert.equal(CAP_UNAVAILABLE_STOP_THRESHOLD, 3);
  assert.equal(QUOTA_EXHAUSTED_STOP_THRESHOLD, 20);

  assert.equal(evaluateYouTubeKeyCapStopRule({ capExceeded: 0, capUnavailable: 0, quotaExhausted: 0 }).stop, false);
  assert.equal(evaluateYouTubeKeyCapStopRule({ capExceeded: 500, capUnavailable: 0, quotaExhausted: 0 }).stop, false);
  assert.equal(evaluateYouTubeKeyCapStopRule({ capExceeded: 501, capUnavailable: 0, quotaExhausted: 0 }).reason, 'CAP_EVENTS');
  assert.equal(evaluateYouTubeKeyCapStopRule({ capExceeded: 0, capUnavailable: 4, quotaExhausted: 0 }).reason, 'CAP_UNAVAILABLE');
  assert.equal(evaluateYouTubeKeyCapStopRule({ capExceeded: 0, capUnavailable: 3, quotaExhausted: 0 }).stop, false);
  assert.equal(evaluateYouTubeKeyCapStopRule({ capExceeded: 498, capUnavailable: 3, quotaExhausted: 0 }).reason, 'CAP_EVENTS');
  assert.equal(evaluateYouTubeKeyCapStopRule({ capExceeded: 497, capUnavailable: 3, quotaExhausted: 0 }).stop, false);
  assert.equal(evaluateYouTubeKeyCapStopRule({ capExceeded: 0, capUnavailable: 0, quotaExhausted: 21 }).reason, 'QUOTA_EXHAUSTED');
  assert.equal(evaluateYouTubeKeyCapStopRule({ capExceeded: 0, capUnavailable: 0, quotaExhausted: 20 }).stop, false);
});

test('durable counter survives log rotation: zero log-derived unavailable does not hide a cap storm', () => {
  // Log rotation deleted the lines that used to carry the refusal count. The
  // durable counter is still 501, so the monitor stops on the event threshold.
  const verdict = evaluateYouTubeKeyCapStopRule({ capExceeded: 501, capUnavailable: 0, quotaExhausted: 0 });
  assert.equal(verdict.stop, true);
  assert.equal(verdict.reason, 'CAP_EVENTS');
  assert.match(verdict.detail, /cap_exceeded=501/);
});

test('restart before a stop re-reads the durable total instead of a checkpoint', () => {
  const day = '2026-10-26';
  const first = evaluateDurableKeyCapMonitorSample(
    initialKeyCapMonitorState(day),
    { quotaDay: day, capExceeded: 300, capUnavailable: 0, quotaExhausted: 0 },
    new Date('2026-10-26T08:00:00.000Z'),
  );
  assert.equal(first.verdict.stop, false);
  assert.equal(first.state.capExceeded, 300);

  // Process restarts. The caller reloads state from disk, but the authoritative
  // count comes from the durable counter again.
  const restarted = evaluateDurableKeyCapMonitorSample(
    first.state,
    { quotaDay: day, capExceeded: 501, capUnavailable: 0, quotaExhausted: 0 },
    new Date('2026-10-26T08:01:00.000Z'),
  );
  assert.equal(restarted.verdict.stop, true);
  assert.equal(restarted.verdict.reason, 'CAP_EVENTS');
  assert.equal(restarted.shouldWriteStop, true);
  assert.equal(restarted.state.stopReason, 'CAP_EVENTS');
  assert.equal(restarted.state.stopAt, '2026-10-26T08:01:00.000Z');
});

test('restart after a stop is idempotent and does not rewrite the stop file', () => {
  const day = '2026-10-26';
  const stopped = evaluateDurableKeyCapMonitorSample(
    initialKeyCapMonitorState(day),
    { quotaDay: day, capExceeded: 501, capUnavailable: 0, quotaExhausted: 0 },
    new Date('2026-10-26T08:01:00.000Z'),
  );
  const restarted = evaluateDurableKeyCapMonitorSample(
    stopped.state,
    { quotaDay: day, capExceeded: 501, capUnavailable: 0, quotaExhausted: 0 },
    new Date('2026-10-26T08:05:00.000Z'),
  );
  assert.equal(restarted.verdict.stop, true);
  assert.equal(restarted.shouldWriteStop, false);
  assert.equal(restarted.state.stopAt, '2026-10-26T08:01:00.000Z');

  // Even a backwards counter read must not resume traffic on the same day.
  const backwards = evaluateDurableKeyCapMonitorSample(
    stopped.state,
    { quotaDay: day, capExceeded: 0, capUnavailable: 0, quotaExhausted: 0 },
    new Date('2026-10-26T08:06:00.000Z'),
  );
  assert.equal(backwards.verdict.stop, true);
  assert.equal(backwards.state.capExceeded, 501);
});

test('Pacific quota reset starts a new day at zero and clears yesterday stop state', () => {
  const previous = {
    quotaDay: '2026-10-25',
    capExceeded: 900,
    stopReason: 'CAP_EVENTS' as const,
    stopAt: '2026-10-25T20:00:00.000Z',
  };
  const reset = evaluateDurableKeyCapMonitorSample(
    previous,
    { quotaDay: '2026-10-26', capExceeded: 0, capUnavailable: 0, quotaExhausted: 0 },
    new Date('2026-10-26T07:00:00.000Z'),
  );
  assert.equal(reset.verdict.stop, false);
  assert.equal(reset.shouldWriteStop, false);
  assert.deepEqual(reset.state, { quotaDay: '2026-10-26', capExceeded: 0, stopReason: null, stopAt: null });

  // The new day can independently cross the threshold.
  const newDayStop = evaluateDurableKeyCapMonitorSample(
    reset.state,
    { quotaDay: '2026-10-26', capExceeded: 501, capUnavailable: 0, quotaExhausted: 0 },
    new Date('2026-10-26T09:00:00.000Z'),
  );
  assert.equal(newDayStop.verdict.stop, true);
  assert.equal(newDayStop.shouldWriteStop, true);
});

test('secondary-signal window honors the quota-reset epoch and the one-hour floor', () => {
  const now = Date.parse('2026-10-26T07:05:00.000Z');
  // Reset at 07:00Z: the first post-reset sample counts only post-reset events.
  assert.equal(monitorSecondaryWindowStart(now, 1792998000).toISOString(), '2026-10-26T07:00:00.000Z');
  // An older epoch cannot widen the window beyond one hour.
  assert.equal(monitorSecondaryWindowStart(now, 1792990000).toISOString(), '2026-10-26T06:05:00.000Z');
  // Absent/invalid epoch falls back to the normal one-hour window.
  assert.equal(monitorSecondaryWindowStart(now, 0).toISOString(), '2026-10-26T06:05:00.000Z');
  assert.equal(monitorSecondaryWindowStart(now, Number.NaN).toISOString(), '2026-10-26T06:05:00.000Z');
  // A future epoch is not active yet: keep the ordinary one-hour window so
  // recent failures remain visible instead of excluding every event.
  assert.equal(monitorSecondaryWindowStart(now, 1792998000 + 3600).toISOString(), '2026-10-26T06:05:00.000Z');

  // The fixed epoch describes the first reset only. A later Pacific day must
  // also be bounded by that day's start, not just the one-hour window.
  const nextDayNow = Date.parse('2026-10-27T07:05:00.000Z');
  const nextDayStart = Date.parse('2026-10-27T07:00:00.000Z');
  assert.equal(
    monitorSecondaryWindowStart(nextDayNow, 1792998000, nextDayStart).toISOString(),
    '2026-10-27T07:00:00.000Z',
  );
  // Before the reset the current day's start is older than the one-hour floor.
  assert.equal(
    monitorSecondaryWindowStart(now, 1792998000, Date.parse('2026-10-26T07:00:00.000Z')).toISOString(),
    '2026-10-26T07:00:00.000Z',
  );
});

test('stop markers carry the quota day and only stale quota stops auto-clear', () => {
  const marker = formatKeyCapStopMarker({
    reason: 'CAP_EVENTS',
    detail: 'cap_exceeded=501|combined=501',
    at: new Date('2026-10-25T20:00:00.000Z'),
    quotaDay: '2026-10-25',
  });
  assert.match(marker, /^STOP\|CAP_EVENTS\|/);
  const parsed = parseKeyCapStopMarker(marker);
  assert.deepEqual(parsed, {
    reason: 'CAP_EVENTS',
    detail: 'cap_exceeded=501|combined=501',
    stoppedAt: '2026-10-25T20:00:00.000Z',
    quotaDay: '2026-10-25',
  });
  assert.equal(keyCapStopMarkerQuotaDay(marker), '2026-10-25');
  assert.equal(shouldClearPriorDayStopMarker(marker, '2026-10-26'), true);
  assert.equal(shouldClearPriorDayStopMarker(marker, '2026-10-25'), false);
  assert.equal(shouldClearPriorDayStopMarker(marker, '2026-10-24'), false);

  for (const reason of ['HEALTH_FAILURE', 'QUEUE_GROWTH', 'MONITOR_UNAVAILABLE']) {
    const nonQuota = formatKeyCapStopMarker({
      reason,
      detail: 'detail',
      at: new Date('2026-10-25T20:00:00.000Z'),
      quotaDay: '2026-10-25',
    });
    assert.equal(shouldClearPriorDayStopMarker(nonQuota, '2026-10-26'), false, reason);
  }

  // Legacy markers without a day are never auto-cleared; an operator must
  // inspect them rather than letting a new day erase a fail-closed signal.
  assert.equal(shouldClearPriorDayStopMarker('STOP|CAP_EVENTS|detail|2026-10-25T20:00:00.000Z', '2026-10-26'), false);
  assert.equal(shouldClearPriorDayStopMarker('not-a-stop', '2026-10-26'), false);
});

test('only a healthy enforcing sample retires a prior-day stop marker', () => {
  const marker = formatKeyCapStopMarker({
    reason: 'CAP_EVENTS',
    detail: 'cap_exceeded=501',
    at: new Date('2026-10-25T20:00:00.000Z'),
    quotaDay: '2026-10-25',
  });
  const base = {
    content: marker,
    currentQuotaDay: '2026-10-26',
    alertOnly: false,
    sampleHealthy: true,
  };
  assert.equal(shouldClearPriorDayStopMarkerForSample(base), true);
  assert.equal(shouldClearPriorDayStopMarkerForSample({ ...base, alertOnly: true }), false);
  assert.equal(shouldClearPriorDayStopMarkerForSample({ ...base, sampleHealthy: false }), false);
  assert.equal(
    shouldClearPriorDayStopMarkerForSample({ ...base, currentQuotaDay: '2026-10-25' }),
    false,
  );
});

test('only a current-day stop counts as already persisted', () => {
  const today = initialKeyCapMonitorState('2026-10-26');
  today.stopReason = 'CAP_EVENTS';
  assert.equal(stopAlreadyPersistedForQuotaDay(today, '2026-10-26'), true);
  assert.equal(stopAlreadyPersistedForQuotaDay({ ...today, quotaDay: '2026-10-25' }, '2026-10-26'), false);
  assert.equal(stopAlreadyPersistedForQuotaDay({ ...today, stopReason: null }, '2026-10-26'), false);
  assert.equal(stopAlreadyPersistedForQuotaDay(null, '2026-10-26'), false);
});

test('alert-only state never arms a later enforcing run', () => {
  const stopped = evaluateDurableKeyCapMonitorSample(
    initialKeyCapMonitorState('2026-10-26'),
    { quotaDay: '2026-10-26', capExceeded: 501, capUnavailable: 0, quotaExhausted: 0 },
    new Date('2026-10-26T08:00:00.000Z'),
  );
  const alertState = stateForAlertOnlySample(stopped.state, false);
  assert.equal(alertState.stopReason, null);
  assert.equal(alertState.stopAt, null);
  assert.equal(alertState.capExceeded, 501);
  const preserved = stateForAlertOnlySample(stopped.state, true);
  assert.equal(preserved.stopReason, 'CAP_EVENTS');
});

test('stop marker write policy suppresses alert-only and refreshes stale markers', () => {
  assert.equal(shouldWriteStopMarker({
    alertOnly: true,
    shouldWriteStop: true,
    markerQuotaDay: null,
    currentQuotaDay: '2026-10-26',
  }), false);
  assert.equal(shouldWriteStopMarker({
    alertOnly: false,
    shouldWriteStop: true,
    markerQuotaDay: '2026-10-26',
    currentQuotaDay: '2026-10-26',
  }), true);
  assert.equal(shouldWriteStopMarker({
    alertOnly: false,
    shouldWriteStop: false,
    markerQuotaDay: '2026-10-25',
    currentQuotaDay: '2026-10-26',
  }), true);
  assert.equal(shouldWriteStopMarker({
    alertOnly: false,
    shouldWriteStop: false,
    markerQuotaDay: '2026-10-26',
    currentQuotaDay: '2026-10-26',
  }), false);
});
