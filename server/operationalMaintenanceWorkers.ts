import { processNextSearchJob, triggerManualRecheck } from './queueManager';
import {
  claimNextJob,
  completeJob,
  failJob,
  finishQuotaReservation,
  getAppSetting,
  getDailyYouTubeQuotaBudget,
  getYouTubeKeyPool,
  heartbeatJob,
  tryReserveQuota
} from './db';

type ClaimableOverride = NonNullable<Parameters<typeof processNextSearchJob>[0]>;

const COMMUNITY_RETRY_TYPES: ClaimableOverride = ['RETRY_COMMUNITY_ACQUISITION'];
const OFFICIAL_RECHECK_TYPES: ClaimableOverride = ['POST_APPROVAL_ENRICH', 'FORCE_REVIEW_RESCAN'];
const PROVIDER2_RECOVERY_JOB = 'PROVIDER2_FALSE_NEGATIVE_RESCAN';
const OFFICIAL_RECHECK_UNITS_PER_PROVIDER = 101;
const QUOTA_BACKOFF_MS = 30_000;

let started = false;

function schedule(next: () => void, delayMs: number): void {
  const timer = setTimeout(next, delayMs);
  timer.unref?.();
}

async function reserveOfficialRecheck(operationId: string): Promise<boolean> {
  const dailyBudget = getDailyYouTubeQuotaBudget();
  const allocationPercent = Math.max(1, Math.min(100, Number(await getAppSetting('discovery_enrichment_quota_percent', '10')) || 10));
  // A stage-1 manual recheck can rotate through every configured project key.
  // Reserve the bounded worst case up front so successful expensive requests on
  // an earlier key can never push actual consumption beyond the quota gate.
  const maximumProviderAttempts = Math.max(1, getYouTubeKeyPool().length);
  const reservedUnits = OFFICIAL_RECHECK_UNITS_PER_PROVIDER * maximumProviderAttempts;
  return tryReserveQuota({
    operationType: 'OPERATIONAL_RECHECK',
    operationId,
    allocation: 'ENRICHMENT',
    units: reservedUnits,
    dailyBudget,
    allocationPercent
  });
}

function startCommunityRetryWorker(workerId: string): void {
  const tick = async () => {
    try {
      await processNextSearchJob(COMMUNITY_RETRY_TYPES, workerId);
    } catch (error) {
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
      reserved = await reserveOfficialRecheck(operationId);
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

function startProvider2RecoveryWorker(workerId: string): void {
  const tick = async () => {
    const operationId = `${workerId}:${Date.now()}`;
    let reserved = false;
    let claimedJobId: string | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    let nextDelayMs = 1000;
    try {
      // Reserve before claiming so a recovery job never becomes PROCESSING when
      // the production ENRICHMENT allocation cannot pay for its bounded official
      // Data API attempts.
      reserved = await reserveOfficialRecheck(operationId);
      if (!reserved) {
        nextDelayMs = QUOTA_BACKOFF_MS;
        return;
      }

      const job = await claimNextJob(workerId, [PROVIDER2_RECOVERY_JOB]);
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
      if (!channelId) throw new Error('Provider2 recovery job is missing channelId.');
      const result = await triggerManualRecheck(channelId, true);
      if (!result.success) {
        const retryable = result.retryable !== false;
        const error = Object.assign(new Error(result.message), {
          code: result.code,
          retryable,
          // triggerManualRecheck intentionally wraps upstream provider errors in
          // MANUAL_RESCAN_UPSTREAM_FAILURE. Restore infrastructure semantics for
          // failJob so transient provider outages do not consume normal attempts.
          errorClass: retryable ? 'TRANSIENT' : undefined
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
      console.error(`[Queue Worker:${workerId}] Provider2 false-negative recovery tick failed:`, error);
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
  }
  // Recovery is intentionally single-consumer and low-volume regardless of the
  // generic maintenance concurrency setting.
  startProvider2RecoveryWorker(`provider2_recovery_${process.pid}_0`);
}

export function getOperationalMaintenanceJobTypesForTests(): string[] {
  return [...COMMUNITY_RETRY_TYPES, ...OFFICIAL_RECHECK_TYPES, PROVIDER2_RECOVERY_JOB];
}
