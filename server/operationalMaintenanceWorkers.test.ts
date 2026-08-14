import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workers = readFileSync(new URL('./operationalMaintenanceWorkers.ts', import.meta.url), 'utf8');
const startup = readFileSync(new URL('./startupLifecycle.ts', import.meta.url), 'utf8');

test('operational retry and rescan job types have a dedicated consumer', () => {
  assert.match(workers, /'POST_APPROVAL_ENRICH'/);
  assert.match(workers, /'FORCE_REVIEW_RESCAN'/);
  assert.match(workers, /'RETRY_COMMUNITY_ACQUISITION'/);
  assert.match(workers, /processNextSearchJob\(OPERATIONAL_JOB_TYPES, workerId\)/);
  assert.match(workers, /OPERATIONAL_MAINTENANCE_WORKER_CONCURRENCY/);
  assert.match(workers, /Math\.min\(5/);
});

test('operational worker starts only after database readiness in server runtime', () => {
  assert.match(startup, /if \(isServerRuntime\(\)\) startOperationalMaintenanceWorkers\(\)/);
  assert.match(startup, /markDatabaseReady/);
  assert.match(startup, /server\(\?:\\\.ts\|\\\.cjs\)/);
});
