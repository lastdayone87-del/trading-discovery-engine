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

test('community retry distinguishes due admission blockers from a genuinely empty queue', () => {
  assert.match(workers, /DUE_BUT_BROWSER_UNAVAILABLE/);
  assert.match(workers, /DUE_BUT_RECONCILIATION_BLOCKED/);
  assert.match(workers, /DUE_BUT_CLAIM_RACE/);
  assert.match(workers, /DUE_BUT_LEASED/);
  assert.match(workers, /communityRetry/);
});

test('queue status exposes browser-blocked and claimable due retry counts', () => {
  const dbCore = readFileSync(new URL('./dbCore.ts', import.meta.url), 'utf8');
  assert.match(dbCore, /due_browser_blocked/);
  assert.match(dbCore, /due_reconciliation_blocked/);
  assert.match(dbCore, /dueClaimable/);
  assert.match(dbCore, /waiting_for_browser_runtime/);
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

test('false-negative recovery admission consults authoritative provider-pool cooldown state', () => {
  assert.match(workers, /getYouTubeKeyPool\(\)/);
  assert.match(workers, /youtubeProviderCooldown\.earliestRetryAtIfAllCooling\(providerKeys\)/);
  assert.match(workers, /providerKeys\.length === 0/);
  assert.doesNotMatch(workers, /youtubeRequestScheduler\.isRateLimited\(\)/);
});

test('false-negative recovery grants attempt-free retries only to typed transient failures', () => {
  assert.match(workers, /const typedTransient = result\.retryable === true/);
  assert.match(workers, /result\.errorClass/);
  assert.match(workers, /errorClass: typedTransient \? result\.errorClass : undefined/);
  assert.doesNotMatch(workers, /errorClass: retryable \? 'TRANSIENT'/);
});

test('probe quota refusals keep their policy wait through maintenance recovery', () => {
  assert.match(workers, /result\.probeQuotaExceeded === true/);
  assert.match(workers, /result\.probeQuotaDisabled === true/);
  assert.match(workers, /probeQuotaExceeded: true/);
  assert.match(workers, /probeQuotaDisabled: true/);
});

test('maintenance concurrency is bounded and starts after database readiness in server runtime', () => {
  assert.match(workers, /COMMUNITY_RETRY_WORKER_CONCURRENCY/);
  assert.match(workers, /Math\.min\(5/);
  assert.match(startup, /if \(isServerRuntime\(\)\) \{[\s\S]*startOperationalMaintenanceWorkers\(\);/);
  assert.match(startup, /markDatabaseReady/);
  assert.match(startup, /Operational maintenance consumers started after database readiness/);
});

test('only the community retry consumer scales; every other family runs exactly one loop', () => {
  // The scaling loop starts community retry workers and nothing else.
  const loopBody = workers.slice(
    workers.indexOf('for (let index = 0; index < communityRetryConcurrency; index++)'),
  );
  const loopEnd = loopBody.indexOf('\n  }\n');
  assert.ok(loopEnd > 0, 'community scaling loop must be a closed block');
  const loopBlock = loopBody.slice(0, loopEnd);
  assert.match(loopBlock, /startCommunityRetryWorker\(`community_retry_\$\{process\.pid\}_\$\{index\}`\)/);
  assert.doesNotMatch(loopBlock, /startOfficialRecheckWorker/);
  assert.doesNotMatch(loopBlock, /startCountryBoundaryRecoveryWorker/);
  assert.doesNotMatch(loopBlock, /startFalseNegativeRecoveryWorker/);
  assert.doesNotMatch(loopBlock, /startCorpusPipelineWorker/);
  // The remaining families start exactly once each with a fixed worker id.
  assert.equal(workers.match(/startOfficialRecheckWorker\(`official_recheck_\$\{process\.pid\}_0`\)/g)?.length, 1);
  assert.equal(workers.match(/startCountryBoundaryRecoveryWorker\(`country_boundary_recovery_\$\{process\.pid\}_0`\)/g)?.length, 1);
  assert.equal(workers.match(/startFalseNegativeRecoveryWorker\(`false_negative_recovery_\$\{process\.pid\}_0`\)/g)?.length, 1);
  assert.equal(workers.match(/startCorpusPipelineWorker\(`corpus_pipeline_\$\{process\.pid\}_0`\)/g)?.length, 1);
});

test('legacy community reconciliation restores completed history without a stale-retry worker pass', () => {
  const queue = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
  assert.match(queue, /const legacyCommunityReconciliation = await reconcileLegacyCommunityRetryOwnership/);
  assert.match(queue, /Restored \$\{legacyCommunityReconciliation\.closedNonCommunity\} legacy non-community job/);
  assert.doesNotMatch(queue, /reconcilePendingCommunityRetryJobs/);
});
