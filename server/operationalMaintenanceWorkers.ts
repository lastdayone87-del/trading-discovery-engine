import { processNextSearchJob, reserveOfficialRecheckQuota, triggerManualRecheck } from './queueManager';
import {
  claimNextJob,
  completeJob,
  failJob,
  finishQuotaReservation,
  getQueueStatus,
  getYouTubeKeyPool,
  heartbeatJob
} from './db';
import { youtubeProviderCooldown } from './youtubeProviderCooldown';
import { COUNTRY_BOUNDARY_RECOVERY_JOB } from './countryBoundaryRecovery';

type ClaimableOverride = NonNullable<Parameters<typeof processNextSearchJob>[0]>;

const COMMUNITY_RETRY_TYPES: ClaimableOverride = ['RETRY_COMMUNITY_ACQUISITION'];
const OFFICIAL_RECHECK_TYPES: ClaimableOverride = ['POST_APPROVAL_ENRICH', 'FORCE_REVIEW_RESCAN'];
const FALSE_NEGATIVE_RECOVERY_JOB = 'CLASSIFICATION_FALSE_NEGATIVE_RESCAN';
const COUNTRY_BOUNDARY_RECOVERY_TYPES: ClaimableOverride = [COUNTRY_BOUNDARY_RECOVERY_JOB];
const QUOTA_BACKOFF_MS = 30_000;
const RECOVERY_MAX_PRODUCTION_BACKLOG = Math.max(
  0,
  Number(process.env.RECOVERY_MAX_PRODUCTION_BACKLOG || 2)
);

export async function isRecoveryAdmissionOpen(): Promise<boolean> {
  const queue = await getQueueStatus();
  const productionBacklog = queue.searchJobs.depth + queue.channelProcessing.depth;
  const providerKeys = getYouTubeKeyPool();
  const providerPoolCooling = providerKeys.length === 0
    || youtubeProviderCooldown.earliestRetryAtIfAllCooling(providerKeys) !== null;
  return productionBacklog <= RECOVERY_MAX_PRODUCTION_BACKLOG
    && !providerPoolCooling;
}

let started = false;

type CommunityRetryWorkerHealth = {
  started: boolean;
  startedAt: string | null;
  lastTickAt: string | null;
  ticks: number;
  claimed: number;
  noWork: number;
  errors: number;
  lastOutcome: 'CLAIMED' | 'NO_DUE_JOB' | 'DUE_BUT_BROWSER_UNAVAILABLE' | 'DUE_BUT_RECONCILIATION_BLOCKED' | 'DUE_BUT_LEASED' | 'DUE_BUT_CLAIM_RACE' | 'ERROR' | null;
  lastErrorClass: 'DATABASE' | 'CLAIM' | 'DISPATCH' | 'UNKNOWN' | null;
};

const communityRetryHealth: CommunityRetryWorkerHealth = {
  started: false,
  startedAt: null,
  lastTickAt: null,
  ticks: 0,
  claimed: 0,
  noWork: 0,
  errors: 0,
  lastOutcome: null,
  lastErrorClass: null
};

function classifyWorkerError(error: unknown): CommunityRetryWorkerHealth['lastErrorClass'] {
  const message = String((error as { message?: unknown })?.message || error).toLowerCase();
  if (message.includes('database') || message.includes('connection') || message.includes('transaction')) return 'DATABASE';
  if (message.includes('claim') || message.includes('job')) return 'CLAIM';
  if (message.includes('dispatch') || message.includes('acquisition')) return 'DISPATCH';
  return 'UNKNOWN';
}

export function getCommunityRetryWorkerHealth(): CommunityRetryWorkerHealth {
  return { ...communityRetryHealth };
}

function schedule(next: () => void, delayMs: number): void {
  const timer = setTimeout(next, delayMs);
  timer.unref?.();
}

