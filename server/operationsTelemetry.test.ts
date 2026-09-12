import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bumpGate1Evaluation,
  bumpInvalidApiKeyQuarantine,
  bumpJobFailureDisposition,
  bumpRepeatFailureHistoryOutage,
  bumpRepeatFailureSkip,
  jobDispositionExecutionKey,
  markJobDispositionCounted,
  operationsTelemetrySnapshot,
  resetOperationsTelemetry,
} from './operationsTelemetry';

test('telemetry starts at zero and bumps per disposition', () => {
  resetOperationsTelemetry();
  bumpGate1Evaluation('REJECT_EXCLUDED');
  bumpGate1Evaluation('ALLOW_NORMAL');
  bumpGate1Evaluation('CONTINUE_CRAWLING');
  bumpGate1Evaluation('NEEDS_REVIEW');
  bumpGate1Evaluation('SOMETHING_ELSE');
  bumpRepeatFailureSkip(2);
  bumpRepeatFailureHistoryOutage();
  bumpJobFailureDisposition('FAILED');
  bumpJobFailureDisposition('RETRYING');
  bumpJobFailureDisposition('RETRYING_WITHOUT_ATTEMPT');
  bumpJobFailureDisposition('BOGUS');
  bumpInvalidApiKeyQuarantine();
  const snap = operationsTelemetrySnapshot();
  assert.deepEqual(snap.gate1EvaluationsTotal, {
    REJECT_EXCLUDED: 1,
    ALLOW_NORMAL: 1,
    CONTINUE_CRAWLING: 1,
    NEEDS_REVIEW: 1,
    UNKNOWN: 1,
  });
  assert.equal(snap.repeatFailureSkipsTotal, 2);
  assert.equal(snap.repeatFailureHistoryOutagesTotal, 1);
  assert.deepEqual(snap.jobFailureDispositionsTotal, {
    FAILED: 1,
    RETRYING: 1,
    RETRYING_WITHOUT_ATTEMPT: 1,
    UNKNOWN: 1,
  });
  assert.equal(snap.invalidApiKeyQuarantinesTotal, 1);
});

test('telemetry snapshots are copies and ignore non-positive skip counts', () => {
  resetOperationsTelemetry();
  bumpRepeatFailureSkip(0);
  bumpRepeatFailureSkip(-3);
  bumpRepeatFailureSkip(Number.NaN);
  const snap = operationsTelemetrySnapshot();
  assert.equal(snap.repeatFailureSkipsTotal, 0);
  snap.gate1EvaluationsTotal.ALLOW_NORMAL = 999;
  assert.equal(operationsTelemetrySnapshot().gate1EvaluationsTotal.ALLOW_NORMAL, 0);
});

test('repeated failJob transitions for one execution count exactly once', () => {
  const key = jobDispositionExecutionKey('attempt-row-1', 'job-1', 2);
  assert.equal(markJobDispositionCounted(key, 'FAILED'), true);
  assert.equal(markJobDispositionCounted(key, 'FAILED'), false);
});

test('attempt-free deferrals count every distinct claim execution', () => {
  // RETRYING_WITHOUT_ATTEMPT decrements the attempt counter, so the next claim
  // reuses the same attempt number with a NEW job_attempts row: each must count.
  assert.equal(markJobDispositionCounted(jobDispositionExecutionKey('row-a', 'job-1', 2), 'RETRYING_WITHOUT_ATTEMPT'), true);
  assert.equal(markJobDispositionCounted(jobDispositionExecutionKey('row-b', 'job-1', 2), 'RETRYING_WITHOUT_ATTEMPT'), true);
});

test('missing attempt rows fall back to a job+attempt key', () => {
  const fallback = jobDispositionExecutionKey(null, 'job-9', 4);
  assert.equal(markJobDispositionCounted(fallback, 'FAILED'), true);
  assert.equal(markJobDispositionCounted(fallback, 'FAILED'), false);
  assert.equal(markJobDispositionCounted(jobDispositionExecutionKey(undefined, 'job-9', 5), 'FAILED'), true);
});
