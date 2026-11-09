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
 *  - rate-limit writes invalidate the entry so a new cooldown is visible
 *    immediately rather than after the TTL;
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
      return cached.value !== undefined && cached.value > nowMs ? cached.value : undefined;
    }
    const value = await loader();
    const normalized = value !== undefined && Number.isFinite(value) && value > nowMs ? value : undefined;
    this.entries.set(key, { value: normalized, checkedAtMs: nowMs });
    return normalized;
  }

  invalidate(key?: string): void {
    if (key === undefined) this.entries.clear();
    else this.entries.delete(key);
  }

  /** Test seam: number of entries currently cached. */
  size(): number {
    return this.entries.size;
  }
}

export const providerCooldownReadCache = new ProviderCooldownReadCache();

/** Called after a RATE_LIMITED ledger write so the new cooldown is immediate. */
export function invalidateProviderCooldownCache(): void {
  providerCooldownReadCache.invalidate();
}
