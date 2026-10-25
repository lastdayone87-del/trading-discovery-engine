import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workers = readFileSync(new URL('./operationalMaintenanceWorkers.ts', import.meta.url), 'utf8');
const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');

test('community retry worker reports aggregate health without exposing job or channel data', () => {
  assert.match(workers, /getCommunityRetryWorkerHealth/);
  assert.match(workers, /ticks: number/);
  assert.match(workers, /claimed: number/);
  assert.match(workers, /noWork: number/);
  assert.match(workers, /errors: number/);
  assert.doesNotMatch(workers, /channelId.*health|jobId.*health/);
});

test('community retry worker remains a one-second continuously scheduled consumer', () => {
  assert.match(workers, /processNextSearchJob\(COMMUNITY_RETRY_TYPES, workerId\)/);
  assert.match(workers, /schedule\(tick, 1000\)/);
});

test('queue status exposes only aggregate worker health readouts', () => {
  assert.match(server, /app\.get\('\/api\/queues\/status'/);
  assert.match(server, /communityRetry: getCommunityRetryWorkerHealth\(\)/);
  assert.match(server, /operational: getOperationalMaintenanceSchedulerHealth\(\)/);
  assert.doesNotMatch(server, /res\.json\(.*maintenance.*channelId/);
});

assert.ok(true);

test('retry worker reacquires instead of borrowing its own incomplete coverage', () => {
  const qm = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
  // The RETRY branch constructs the marker with the retry-owned flag...
  assert.match(qm, /isRetryOwnedReacquire:true/);
  // ...and the inspection call maps the marker through the resolver, so a
  // rename or disconnect on either side fails this test.
  assert.match(qm, /bypassBorrowedCoverage: resolveBorrowBypassForInspectionMarker\(executionMarker\)/);
});

test('borrow bypass resolves only for explicit retry-owned markers', async () => {
  const { resolveBorrowBypassForInspectionMarker } = await import('./queueManager');
  assert.equal(resolveBorrowBypassForInspectionMarker({ isRetryOwnedReacquire: true }), true);
  assert.equal(resolveBorrowBypassForInspectionMarker({ isRetryOwnedReacquire: false }), false);
  assert.equal(resolveBorrowBypassForInspectionMarker({}), false);
  assert.equal(resolveBorrowBypassForInspectionMarker(undefined), false);
});
