import { startOperationalMaintenanceWorkers } from './operationalMaintenanceWorkers';

export interface ReadinessState {
  status: 'starting' | 'ok';
  readiness: 'not_ready' | 'ready';
  database: 'initializing' | 'ready';
}

function isServerRuntime(): boolean {
  const entry = String(process.argv[1] || '');
  return /(?:^|[/\\])server(?:\.ts|\.cjs)$/.test(entry);
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
    markDatabaseReady: () => {
      databaseReady = true;
      // The core search/manual/enrichment workers start immediately at HTTP
      // bind. Operational retry/rescan jobs require the migrated schema, so
      // start their dedicated consumer once database readiness is confirmed.
      if (isServerRuntime()) startOperationalMaintenanceWorkers();
    }
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
