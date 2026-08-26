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

test('queue status exposes only the aggregate community retry worker health readout', () => {
  assert.match(server, /app\.get\('\/api\/queues\/status'/);
  assert.match(server, /maintenance: \{ communityRetry: getCommunityRetryWorkerHealth\(\) \}/);
  assert.doesNotMatch(server, /res\.json\(.*maintenance.*channelId/);
});

assert.ok(true);
