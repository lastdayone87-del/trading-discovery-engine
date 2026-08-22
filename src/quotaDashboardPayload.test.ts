import test from 'node:test';
import assert from 'node:assert/strict';
import { nextPacificQuotaResetAt, normalizeQueueStatusForDashboard } from './apiClient';

test('quota dashboard preserves durable per-key usage and remaining quota', () => {
  const payload = normalizeQueueStatusForDashboard({
    queues: {},
    quota: {
      unitsUsed: 18240,
      dailyLimit: 20000,
      lastReset: '2026-08-15',
      totalKeys: 2,
      keyUsage: [
        { keyIndex: 1, unitsUsed: 8240, remaining: 1760, limit: 10000, status: 'Active' },
        { keyIndex: 2, unitsUsed: 10000, remaining: 0, limit: 10000, status: 'Cooling Down' }
      ]
    }
  });
  assert.equal(payload.quota.unitsUsed, 18240);
  assert.equal(payload.quota.dailyLimit, 20000);
  assert.equal(payload.quota.keyUsage[0].unitsUsed, 8240);
  assert.equal(payload.quota.keyUsage[0].remaining, 1760);
  assert.equal(payload.quota.keyUsage[0].limit, 10000);
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
