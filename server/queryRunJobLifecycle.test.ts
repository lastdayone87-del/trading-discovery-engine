import assert from 'node:assert/strict';
import test from 'node:test';
import { decideQueryRunJobLifecycle } from './queryRunJobLifecycle';

test('pending scheduled retry aligns an active query run without releasing its reservation', () => {
  assert.deepEqual(decideQueryRunJobLifecycle({
    queryRunStatus: 'RUNNING',
    jobStatus: 'PENDING',
    jobLastError: 'OPERATIONALLY_BLOCKED_RETRY_REQUIRED: provider cooldown',
    jobRunAfter: '2026-08-23T08:00:00.000Z',
    jobCompletedAt: null
  }), {
    action: 'ALIGN_RETRY_WAIT',
    queryRunStatus: 'RETRYING',
    releaseReservation: false,
    reasonCode: 'RETRY_WAIT_OWNERSHIP_ALIGNED'
  });
});

test('processing job remains the sole active owner and is not rewritten', () => {
  assert.deepEqual(decideQueryRunJobLifecycle({
    queryRunStatus: 'SCHEDULED',
    jobStatus: 'PROCESSING',
    jobLastError: null,
    jobRunAfter: null,
    jobCompletedAt: null
  }), {
    action: 'NOOP',
    queryRunStatus: 'SCHEDULED',
    releaseReservation: false,
    reasonCode: 'ACTIVE_JOB_OWNS_QUERY_RUN'
  });
});

test('failed job status is terminal even when an old error says retry was intended', () => {
  assert.deepEqual(decideQueryRunJobLifecycle({
    queryRunStatus: 'RUNNING',
    jobStatus: 'FAILED',
    jobLastError: 'OPERATIONALLY_BLOCKED_RETRY_REQUIRED: provider cooldown',
    jobRunAfter: '2026-08-23T02:28:01.741Z',
    jobCompletedAt: null
  }), {
    action: 'TERMINALIZE_QUERY_RUN',
    queryRunStatus: 'FAILED',
    releaseReservation: true,
    reasonCode: 'FAILED_JOB_STATUS_IS_TERMINAL'
  });
});

test('retry exhaustion remains terminal and releases the active run reservation', () => {
  assert.deepEqual(decideQueryRunJobLifecycle({
    queryRunStatus: 'RETRYING',
    jobStatus: 'FAILED',
    jobLastError: 'provider retry exhausted',
    jobRunAfter: null,
    jobCompletedAt: null
  }), {
    action: 'TERMINALIZE_QUERY_RUN',
    queryRunStatus: 'FAILED',
    releaseReservation: true,
    reasonCode: 'FAILED_JOB_STATUS_IS_TERMINAL'
  });
});

test('completed query runs are never reopened by lifecycle reconciliation', () => {
  assert.deepEqual(decideQueryRunJobLifecycle({
    queryRunStatus: 'COMPLETED',
    jobStatus: 'FAILED',
    jobLastError: 'old failure',
    jobRunAfter: null,
    jobCompletedAt: null
  }), {
    action: 'NOOP',
    queryRunStatus: 'COMPLETED',
    releaseReservation: false,
    reasonCode: 'QUERY_RUN_NOT_ACTIVE'
  });
});

test('a pending retry without a persisted retry marker is not promoted to retry ownership', () => {
  assert.deepEqual(decideQueryRunJobLifecycle({
    queryRunStatus: 'RUNNING',
    jobStatus: 'PENDING',
    jobLastError: null,
    jobRunAfter: '2026-08-23T08:00:00.000Z',
    jobCompletedAt: null
  }), {
    action: 'NOOP',
    queryRunStatus: 'RUNNING',
    releaseReservation: false,
    reasonCode: 'ACTIVE_JOB_OWNS_QUERY_RUN'
  });
});
