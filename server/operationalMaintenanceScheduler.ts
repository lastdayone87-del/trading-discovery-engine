import {
  getChannelById,
  getDb,
  recoverStaleChannelLocks,
  upsertChannel
} from './db';
import { shouldRunStaleChannelLockRecovery } from './staleChannelLockRecovery';
import { reconcileOrphanInvestigations, recoverStaleInvestigationSteps } from './investigationWorkflow';
import { reconcileCommunityAcquisitionRecovery, reconcileLegacyCommunityRetryOwnership } from './communityRecovery';
import { COMMUNITY_ACQUISITION_CAPACITY_UNAVAILABLE, COMMUNITY_RETRY_REASON } from './communityRetryPolicy';
import { projectProviderDeferredEnrichment, reconcileOperationalEnrichmentRecovery } from './operationalEnrichmentRecovery';
import { triggerPhaseBObservationReconciliation } from './phaseBObservationOutbox';
import { enqueueCommunityAcquisitionRetry, enqueueOperationalEnrichmentRecoveryJob } from './queueManager';

/**
 * Non-claim-critical maintenance cadence. Worker pools still tick every second
 * for claims; this interval owns the recovery/projection sweeps that must not
 * run ahead of every claim on every pool.
 */
export const OPERATIONAL_MAINTENANCE_INTERVAL_MS = 10_000;

export interface OperationalMaintenanceDependencies {
  recoverStaleChannelLocks(): Promise<unknown>;
  recoverStaleInvestigationSteps(): Promise<unknown>;
  reconcileOrphanInvestigations(): Promise<unknown>;
  reconcileCommunityAcquisitionRecovery(): Promise<unknown>;
  reconcileLegacyCommunityRetryOwnership(): Promise<unknown>;
  projectProviderDeferredEnrichment(): Promise<unknown>;
  reconcileOperationalEnrichmentRecovery(): Promise<unknown>;
  triggerPhaseBObservationReconciliation(): unknown;
}

export interface OperationalMaintenanceSnapshot {
  started: boolean;
  ticks: number;
  failures: number;
  inFlight: boolean;
  lastTickAt: string | null;
  lastError: string | null;
}

export interface OperationalMaintenanceScheduler {
  run(): Promise<void>;
  start(): void;
  stop(): void;
  snapshot(): OperationalMaintenanceSnapshot;
}

export interface OperationalMaintenanceSchedulerOptions {
  intervalMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createOperationalMaintenanceScheduler(
  dependencies: OperationalMaintenanceDependencies,
  options: OperationalMaintenanceSchedulerOptions = {}
): OperationalMaintenanceScheduler {
  const intervalMs = options.intervalMs ?? OPERATIONAL_MAINTENANCE_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback: () => void, delayMs: number) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  });
  const clearTimer = options.clearTimer ?? ((timer: unknown) => clearTimeout(timer as NodeJS.Timeout));

  let started = false;
  let inFlight: Promise<void> | null = null;
  let timer: unknown = null;
  let lastStaleChannelLockRecoveryMs: number | null = null;
  let ticks = 0;
  let failures = 0;
  let lastTickAt: string | null = null;
  let lastError: string | null = null;

  const recordFailure = (name: string, error: unknown, log = true): void => {
    failures += 1;
    lastError = `${name}: ${errorMessage(error)}`;
    if (log) console.error(`[Operational Maintenance] ${name} failed:`, error);
  };

  // One failing sweep must not suppress the remaining maintenance guarantees
  // or terminate the interval.
  const isolate = async (name: string, task: () => Promise<unknown> | unknown): Promise<void> => {
    try {
      await task();
    } catch (error) {
      recordFailure(name, error);
    }
  };

  const execute = async (): Promise<void> => {
    const nowMs = now();
    ticks += 1;
    lastTickAt = new Date(nowMs).toISOString();

    if (shouldRunStaleChannelLockRecovery({ nowMs, lastRunMs: lastStaleChannelLockRecoveryMs })) {
      // Stamp before running so a failing sweep backs off for the normal
      // interval instead of being retried on every maintenance tick.
      lastStaleChannelLockRecoveryMs = nowMs;
      try {
        await dependencies.recoverStaleChannelLocks();
      } catch (error) {
        // Keep the established operator-facing event name, but do not also
        // emit the generic maintenance failure line for the same error.
        recordFailure('stale_channel_lock_recovery', error, false);
        console.error('stale_channel_lock_recovery_failed', error);
      }
    }

    // Call through the dependency object so an implementation that relies on
    // its receiver keeps working when injected for tests or future runtimes.
    await isolate('stale_investigation_recovery', () => dependencies.recoverStaleInvestigationSteps());
    await isolate('orphan_investigation_reconciliation', () => dependencies.reconcileOrphanInvestigations());
    await isolate('community_acquisition_recovery', () => dependencies.reconcileCommunityAcquisitionRecovery());
    await isolate('legacy_community_retry_ownership', () => dependencies.reconcileLegacyCommunityRetryOwnership());
    await isolate('provider_deferred_projection', () => dependencies.projectProviderDeferredEnrichment());
    await isolate('operational_enrichment_recovery', () => dependencies.reconcileOperationalEnrichmentRecovery());
    await isolate('phase_b_observation_reconciliation', () => dependencies.triggerPhaseBObservationReconciliation());
  };

  const run = (): Promise<void> => {
    // A tick that fires while the previous sweep is still running must not
    // start a second copy. Returning the in-flight promise also makes the
    // overlap observable to callers and tests.
    if (inFlight) return inFlight;
    let pending: Promise<void>;
    pending = Promise.resolve()
      .then(execute)
      .finally(() => {
        if (inFlight === pending) inFlight = null;
      });
    inFlight = pending;
    return pending;
  };

  const start = (): void => {
    if (started) return;
    started = true;
    const tick = async (): Promise<void> => {
      try {
        await run();
      } catch (error) {
        recordFailure('maintenance_tick', error);
      }
      if (!started) return;
      timer = setTimer(() => { void tick(); }, intervalMs);
    };
    void tick();
  };

  const stop = (): void => {
    started = false;
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };

  return {
    run,
    start,
    stop,
    snapshot: () => ({ started, ticks, failures, inFlight: inFlight !== null, lastTickAt, lastError })
  };
}

