export type YouTubeProviderFailureKind = 'RATE_LIMITED' | 'DAILY_QUOTA_EXHAUSTED';

export interface YouTubeProviderCooldownOptions {
  initialRateLimitCooldownMs: number;
  maxRateLimitCooldownMs: number;
  now?: () => number;
}

/** Process-local availability state for each configured API key/project. */
export class YouTubeProviderCooldown {
  private readonly providers = new Map<string, { retryAt: number; rateLimitCooldownMs: number }>();

  constructor(private readonly options: YouTubeProviderCooldownOptions) {}

  eligible(key: string): boolean {
    const state = this.providers.get(key);
    if (!state) return true;
    if ((this.options.now ?? Date.now)() < state.retryAt) return false;
    this.providers.delete(key);
    return true;
  }

  failed(key: string, kind: YouTubeProviderFailureKind): number {
    const now = (this.options.now ?? Date.now)();
    const previous = this.providers.get(key);
    if (kind === 'DAILY_QUOTA_EXHAUSTED') {
      const date = new Date(now);
      const retryAt = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
      this.providers.set(key, { retryAt, rateLimitCooldownMs: 0 });
      return retryAt;
    }
    const initial = Math.max(1, this.options.initialRateLimitCooldownMs);
    const cooldown = previous?.rateLimitCooldownMs
      ? Math.min(Math.max(initial, this.options.maxRateLimitCooldownMs), previous.rateLimitCooldownMs * 2)
      : initial;
    const retryAt = now + cooldown;
    this.providers.set(key, { retryAt, rateLimitCooldownMs: cooldown });
    return retryAt;
  }

  succeeded(key: string): void { this.providers.delete(key); }
  retryAt(key: string): number { return this.providers.get(key)?.retryAt ?? 0; }

  earliestRetryAtIfAllCooling(keys: string[]): number | null {
    if (!keys.length || keys.some(key => this.eligible(key))) return null;
    return Math.min(...keys.map(key => this.retryAt(key)).filter(retryAt => retryAt > 0));
  }
}

export class YouTubeProvidersCoolingDownError extends Error {
  readonly code = 'YOUTUBE_PROVIDERS_COOLING_DOWN';
  constructor(public readonly retryAt: number) {
    super(`Every configured YouTube provider is cooling down; retry is scheduled for ${new Date(retryAt).toISOString()}.`);
    this.name = 'YouTubeProvidersCoolingDownError';
  }
}

const nonNegativeNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

export const youtubeProviderCooldown = new YouTubeProviderCooldown({
  initialRateLimitCooldownMs: nonNegativeNumber(process.env.YOUTUBE_RATE_LIMIT_BACKOFF_MS, 5_000),
  maxRateLimitCooldownMs: nonNegativeNumber(process.env.YOUTUBE_RATE_LIMIT_MAX_BACKOFF_MS, 5 * 60_000)
});
