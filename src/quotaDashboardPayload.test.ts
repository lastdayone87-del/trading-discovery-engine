import test from 'node:test';
import assert from 'node:assert/strict';
import { nextPacificQuotaResetAt, normalizeQueueStatusForDashboard } from './apiClient';

test('quota dashboard does not invent per-key consumption from the aggregate ledger', () => {
  const payload = normalizeQueueStatusForDashboard({
    queues: {},
    quota: {
      unitsUsed: 161535,
      dailyLimit: 120000,
      lastReset: '2026-08-15',
      totalKeys: 12,
      keyUsage: [
        { keyIndex: 1, unitsUsed: 10000, limit: 10000, status: 'Active' },
        { keyIndex: 2, unitsUsed: 10000, limit: 10000, status: 'Cooling Down' }
      ]
    }
  });
  assert.equal(payload.quota.unitsUsed, 161535);
  assert.equal(payload.quota.dailyLimit, 120000);
  assert.equal(payload.quota.keyUsage[0].unitsUsed, '—');
  assert.equal(payload.quota.keyUsage[0].limit, 'not tracked');
  assert.equal(payload.quota.keyUsage[1].status, 'Cooling Down');
});

test('quota-day identifier resolves to the next Pacific midnight instant', () => {
  const reset = nextPacificQuotaResetAt('2026-08-15');
  assert.ok(reset);
  assert.equal(reset!.toISOString(), '2026-08-16T07:00:00.000Z');
});

test('dashboard reset display is explicitly the next reset rather than the quota-day date', () => {
  const payload = normalizeQueueStatusForDashboard({ quota: { lastReset: '2026-08-15', keyUsage: [] } });
  assert.match(payload.quota.lastReset, /^next /);
  assert.notEqual(payload.quota.lastReset, '2026-08-15');
});