function createDefaultDependencies(): OperationalMaintenanceDependencies {
  return {
    recoverStaleChannelLocks: () => recoverStaleChannelLocks(),
    recoverStaleInvestigationSteps: () => recoverStaleInvestigationSteps(),
    reconcileOrphanInvestigations: () => reconcileOrphanInvestigations(),
    reconcileCommunityAcquisitionRecovery: () => reconcileCommunityAcquisitionRecovery(
      getDb,
      getChannelById,
      upsertChannel,
      20,
      Date.now(),
      (channelId, retryReason) => enqueueCommunityAcquisitionRetry(channelId, {
        attemptFree: true,
        code: COMMUNITY_ACQUISITION_CAPACITY_UNAVAILABLE,
        reason: retryReason || 'Recovery-triggered community retry',
        retryAt: undefined,
        retryReason: retryReason === 'BROWSER_RUNTIME_UNAVAILABLE'
          ? 'BROWSER_RUNTIME_UNAVAILABLE'
          : COMMUNITY_RETRY_REASON.COMMUNITY_REQUIRED_ACQUISITION_FAILURE
      }, 'RECOVERY')
    ),
    reconcileLegacyCommunityRetryOwnership: async () => {
      const legacyCommunityReconciliation = await reconcileLegacyCommunityRetryOwnership(getDb, 250);
      if (legacyCommunityReconciliation.closedNonCommunity > 0 || legacyCommunityReconciliation.activeCommunity > 0) {
        console.info(`[Queue Worker] Restored ${legacyCommunityReconciliation.closedNonCommunity} legacy non-community job(s) to completed history; activeCommunity=${legacyCommunityReconciliation.activeCommunity}.`);
      }
    },
    projectProviderDeferredEnrichment: () => projectProviderDeferredEnrichment(getDb, getChannelById, upsertChannel, 100),
    reconcileOperationalEnrichmentRecovery: () => reconcileOperationalEnrichmentRecovery(
      getDb,
      getChannelById,
      upsertChannel,
      enqueueOperationalEnrichmentRecoveryJob,
      20,
      Date.now()
    ),
    triggerPhaseBObservationReconciliation: () => triggerPhaseBObservationReconciliation()
  };
}

const operationalMaintenanceScheduler = createOperationalMaintenanceScheduler(createDefaultDependencies());

export function startOperationalMaintenanceScheduler(): void {
  operationalMaintenanceScheduler.start();
}
