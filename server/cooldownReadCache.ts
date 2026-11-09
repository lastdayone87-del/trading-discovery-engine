/**
 * Process-local, short-lived cache for persisted provider cooldown lookups.
 *
 * The semantic claim gate asks every worker for every account's cooldown on
 * every tick. Reading the 788 MB provider_call_events ledger for each question
 * saturated the database during production investigation. The cache bounds
 * that fan-out without changing the cooldown contract:
 *
 *  - an active cooldown is returned only while its real expiry is still in the
 *    future, even if the cache entry is younger than the TTL;
 *  - "no cooldown" (or a just-expired cooldown) is re-read after the TTL, so
 *    newly available capacity cannot be hidden indefinitely;
 *  - rate-limit writes invalidate matching provider entries so a new cooldown
 *    is visible immediately rather than after the TTL;
 *  - concurrent misses share one in-flight read instead of stampeding the DB;
 *  - a read that was already in flight when an invalidation landed never
 *    repopulates the cache with its older result;
 *  - loader failures are never cached, so a transient database failure cannot
 *    freeze a stale verdict.
 */
export const PROVIDER_COOLDOWN_CACHE_TTL_MS = 5_000;

interface CacheEntry {
  value: number | undefined;
  checkedAtMs: number;
}

export class ProviderCooldownReadCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<number | undefined>>();
  private readonly versions = new Map<string, number>();

  constructor(private readonly ttlMs: number = PROVIDER_COOLDOWN_CACHE_TTL_MS) {
    if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new Error('cooldown cache TTL must be non-negative');
  }

  async get(
    key: string,
    nowMs: number,
    loader: () => Promise<number | undefined>,
  ): Promise<number | undefined> {
    const cached = this.entries.get(key);
    if (cached && nowMs - cached.checkedAtMs < this.ttlMs) {
      return activeValue(cached.value, nowMs);
    }
    // If an invalidation lands while a read is in flight, the older result must
    // not repopulate the cache. Retry once against the new generation; if the
    // state keeps changing, fail open without caching anything.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const version = this.keyVersion(key);
      const value = await this.loadShared(key, loader);
      if (this.keyVersion(key) !== version) continue;
      const normalized = activeValue(value, nowMs);
      this.entries.set(key, { value: normalized, checkedAtMs: nowMs });
      return normalized;
    }
    return undefined;
  }

  private loadShared(key: string, loader: () => Promise<number | undefined>): Promise<number | undefined> {
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const pending = loader();
    this.inFlight.set(key, pending);
    void pending.finally(() => {
      if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
    }).catch(() => undefined);
    return pending;
  }

  private keyVersion(key: string): number {
    return this.versions.get(key) ?? 0;
  }

  private bump(key: string): void {
    this.versions.set(key, this.keyVersion(key) + 1);
    this.entries.delete(key);
    this.inFlight.delete(key);
  }

  invalidate(key?: string): void {
    if (key === undefined) {
      for (const current of new Set([...this.entries.keys(), ...this.inFlight.keys()])) this.bump(current);
      this.entries.clear();
      this.inFlight.clear();
    } else {
      this.bump(key);
    }
  }

  /** Invalidate only one provider family (gemini, gemini-free, groq). */
  invalidateProvider(provider: string): void {
    const prefix = provider === 'gemini-free'
      ? 'gemini-free:'
      : provider === 'gemini'
        ? 'gemini:'
        : provider === 'groq'
          ? 'groq:'
          : '';
    if (!prefix) {
      this.invalidate();
      return;
    }
    for (const key of new Set([...this.entries.keys(), ...this.inFlight.keys()])) {
      if (key.startsWith(prefix)) this.bump(key);
    }
  }

  /**
   * Invalidate the exact cooldown key(s) affected by one upstream event. A
   * per-org event also invalidates the pool-wide read because that read
   * aggregates every org; unaffected org entries remain cached.
   */
  invalidateProviderEvent(provider: string, orgId?: string | null): void {
    if ((provider === 'gemini' || provider === 'groq') && orgId) {
      this.bump(`${provider}:org:${orgId}`);
      this.bump(`${provider}:pool`);
      return;
    }
    if (provider === 'gemini-free') {
      this.bump('gemini-free:pool');
      return;
    }
    this.invalidateProvider(provider);
  }

  /** Test seam: number of entries currently cached. */
  size(): number {
    return this.entries.size;
  }
}

function activeValue(value: number | undefined, nowMs: number): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > nowMs ? value : undefined;
}

export const providerCooldownReadCache = new ProviderCooldownReadCache();

/**
 * Called after an upstream RATE_LIMITED ledger write so the new cooldown is
 * immediate. Local cooldown-deferral echoes are excluded by the caller; they
 * are backpressure observations, not new provider state.
 */
export function invalidateProviderCooldownCache(provider?: string, orgId?: string | null): void {
  if (provider) providerCooldownReadCache.invalidateProviderEvent(provider, orgId);
  else providerCooldownReadCache.invalidate();
}
