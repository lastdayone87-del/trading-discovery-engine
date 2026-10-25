import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CAP_EVENT_STOP_THRESHOLD,
  CAP_UNAVAILABLE_STOP_THRESHOLD,
  QUOTA_EXHAUSTED_STOP_THRESHOLD,
  evaluateDurableKeyCapMonitorSample,
  evaluateYouTubeKeyCapStopRule,
  initialKeyCapMonitorState,
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
