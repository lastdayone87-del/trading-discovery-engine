import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createOperationalMaintenanceScheduler,
  type OperationalMaintenanceDependencies
} from './operationalMaintenanceScheduler';
import { STALE_CHANNEL_LOCK_RECOVERY_INTERVAL_MS } from './staleChannelLockRecovery';

const ALL_TASKS = [
  'locks',
  'investigations',
  'orphans',
  'community',
  'legacy',
  'projection',
  'enrichment',
  'phaseb',
  'resume'
];

function createDeps(failAt?: string) {
  const calls: string[] = [];
  const make = (name: string) => async () => {
    calls.push(name);
    if (name === failAt) throw new Error(`${name} failed`);
  };
  const dependencies: OperationalMaintenanceDependencies = {
    recoverStaleChannelLocks: make('locks'),
    recoverStaleInvestigationSteps: make('investigations'),
    reconcileOrphanInvestigations: make('orphans'),
    reconcileCommunityAcquisitionRecovery: make('community'),
    reconcileLegacyCommunityRetryOwnership: make('legacy'),
    projectProviderDeferredEnrichment: make('projection'),
    reconcileOperationalEnrichmentRecovery: make('enrichment'),
    triggerPhaseBObservationReconciliation: make('phaseb'),
    resumeOrphanedAutonomousPages: make('resume')
  };
  return { calls, dependencies };
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('one maintenance run executes every recovery task in order', async () => {
  const { calls, dependencies } = createDeps();
  const scheduler = createOperationalMaintenanceScheduler(dependencies, { now: () => 1_000_000 });

  await scheduler.run();

  assert.deepEqual(calls, ALL_TASKS);
  const snapshot = scheduler.snapshot();
  assert.equal(snapshot.ticks, 1);
  assert.equal(snapshot.failures, 0);
  assert.equal(snapshot.inFlight, false);
  assert.equal(snapshot.lastError, null);
  assert.equal(snapshot.lastTickAt, new Date(1_000_000).toISOString());
  assert.equal(snapshot.stalled, false);
  assert.equal(snapshot.runStartedAt, null);
  assert.equal(snapshot.lastStallAt, null);
});

test('one failing task does not suppress the remaining recovery guarantees', async () => {
  const { calls, dependencies } = createDeps('community');
  const scheduler = createOperationalMaintenanceScheduler(dependencies, { now: () => 2_000_000 });
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    await scheduler.run();
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(calls, ALL_TASKS);
  const snapshot = scheduler.snapshot();
  assert.equal(snapshot.failures, 1);
  assert.match(snapshot.lastError || '', /community_acquisition_recovery: community failed/);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0][0]), /community_acquisition_recovery failed/);
});

test('a failing stale channel lock sweep logs once and still backs off', async () => {
  const { calls, dependencies } = createDeps('locks');
  const scheduler = createOperationalMaintenanceScheduler(dependencies, { now: () => 2_500_000 });
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    await scheduler.run();
  } finally {
    console.error = originalError;
  }

  assert.equal(errors.length, 1, 'the same failure must not be logged twice');
  assert.match(String(errors[0][0]), /stale_channel_lock_recovery_failed/);
  assert.match(scheduler.snapshot().lastError || '', /stale_channel_lock_recovery: locks failed/);
  assert.deepEqual(calls, ALL_TASKS, 'the remaining recovery tasks still run');
});

test('a hung sweep is reported by the watchdog and remains visible in health', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { calls, dependencies } = createDeps();
  dependencies.recoverStaleChannelLocks = async () => {
    calls.push('locks');
    await gate;
  };
  const watchdogCallbacks: Array<() => void> = [];
  const scheduler = createOperationalMaintenanceScheduler(dependencies, {
    intervalMs: 10,
    now: () => 7_000_000,
    setTimer: () => 0,
    clearTimer: () => undefined,
    watchdogMs: 100,
    setWatchdog: callback => {
      watchdogCallbacks.push(callback);
      return watchdogCallbacks.length;
    },
    clearWatchdog: () => undefined
  });
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    scheduler.start();
    await flush();
    const pending = scheduler.run();
    assert.equal(scheduler.snapshot().inFlight, true);
    assert.equal(scheduler.snapshot().runStartedAt, new Date(7_000_000).toISOString());
    assert.ok(watchdogCallbacks.length >= 1, 'a watchdog is armed for the sweep');

    watchdogCallbacks[0]();
    assert.equal(scheduler.snapshot().stalled, true);
    assert.equal(scheduler.snapshot().lastStallAt, new Date(7_000_000).toISOString());
    assert.match(String(errors[0][0]), /sweep still in flight/);

    release();
    await pending;
    assert.equal(scheduler.snapshot().inFlight, false);
    assert.equal(scheduler.snapshot().stalled, false);
    assert.equal(scheduler.snapshot().runStartedAt, null);
    assert.deepEqual(calls, ALL_TASKS);
  } finally {
    console.error = originalError;
    scheduler.stop();
  }
});