function startCommunityRetryWorker(workerId: string): void {
  communityRetryHealth.started = true;
  communityRetryHealth.startedAt ??= new Date().toISOString();
  const tick = async () => {
    communityRetryHealth.ticks += 1;
    communityRetryHealth.lastTickAt = new Date().toISOString();
    try {
      const claimed = await processNextSearchJob(COMMUNITY_RETRY_TYPES, workerId);
      if (claimed) {
        communityRetryHealth.claimed += 1;
        communityRetryHealth.lastOutcome = 'CLAIMED';
      } else {
        communityRetryHealth.noWork += 1;
        const admission = (await getQueueStatus()).communityRetry;
        if (admission.dueBrowserBlocked > 0) communityRetryHealth.lastOutcome = 'DUE_BUT_BROWSER_UNAVAILABLE';
        else if (admission.dueReconciliationBlocked > 0) communityRetryHealth.lastOutcome = 'DUE_BUT_RECONCILIATION_BLOCKED';
        else if (admission.dueClaimable > 0) communityRetryHealth.lastOutcome = 'DUE_BUT_CLAIM_RACE';
        else if (admission.processing > 0) communityRetryHealth.lastOutcome = 'DUE_BUT_LEASED';
        else communityRetryHealth.lastOutcome = 'NO_DUE_JOB';
      }
    } catch (error) {
      communityRetryHealth.errors += 1;
      communityRetryHealth.lastOutcome = 'ERROR';
      communityRetryHealth.lastErrorClass = classifyWorkerError(error);
      console.error(`[Queue Worker:${workerId}] Community retry tick failed:`, error);
    } finally {
      schedule(tick, 1000);
    }
  };
  void tick();
}

function startOfficialRecheckWorker(workerId: string): void {
  const tick = async () => {
    const operationId = `${workerId}:${Date.now()}`;
    let reserved = false;
    let nextDelayMs = 1000;
    try {
      reserved = await reserveOfficialRecheckQuota('OPERATIONAL_RECHECK', operationId);
      if (!reserved) {
        nextDelayMs = QUOTA_BACKOFF_MS;
        return;
      }
      const processed = await processNextSearchJob(OFFICIAL_RECHECK_TYPES, workerId);
      await finishQuotaReservation('OPERATIONAL_RECHECK', operationId, processed);
      reserved = false;
    } catch (error) {
      if (reserved) await finishQuotaReservation('OPERATIONAL_RECHECK', operationId, false).catch(() => undefined);
      reserved = false;
      nextDelayMs = QUOTA_BACKOFF_MS;
      console.error(`[Queue Worker:${workerId}] Official recheck tick failed:`, error);
    } finally {
      schedule(tick, nextDelayMs);
    }
  };
  void tick();
}

function startFalseNegativeRecoveryWorker(workerId: string): void {
  const tick = async () => {
    const operationId = `${workerId}:${Date.now()}`;
    let reserved = false;
    let claimedJobId: string | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    let nextDelayMs = 1000;
    try {
      if (!await isRecoveryAdmissionOpen()) {
        nextDelayMs = QUOTA_BACKOFF_MS;
        return;
      }

      // Reserve before claiming so a recovery job never becomes PROCESSING when
      // the production ENRICHMENT allocation cannot pay for its bounded official
      // Data API attempts.
      reserved = await reserveOfficialRecheckQuota('OPERATIONAL_RECHECK', operationId);
      if (!reserved) {
        nextDelayMs = QUOTA_BACKOFF_MS;
        return;
      }

      const job = await claimNextJob(workerId, [FALSE_NEGATIVE_RECOVERY_JOB]);
      if (!job) {
        await finishQuotaReservation('OPERATIONAL_RECHECK', operationId, false);
        reserved = false;
        return;
      }
      claimedJobId = job.id;
      heartbeat = setInterval(() => {
        heartbeatJob(job.id, workerId).catch(error => console.error(`[Queue Worker:${workerId}] Recovery heartbeat failed:`, error));
      }, 60_000);
      heartbeat.unref?.();

      const channelId = String(job.payload?.channelId || '');
      if (!channelId) throw new Error('False-negative recovery job is missing channelId.');
      const result = await triggerManualRecheck(channelId, true, true);
      if (!result.success) {
        const typedTransient = result.retryable === true
          && ['TIMEOUT', 'CANCELLED', 'RATE_LIMIT', 'TRANSIENT', 'CREDENTIALS_EXHAUSTED'].includes(String(result.errorClass || ''));
        const error = Object.assign(new Error(result.message), {
          code: result.code,
          retryable: typedTransient,
          errorClass: typedTransient ? result.errorClass : undefined,
          retryAt: typedTransient ? result.retryAt : undefined,
          retryAfterMs: typedTransient ? result.retryAfterMs : undefined
        });
        throw error;
      }
      await completeJob(job.id);
      claimedJobId = undefined;
      await finishQuotaReservation('OPERATIONAL_RECHECK', operationId, true);
      reserved = false;
    } catch (error) {
      if (claimedJobId) await failJob(claimedJobId, error).catch(() => undefined);
      if (reserved) await finishQuotaReservation('OPERATIONAL_RECHECK', operationId, false).catch(() => undefined);
      reserved = false;
      nextDelayMs = QUOTA_BACKOFF_MS;
      console.error(`[Queue Worker:${workerId}] False-negative recovery tick failed:`, error);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      schedule(tick, nextDelayMs);
    }
  };
  void tick();
}

