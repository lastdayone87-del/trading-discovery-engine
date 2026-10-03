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

test('latency buckets are disjoint across quota, retrieval, and processing spans', () => {
  const breakdown = buildSearchLatencyBreakdownMs(1000, 200, 3000, 500, 5000, 8000, 9000);
  assert.deepEqual(breakdown, {
    workerTotalMs: 8000,
    quotaWaitMs: 700,
    retrievalMs: 2500,
    channelProcessingMs: 3000
  });
});

test('channel processing ends at loop end, not at post-loop accounting', () => {
  // Pure-function check: the loop-end timestamp bounds channelProcessingMs
  // while workerTotalMs still covers post-loop work. Capture placement in
  // the worker is guarded by the source-order assertion below.
  const breakdown = buildSearchLatencyBreakdownMs(0, 0, 0, 0, 1000, 2000, 9000);
  assert.equal(breakdown.channelProcessingMs, 1000);
  assert.equal(breakdown.workerTotalMs, 9000);
});

test('loop-end capture precedes post-loop accounting in the SEARCH worker', async () => {
  const fs = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const source = fs.readFileSync(fileURLToPath(new URL('./queueManager.ts', import.meta.url)), 'utf8');
  const captureIdx = source.indexOf('const channelLoopEndMs = Date.now();');
  assert.ok(captureIdx >= 0, 'loop-end capture exists');
  assert.ok(source.indexOf('recordQueryRunSightings(queryRunId', captureIdx) > captureIdx, 'capture precedes sightings persistence');
  assert.ok(source.indexOf('calculateQueryFunnel(', captureIdx) > captureIdx, 'capture precedes funnel evaluation');
});

test('nested top-up waits are not double-counted in retrieval', () => {
  const breakdown = buildSearchLatencyBreakdownMs(0, 100, 1000, 300, 0, 0, 2000);
  assert.equal(breakdown.quotaWaitMs, 400);
  assert.equal(breakdown.retrievalMs, 700);
  assert.equal(buildSearchLatencyBreakdownMs(0, 0, 100, 500, 0, 0, 1000).retrievalMs, 0);
});
