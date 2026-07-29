export interface ReadinessState {
  status: 'starting' | 'ok';
  readiness: 'not_ready' | 'ready';
}

export function createReadinessState(): {
  snapshot: () => ReadinessState;
  markListening: () => void;
} {
  let listening = false;
  return {
    snapshot: () => listening
      ? { status: 'ok', readiness: 'ready' }
      : { status: 'starting', readiness: 'not_ready' },
    markListening: () => { listening = true; }
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