function startCountryBoundaryRecoveryWorker(workerId: string): void {
  const tick = async () => {
    const operationId = `${workerId}:${Date.now()}`;
    let reserved = false;
    let claimedJobId: string | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    let nextDelayMs = 1000;
    try {
      if (!await isRecoveryAdmissionOpen()) {
        nextDelayMs = QUOTA_BACKOFF_MS;
        return;
      }
      reserved = await reserveOfficialRecheckQuota('OPERATIONAL_RECHECK', operationId);
      if (!reserved) {
        nextDelayMs = QUOTA_BACKOFF_MS;
        return;
      }
      const job = await claimNextJob(workerId, COUNTRY_BOUNDARY_RECOVERY_TYPES);
      if (!job) {
        await finishQuotaReservation('OPERATIONAL_RECHECK', operationId, false);
        reserved = false;
        return;
      }
      claimedJobId = job.id;
      heartbeat = setInterval(() => {
        heartbeatJob(job.id, workerId).catch(error => console.error(`[Queue Worker:${workerId}] Country-boundary recovery heartbeat failed:`, error));
      }, 60_000);
      heartbeat.unref?.();
      const channelId = String(job.payload?.channelId || '');
      if (!channelId) throw new Error('Country-boundary recovery job is missing channelId.');
      const result = await triggerManualRecheck(channelId, true, true);
      if (!result.success) {
        const typedTransient = result.retryable === true
          && ['TIMEOUT', 'CANCELLED', 'RATE_LIMIT', 'TRANSIENT', 'CREDENTIALS_EXHAUSTED'].includes(String(result.errorClass || ''));
        throw Object.assign(new Error(result.message), {
          code: result.code,
          retryable: typedTransient,
          errorClass: typedTransient ? result.errorClass : undefined,
          retryAt: typedTransient ? result.retryAt : undefined,
          retryAfterMs: typedTransient ? result.retryAfterMs : undefined
        });
      }
      await completeJob(job.id);
      claimedJobId = undefined;
      await finishQuotaReservation('OPERATIONAL_RECHECK', operationId, true);
      reserved = false;
    } catch (error) {
      if (claimedJobId) await failJob(claimedJobId, error).catch(() => undefined);
      if (reserved) await finishQuotaReservation('OPERATIONAL_RECHECK', operationId, false).catch(() => undefined);
      reserved = false;
      nextDelayMs = QUOTA_BACKOFF_MS;
      console.error(`[Queue Worker:${workerId}] Country-boundary recovery tick failed:`, error);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      schedule(tick, nextDelayMs);
    }
  };
  void tick();
}

/** Dedicated consumers for operational jobs outside the three core pools. */
export function startOperationalMaintenanceWorkers(): void {
  if (started) return;
  started = true;
  const configured = Number(process.env.OPERATIONAL_MAINTENANCE_WORKER_CONCURRENCY || 1);
  const concurrency = Math.min(5, Math.max(1, Number.isFinite(configured) ? Math.floor(configured) : 1));
  for (let index = 0; index < concurrency; index++) {
    startCommunityRetryWorker(`community_retry_${process.pid}_${index}`);
    startOfficialRecheckWorker(`official_recheck_${process.pid}_${index}`);
    startCountryBoundaryRecoveryWorker(`country_boundary_recovery_${process.pid}_${index}`);
  }
  // Recovery is intentionally single-consumer and low-volume regardless of the
  // generic maintenance concurrency setting.
  startFalseNegativeRecoveryWorker(`false_negative_recovery_${process.pid}_0`);
}

export function getOperationalMaintenanceJobTypesForTests(): string[] {
  return [...COMMUNITY_RETRY_TYPES, ...OFFICIAL_RECHECK_TYPES, FALSE_NEGATIVE_RECOVERY_JOB, ...COUNTRY_BOUNDARY_RECOVERY_TYPES];
}
