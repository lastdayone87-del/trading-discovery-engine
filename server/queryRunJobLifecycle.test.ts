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

test('a deferred run keeps ownership of its completed page job', () => {
  for (const continuationStatus of ['DEFERRED_QUOTA', 'DEFERRED_TIME']) {
    assert.deepEqual(decideQueryRunJobLifecycle({
      queryRunStatus: 'RUNNING',
      jobStatus: 'COMPLETED',
      jobLastError: null,
      jobRunAfter: null,
      jobCompletedAt: '2026-08-23T08:00:00.000Z',
      now: '2026-08-23T09:00:00.000Z',
      continuationStatus,
      deferredUntil: '2026-08-23T10:00:00.000Z',
    }), {
      action: 'NOOP',
      queryRunStatus: 'RUNNING',
      releaseReservation: false,
      reasonCode: 'DEFERRED_RUN_WAITING_FOR_RESUME',
    });
  }
  assert.deepEqual(decideQueryRunJobLifecycle({
    queryRunStatus: 'RUNNING',
    jobStatus: 'COMPLETED',
    jobLastError: null,
    jobRunAfter: null,
    jobCompletedAt: '2026-08-23T08:00:00.000Z',
    now: '2026-08-23T11:00:00.000Z',
    continuationStatus: 'DEFERRED_QUOTA',
    deferredUntil: '2026-08-23T10:00:00.000Z',
  }), {
    action: 'NOOP',
    queryRunStatus: 'RUNNING',
    releaseReservation: false,
    reasonCode: 'DEFERRED_RUN_READY_FOR_RESUME',
  });
});

test('a live later-page job protects the run from terminal completed/failed links', () => {
  for (const jobStatus of ['COMPLETED', 'FAILED'] as const) {
    assert.deepEqual(decideQueryRunJobLifecycle({
      queryRunStatus: 'RUNNING',
      jobStatus,
      jobLastError: null,
      jobRunAfter: null,
      jobCompletedAt: '2026-08-23T08:00:00.000Z',
      now: '2026-08-23T09:00:00.000Z',
      hasLivePageJob: true,
    }), {
      action: 'NOOP',
      queryRunStatus: 'RUNNING',
      releaseReservation: false,
      reasonCode: 'LIVE_PAGE_JOB_OWNS_QUERY_RUN',
    });
  }
});

test('a completed job inside the finalization grace window leaves the run active', () => {
  assert.deepEqual(decideQueryRunJobLifecycle({
    queryRunStatus: 'RUNNING',
    jobStatus: 'COMPLETED',
    jobLastError: null,
    jobRunAfter: null,
    jobCompletedAt: '2026-08-23T08:00:00.000Z',
    now: '2026-08-23T08:05:00.000Z',
    completedJobGraceMinutes: 15
  }), {
    action: 'NOOP',
    queryRunStatus: 'RUNNING',
    releaseReservation: false,
    reasonCode: 'COMPLETED_JOB_FINALIZATION_GRACE'
  });
});

test('a completed job past the grace window closes its orphaned active run', () => {
  assert.deepEqual(decideQueryRunJobLifecycle({
    queryRunStatus: 'RUNNING',
    jobStatus: 'COMPLETED',
    jobLastError: null,
    jobRunAfter: null,
    jobCompletedAt: '2026-08-23T08:00:00.000Z',
    now: '2026-08-23T08:16:00.000Z',
    completedJobGraceMinutes: 15
  }), {
    action: 'TERMINALIZE_QUERY_RUN',
    queryRunStatus: 'FAILED',
    releaseReservation: true,
    reasonCode: 'ORPHANED_COMPLETED_JOB_STATE'
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
