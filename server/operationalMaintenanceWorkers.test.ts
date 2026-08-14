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

test('ordinary official rescans use the shared ENRICHMENT worst-case reservation', () => {
  assert.match(workers, /'POST_APPROVAL_ENRICH'/);
  assert.match(workers, /'FORCE_REVIEW_RESCAN'/);
  assert.match(workers, /reserveOfficialRecheckQuota\('OPERATIONAL_RECHECK', operationId\)/);
  assert.match(workers, /finishQuotaReservation\('OPERATIONAL_RECHECK'/);
});

test('false-negative recovery reserves quota before claiming its custom job', () => {
  const reserve = workers.indexOf("reserved = await reserveOfficialRecheckQuota('OPERATIONAL_RECHECK', operationId)");
  const claim = workers.indexOf('claimNextJob(workerId, [FALSE_NEGATIVE_RECOVERY_JOB])');
  assert.ok(reserve >= 0 && claim > reserve);
  assert.match(workers, /FALSE_NEGATIVE_RECOVERY_JOB = 'CLASSIFICATION_FALSE_NEGATIVE_RESCAN'/);
  assert.match(workers, /triggerManualRecheck\(channelId, true, true\)/);
  assert.match(workers, /completeJob\(job\.id\)/);
  assert.match(workers, /failJob\(claimedJobId, error\)/);
  assert.match(workers, /heartbeatJob\(job\.id, workerId\)/);
});

test('false-negative recovery grants attempt-free retries only to typed transient failures', () => {
  assert.match(workers, /const typedTransient = result\.retryable === true/);
  assert.match(workers, /result\.errorClass/);
  assert.match(workers, /errorClass: typedTransient \? result\.errorClass : undefined/);
  assert.doesNotMatch(workers, /errorClass: retryable \? 'TRANSIENT'/);
});

test('maintenance concurrency is bounded and starts after database readiness in server runtime', () => {
  assert.match(workers, /OPERATIONAL_MAINTENANCE_WORKER_CONCURRENCY/);
  assert.match(workers, /Math\.min\(5/);
  assert.match(startup, /if \(isServerRuntime\(\)\) startOperationalMaintenanceWorkers\(\)/);
  assert.match(startup, /markDatabaseReady/);
});
