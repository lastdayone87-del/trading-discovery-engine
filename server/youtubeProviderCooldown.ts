export type YouTubeProviderFailureKind = 'RATE_LIMITED' | 'DAILY_QUOTA_EXHAUSTED';
export type YouTubeProviderOperationalStatus = 'Active' | 'Cooling Down' | 'Daily Quota Exhausted';

export interface YouTubeProviderCooldownOptions {
  initialRateLimitCooldownMs: number;
  maxRateLimitCooldownMs: number;
  now?: () => number;
}

const YOUTUBE_QUOTA_TIME_ZONE = 'America/Los_Angeles';

function zonedParts(timestamp: number, timeZone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(timestamp));
  return Object.fromEntries(parts
    .filter(part => part.type !== 'literal')
    .map(part => [part.type, Number(part.value)]));
}

function zonedOffsetMs(timestamp: number, timeZone: string): number {
  const rounded = Math.floor(timestamp / 1000) * 1000;
  const parts = zonedParts(rounded, timeZone);
  const representedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return representedAsUtc - rounded;
}

/** Calendar key for the YouTube quota day, which follows Pacific Time. */
export function youtubeQuotaDateKey(now: number = Date.now()): string {
  const parts = zonedParts(now, YOUTUBE_QUOTA_TIME_ZONE);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

/** YouTube Data API daily quota resets at midnight Pacific Time. */
export function nextYouTubeDailyQuotaResetAt(now: number): number {
  const pacific = zonedParts(now, YOUTUBE_QUOTA_TIME_ZONE);
  const nextLocalMidnight = Date.UTC(pacific.year, pacific.month - 1, pacific.day + 1, 0, 0, 0);
  let candidate = nextLocalMidnight - zonedOffsetMs(nextLocalMidnight, YOUTUBE_QUOTA_TIME_ZONE);
  candidate = nextLocalMidnight - zonedOffsetMs(candidate, YOUTUBE_QUOTA_TIME_ZONE);
  return candidate;
}

/** Process-local availability state for each configured API key/project. */
export class YouTubeProviderCooldown {
  private readonly providers = new Map<string, { retryAt: number; rateLimitCooldownMs: number; kind: YouTubeProviderFailureKind }>();
  private readonly failureGenerations = new Map<string, number>();

  constructor(private readonly options: YouTubeProviderCooldownOptions) {}

  eligible(key: string): boolean {
    const state = this.providers.get(key);
    if (!state) return true;
    if ((this.options.now ?? Date.now)() < state.retryAt) return false;
    if (state.kind === 'DAILY_QUOTA_EXHAUSTED') this.providers.delete(key);
    return true;
  }

  failed(key: string, kind: YouTubeProviderFailureKind): number {
    const now = (this.options.now ?? Date.now)();
    const previous = this.providers.get(key);
    this.failureGenerations.set(key, this.failureGeneration(key) + 1);
    if (kind === 'DAILY_QUOTA_EXHAUSTED') {
      const retryAt = nextYouTubeDailyQuotaResetAt(now);
      this.providers.set(key, { retryAt, rateLimitCooldownMs: 0, kind });
      return retryAt;
    }
    const initial = Math.max(1, this.options.initialRateLimitCooldownMs);
    const cooldown = previous?.kind === 'RATE_LIMITED' && previous.rateLimitCooldownMs
      ? Math.min(Math.max(initial, this.options.maxRateLimitCooldownMs), previous.rateLimitCooldownMs * 2)
      : initial;
    const retryAt = now + cooldown;
    this.providers.set(key, { retryAt, rateLimitCooldownMs: cooldown, kind });
    return retryAt;
  }

  /** Monotonic per-provider failure generation for stale-success protection. */
  failureGeneration(key: string): number { return this.failureGenerations.get(key) ?? 0; }

  /**
   * Clears provider cooldown/history only when no newer failure has occurred since
   * the caller observed the supplied generation. Returns false for a stale success.
   */
  succeeded(key: string, expectedFailureGeneration?: number): boolean {
    if (expectedFailureGeneration !== undefined && this.failureGeneration(key) !== expectedFailureGeneration) return false;
    this.providers.delete(key);
    return true;
  }

  retryAt(key: string): number { return this.providers.get(key)?.retryAt ?? 0; }

  status(key: string): { status: YouTubeProviderOperationalStatus; retryAt: number | null } {
    if (this.eligible(key)) return { status: 'Active', retryAt: null };
    const state = this.providers.get(key)!;
    return {
      status: state.kind === 'DAILY_QUOTA_EXHAUSTED' ? 'Daily Quota Exhausted' : 'Cooling Down',
      retryAt: state.retryAt
    };
  }

  earliestRetryAtIfAllCooling(keys: string[]): number | null {
    if (!keys.length || keys.some(key => this.eligible(key))) return null;
    return Math.min(...keys.map(key => this.retryAt(key)).filter(retryAt => retryAt > 0));
  }
}

export class YouTubeProvidersCoolingDownError extends Error {
  readonly code = 'YOUTUBE_PROVIDERS_COOLING_DOWN';
  readonly retryable = true;
  readonly errorClass = 'RATE_LIMIT';
  readonly retryAfterMs: number;
  constructor(public readonly retryAt: number) {
    super(`Every configured YouTube provider is cooling down; retry is scheduled for ${new Date(retryAt).toISOString()}.`);
    this.name = 'YouTubeProvidersCoolingDownError';
    this.retryAfterMs = Math.max(0, retryAt - Date.now());
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
