export interface ReadinessState {
  status: 'starting' | 'ok';
  readiness: 'not_ready' | 'ready';
  database: 'initializing' | 'ready';
}

export function createReadinessState(): {
  snapshot: () => ReadinessState;
  markDatabaseReady: () => void;
} {
  let databaseReady = false;
  return {
    snapshot: () => databaseReady
      ? { status: 'ok', readiness: 'ready', database: 'ready' }
      : { status: 'starting', readiness: 'not_ready', database: 'initializing' },
    markDatabaseReady: () => { databaseReady = true; }
  };
}

export interface BackgroundStartupTask {
  name: string;
  run: () => void | Promise<void>;
}

/** Provider and maintenance failures are operational degradation, not readiness. */
export function launchAfterReadiness(
  tasks: BackgroundStartupTask[],
  log: Pick<Console, 'error'> = console
): void {
  for (const task of tasks) {
    Promise.resolve()
      .then(task.run)
      .catch(error => log.error(`[Startup] ${task.name} failed; HTTP service remains ready:`, error));
  }
}
