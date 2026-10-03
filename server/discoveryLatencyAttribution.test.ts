import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRecoveredStaleJobs } from './dbCore';
import { buildSearchLatencyBreakdownMs } from './queueManager';

test('stale recovery summary groups by type and tracks the oldest stuck lock', () => {
  const now = Date.now();
  const summary = summarizeRecoveredStaleJobs([
    { type: 'SEARCH_YOUTUBE', locked_at: new Date(now - 3_600_000).toISOString() },
    { type: 'SEARCH_YOUTUBE', locked_at: new Date(now - 1_800_000).toISOString() },
    { type: 'ENRICH_CHANNEL', locked_at: new Date(now - 900_000).toISOString() },
  ], now);
  assert.equal(summary.recovered, 3);
  assert.deepEqual(summary.byType, { SEARCH_YOUTUBE: 2, ENRICH_CHANNEL: 1 });
  assert.equal(summary.oldestStuckMs, 3_600_000);
});

test('stale recovery summary tolerates missing lock metadata', () => {
  const summary = summarizeRecoveredStaleJobs([{}, { type: null }], Date.now());
  assert.equal(summary.recovered, 2);
  assert.deepEqual(summary.byType, { UNKNOWN: 2 });
  assert.equal(summary.oldestStuckMs, 0);
});

test('SEARCH latency breakdown separates quota-wait, retrieval, and processing', () => {
  const breakdown = buildSearchLatencyBreakdownMs(1000, 200, 3000, 5000, 8000, 9000);
  assert.deepEqual(breakdown, {
    workerTotalMs: 8000,
    quotaWaitMs: 200,
    retrievalMs: 3000,
    channelProcessingMs: 3000
  });
});

test('channel processing ends at loop end, not at post-loop accounting', () => {
  // Post-loop work (query-performance evaluation, sightings persistence)
  // must not inflate channelProcessingMs; workerTotalMs still covers it.
  const breakdown = buildSearchLatencyBreakdownMs(0, 0, 0, 1000, 2000, 9000);
  assert.equal(breakdown.channelProcessingMs, 1000);
  assert.equal(breakdown.workerTotalMs, 9000);
});
