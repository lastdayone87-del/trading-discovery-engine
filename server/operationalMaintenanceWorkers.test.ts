import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workers = readFileSync(new URL('./operationalMaintenanceWorkers.ts', import.meta.url), 'utf8');
const startup = readFileSync(new URL('./startupLifecycle.ts', import.meta.url), 'utf8');

test('community retry has a continuously started dedicated consumer', () => {
  assert.match(workers, /COMMUNITY_RETRY_TYPES[^\n]*\['RETRY_COMMUNITY_ACQUISITION'\]/);
  assert.match(workers, /processNextSearchJob\(COMMUNITY_RETRY_TYPES, workerId\)/);
  assert.match(workers, /startCommunityRetryWorker/);
});

test('ordinary official rescans reserve the ENRICHMENT worst case across configured provider rotation', () => {
  assert.match(workers, /'POST_APPROVAL_ENRICH'/);
  assert.match(workers, /'FORCE_REVIEW_RESCAN'/);
  assert.match(workers, /tryReserveQuota/);
  assert.match(workers, /allocation: 'ENRICHMENT'/);
  assert.match(workers, /OFFICIAL_RECHECK_UNITS_PER_PROVIDER = 101/);
  assert.match(workers, /Math\.max\(1, getYouTubeKeyPool\(\)\.length\)/);
  assert.match(workers, /reservedUnits = OFFICIAL_RECHECK_UNITS_PER_PROVIDER \* maximumProviderAttempts/);
  assert.match(workers, /units: reservedUnits/);
  assert.match(workers, /finishQuotaReservation\('OPERATIONAL_RECHECK'/);
});

test('Provider2 false-negative recovery reserves quota before claiming its custom job', () => {
  const reserve = workers.indexOf('reserved = await reserveOfficialRecheck(operationId)');
  const claim = workers.indexOf('claimNextJob(workerId, [PROVIDER2_RECOVERY_JOB])');
  assert.ok(reserve >= 0 && claim > reserve);
  assert.match(workers, /PROVIDER2_RECOVERY_JOB = 'PROVIDER2_FALSE_NEGATIVE_RESCAN'/);
  assert.match(workers, /triggerManualRecheck\(channelId, true\)/);
  assert.match(workers, /completeJob\(job\.id\)/);
  assert.match(workers, /failJob\(claimedJobId, error\)/);
  assert.match(workers, /heartbeatJob\(job\.id, workerId\)/);
});

test('Provider2 recovery maps wrapped upstream failures back to transient infrastructure retries', () => {
  assert.match(workers, /const retryable = result\.retryable === true/);
  assert.match(workers, /errorClass: retryable \? 'TRANSIENT' : undefined/);
});

test('maintenance concurrency is bounded and starts after database readiness in server runtime', () => {
  assert.match(workers, /OPERATIONAL_MAINTENANCE_WORKER_CONCURRENCY/);
  assert.match(workers, /Math\.min\(5/);
  assert.match(startup, /if \(isServerRuntime\(\)\) startOperationalMaintenanceWorkers\(\)/);
  assert.match(startup, /markDatabaseReady/);
});
