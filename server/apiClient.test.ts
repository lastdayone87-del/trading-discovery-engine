import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeQueueStatusForDashboard } from '../src/apiClient';

test('queue status normalization supplies safe defaults for missing community admission diagnostics', () => {
  const normalized = normalizeQueueStatusForDashboard({
    queues: {
      searchJobs: { depth: 1, isPaused: false },
      channelProcessing: { depth: 2, isPaused: false },
      discordValidation: { depth: 0, isPaused: false },
    },
  });

  assert.deepEqual(normalized.queues.communityRetry, {
    duePending: 0,
    dueBrowserBlocked: 0,
    dueReconciliationBlocked: 0,
    dueClaimable: 0,
    processing: 0,
    staleProcessing: 0,
    oldestDueAt: null,
    oldestProcessingAt: null,
  });
});

test('queue status normalization preserves backend community admission diagnostics', () => {
  const normalized = normalizeQueueStatusForDashboard({
    queues: {
      communityRetry: {
        duePending: 16,
        dueBrowserBlocked: 12,
        dueReconciliationBlocked: 1,
        dueClaimable: 3,
        processing: 2,
        staleProcessing: 1,
        oldestDueAt: '2026-08-27T12:04:30.000Z',
        oldestProcessingAt: '2026-08-27T11:50:00.000Z',
      },
    },
  });

  assert.deepEqual(normalized.queues.communityRetry, {
    duePending: 16,
    dueBrowserBlocked: 12,
    dueReconciliationBlocked: 1,
    dueClaimable: 3,
    processing: 2,
    staleProcessing: 1,
    oldestDueAt: '2026-08-27T12:04:30.000Z',
    oldestProcessingAt: '2026-08-27T11:50:00.000Z',
  });
});

