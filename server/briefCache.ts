/**
 * Process-local cache for a read-mostly snapshot with single-flight loading.
 *
 * Concurrent callers share one in-flight load, successful values are reused
 * until the TTL expires, and a failed load is never cached. `invalidate()`
 * bumps a generation so a load that started before an explicit mutation cannot
 * repopulate the cache with pre-mutation data.
 */
export interface BriefCache<T> {
  get(): Promise<T>;
  invalidate(): void;
}

export function createBriefCache<T>(
  load: () => Promise<T>,
  ttlMs: number,
  now: () => number = Date.now
): BriefCache<T> {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error('Brief cache TTL must be a positive finite number of milliseconds.');
  }
  let cached: { value: T; expiresAt: number } | null = null;
  let inFlight: Promise<T> | null = null;
  let generation = 0;

  return {
    get(): Promise<T> {
      if (cached && now() < cached.expiresAt) return Promise.resolve(cached.value);
      if (inFlight) return inFlight;
      const loadGeneration = generation;
      let loaded: Promise<T>;
      try {
        loaded = load();
      } catch (error) {
        // Normalize a synchronous loader failure into a rejected promise so
        // callers always observe one async contract.
        loaded = Promise.reject(error);
      }
      const pending = loaded
        .then(value => {
          // A mutation may have invalidated the cache while this load was in
          // flight; never let the older snapshot overwrite fresher state.
          if (loadGeneration === generation) {
            cached = { value, expiresAt: now() + ttlMs };
          }
          return value;
        })
        .finally(() => {
          // Release the coalescing handle only if no invalidation replaced it.
          if (loadGeneration === generation) inFlight = null;
        });
      inFlight = pending;
      return pending;
    },
    invalidate(): void {
      generation += 1;
      cached = null;
      // Drop the coalescing handle so the next read starts immediately rather
      // than joining a load that may have read pre-mutation rows.
      inFlight = null;
    }
  };
}
