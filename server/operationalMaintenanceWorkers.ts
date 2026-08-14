import { processNextSearchJob } from './queueManager';

type ClaimableOverride = NonNullable<Parameters<typeof processNextSearchJob>[0]>;

const OPERATIONAL_JOB_TYPES: ClaimableOverride = [
  'POST_APPROVAL_ENRICH',
  'FORCE_REVIEW_RESCAN',
  'RETRY_COMMUNITY_ACQUISITION'
];

let started = false;

/** Dedicated consumers for operational jobs outside the three core pools. */
export function startOperationalMaintenanceWorkers(): void {
  if (started) return;
  started = true;
  const configured = Number(process.env.OPERATIONAL_MAINTENANCE_WORKER_CONCURRENCY || 1);
  const concurrency = Math.min(5, Math.max(1, Number.isFinite(configured) ? Math.floor(configured) : 1));
  for (let index = 0; index < concurrency; index++) {
    const workerId = `operational_maintenance_${process.pid}_${index}`;
    const tick = async () => {
      try {
        await processNextSearchJob(OPERATIONAL_JOB_TYPES, workerId);
      } catch (error) {
        console.error(`[Queue Worker:${workerId}] Operational maintenance tick failed:`, error);
      } finally {
        const timer = setTimeout(tick, 1000);
        timer.unref?.();
      }
    };
    void tick();
  }
}

export function getOperationalMaintenanceJobTypesForTests(): ClaimableOverride {
  return [...OPERATIONAL_JOB_TYPES];
}