test('restarting during an in-flight sweep re-arms its watchdog', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { calls, dependencies } = createDeps();
  dependencies.recoverStaleChannelLocks = async () => {
    calls.push('locks');
    await gate;
  };
  const watchdogs: Array<{ cleared: boolean }> = [];
  const scheduler = createOperationalMaintenanceScheduler(dependencies, {
    intervalMs: 10,
    now: () => 8_000_000,
    setTimer: () => 0,
    clearTimer: () => undefined,
    watchdogMs: 100,
    setWatchdog: () => {
      watchdogs.push({ cleared: false });
      return watchdogs.length;
    },
    clearWatchdog: id => {
      const watchdog = watchdogs[Number(id) - 1];
      if (watchdog) watchdog.cleared = true;
    }
  });
  try {
    scheduler.start();
    await flush();
    assert.equal(watchdogs.filter(watchdog => !watchdog.cleared).length, 1);
    const pending = scheduler.run();

    scheduler.stop();
    assert.equal(watchdogs.filter(watchdog => !watchdog.cleared).length, 0, 'stop disarms the watchdog');

    scheduler.start();
    assert.equal(
      watchdogs.filter(watchdog => !watchdog.cleared).length,
      1,
      'restart re-arms the watchdog for the sweep that is still in flight'
    );

    release();
    await pending;
    assert.equal(scheduler.snapshot().inFlight, false);
    assert.equal(scheduler.snapshot().stalled, false);
    assert.deepEqual(calls, ALL_TASKS);
  } finally {
    release();
    scheduler.stop();
  }
});

test('overlapping runs coalesce into the in-flight sweep', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { calls, dependencies } = createDeps();
  dependencies.recoverStaleChannelLocks = async () => {
    calls.push('locks');
    await gate;
  };
  const scheduler = createOperationalMaintenanceScheduler(dependencies, { now: () => 3_000_000 });

  const first = scheduler.run();
  const second = scheduler.run();
  assert.equal(second, first, 'the overlapping caller joins the same run');

  release();
  await first;
  assert.deepEqual(calls, ALL_TASKS);
  assert.equal(scheduler.snapshot().ticks, 1, 'the overlapping call does not execute a second sweep');
});

test('the stale channel lock sweep keeps its own cooldown across maintenance runs', async () => {
  let now = 4_000_000;
  const { calls, dependencies } = createDeps();
  const scheduler = createOperationalMaintenanceScheduler(dependencies, { now: () => now });

  await scheduler.run();
  now += STALE_CHANNEL_LOCK_RECOVERY_INTERVAL_MS - 1;
  await scheduler.run();
  assert.equal(calls.filter(call => call === 'locks').length, 1, 'inside the cooldown the sweep is skipped');

  now += 1;
  await scheduler.run();
  assert.equal(calls.filter(call => call === 'locks').length, 2, 'at the boundary the sweep runs again');
});

test('start is idempotent and stop ends the interval', async () => {
  const { calls, dependencies } = createDeps();
  const timers: Array<() => void> = [];
  const scheduler = createOperationalMaintenanceScheduler(dependencies, {
    intervalMs: 10,
    now: () => 5_000_000,
    setTimer: callback => {
      timers.push(callback);
      return timers.length;
    },
    clearTimer: () => undefined
  });

  scheduler.start();
  scheduler.start();
  await flush();
  assert.equal(timers.length, 1, 'a second start must not create a second loop');
  assert.equal(calls.filter(call => call === 'locks').length, 1, 'the first tick runs immediately');
  assert.equal(scheduler.snapshot().started, true);

  timers[0]();
  await flush();
  assert.equal(timers.length, 2, 'the tick schedules the next interval');
  assert.equal(calls.filter(call => call === 'locks').length, 1, 'the lock cooldown still applies');

  scheduler.stop();
  timers[1]();
  await flush();
  assert.equal(timers.length, 2, 'a stopped scheduler does not reschedule');
  assert.equal(scheduler.snapshot().started, false);
});

test('the claim path keeps only claim-critical stale-job recovery', () => {
  const queue = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
  assert.match(queue, /await recoverStaleJobs\(\);/);
  for (const moved of [
    'recoverStaleChannelLocks',
    'recoverStaleInvestigationSteps',
    'reconcileOrphanInvestigations',
    'reconcileCommunityAcquisitionRecovery',
    'reconcileLegacyCommunityRetryOwnership',
    'projectProviderDeferredEnrichment',
    'reconcileOperationalEnrichmentRecovery',
    'triggerPhaseBObservationReconciliation'
  ]) {
    assert.doesNotMatch(queue, new RegExp(moved), `${moved} must not run in the claim path`);
  }

  const recoveryAt = queue.indexOf('await recoverStaleJobs();');
  const statusAt = queue.indexOf('const qStatus = await getQueueStatus();', recoveryAt);
  const claimAt = queue.indexOf('claimNextJob(', recoveryAt);
  assert.ok(recoveryAt >= 0, 'stale job recovery stays in the claim path');
  assert.ok(statusAt > recoveryAt, 'queue status is read after claim-critical recovery');
  assert.ok(claimAt > statusAt, 'the claim still follows recovery and queue status');
});

test('maintenance is started exactly once after database readiness', () => {
  const workers = readFileSync(new URL('./operationalMaintenanceWorkers.ts', import.meta.url), 'utf8');
  const startup = readFileSync(new URL('./startupLifecycle.ts', import.meta.url), 'utf8');
  assert.equal(workers.match(/startOperationalMaintenanceScheduler\(\)/g)?.length, 1);
  assert.match(startup, /markDatabaseReady[\s\S]*startOperationalMaintenanceWorkers\(\)/);
});

test('maintenance health is exposed on the queue status endpoint', () => {
  const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
  assert.match(server, /getOperationalMaintenanceSchedulerHealth/);
  assert.match(server, /operational: getOperationalMaintenanceSchedulerHealth\(\)/);
});
