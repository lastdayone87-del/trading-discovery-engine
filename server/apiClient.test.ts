import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeQueueStatusForDashboard, newRequestId, apiFetch } from '../src/apiClient';

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

test('newRequestId uses crypto.randomUUID when available (secure contexts)', () => {
  const cryptoRef = globalThis.crypto as any;
  const orig = cryptoRef.randomUUID;
  cryptoRef.randomUUID = () => 'sentinel-uuid-for-test';
  try {
    assert.equal(newRequestId(), 'sentinel-uuid-for-test');
  } finally {
    cryptoRef.randomUUID = orig;
  }
});

test('newRequestId falls back without throwing when crypto.randomUUID is unavailable (plain HTTP)', () => {
  const cryptoRef = globalThis.crypto as any;
  const orig = cryptoRef.randomUUID;
  cryptoRef.randomUUID = undefined;
  try {
    const first = newRequestId();
    const second = newRequestId();
    assert.equal(typeof first, 'string');
    assert.ok(first.length > 0);
    assert.notEqual(first, second);
  } finally {
    cryptoRef.randomUUID = orig;
  }
});

test('apiFetch sends the request with an X-Request-Id when crypto.randomUUID is unavailable', async () => {
  const cryptoRef = globalThis.crypto as any;
  const origRandomUUID = cryptoRef.randomUUID;
  cryptoRef.randomUUID = undefined;
  const g = globalThis as any;
  const origLocalStorage = g.localStorage;
  const origWindow = g.window;
  const origFetch = g.fetch;
  g.localStorage = { getItem: () => null };
  g.window = { dispatchEvent: () => true };
  let sentRequestId: string | null = null;
  g.fetch = async (input: any, init?: any) => {
    sentRequestId = new Headers(init?.headers).get('X-Request-Id');
    return new Response(JSON.stringify({ items: [], total: 0, revision: null }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const response = await apiFetch('/api/channels?limit=1');
    assert.equal(response.status, 200);
    assert.ok(sentRequestId && sentRequestId.length > 0);
    assert.deepEqual(await response.json(), { items: [], total: 0, revision: null });
  } finally {
    cryptoRef.randomUUID = origRandomUUID;
    if (origLocalStorage === undefined) delete g.localStorage; else g.localStorage = origLocalStorage;
    if (origWindow === undefined) delete g.window; else g.window = origWindow;
    g.fetch = origFetch;
  }
});

