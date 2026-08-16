export type YouTubeProviderFailureKind = 'RATE_LIMITED' | 'DAILY_QUOTA_EXHAUSTED';
export type YouTubeProviderOperationalStatus = 'Active' | 'Cooling Down' | 'Daily Quota Exhausted';

export interface YouTubeProviderCooldownOptions {
  initialRateLimitCooldownMs: number;
  maxRateLimitCooldownMs: number;
  /** Short fixed pause for runtime/egress request-rate pressure. */
  runtimeRateLimitPauseMs?: number;
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

/**
 * Process-local provider availability.
 *
 * Daily quota exhaustion is project-specific and removes only that provider
 * until the next YouTube quota day. A generic request-rate limit is different:
 * it is shared by this runtime/egress identity, so rotating through every API
 * project cannot clear it. RATE_LIMITED therefore creates one short, fixed
 * runtime pause instead of poisoning each otherwise-healthy key with an
 * exponential provider-local cooldown.
 *
 * The request scheduler absorbs the resulting all-provider cooling signal and
 * retries the same logical work after the pause. This restores the historical
 * anti-churn behavior while keeping daily quota isolation per project.
 */
export class YouTubeProviderCooldown {
  private readonly providers = new Map<string, { retryAt: number; kind: 'DAILY_QUOTA_EXHAUSTED' }>();
  private readonly failureGenerations = new Map<string, number>();
  private runtimeRateLimitRetryAt = 0;

  constructor(private readonly options: YouTubeProviderCooldownOptions) {}

  private now(): number { return (this.options.now ?? Date.now)(); }

  private activeRuntimeRateLimitRetryAt(): number {
    const now = this.now();
    if (this.runtimeRateLimitRetryAt <= now) {
      this.runtimeRateLimitRetryAt = 0;
      return 0;
    }
    return this.runtimeRateLimitRetryAt;
  }

  private activeProviderState(key: string): { retryAt: number; kind: 'DAILY_QUOTA_EXHAUSTED' } | undefined {
    const state = this.providers.get(key);
    if (!state) return undefined;
    if (this.now() >= state.retryAt) {
      this.providers.delete(key);
      return undefined;
    }
    return state;
  }

  eligible(key: string): boolean {
    if (this.activeRuntimeRateLimitRetryAt() > 0) return false;
    return !this.activeProviderState(key);
  }

  failed(key: string, kind: YouTubeProviderFailureKind): number {
    const now = this.now();
    this.failureGenerations.set(key, this.failureGeneration(key) + 1);
    if (kind === 'DAILY_QUOTA_EXHAUSTED') {
      const retryAt = nextYouTubeDailyQuotaResetAt(now);
      this.providers.set(key, { retryAt, kind });
      return retryAt;
    }

    // A runtime/egress 429 is not project-local. Pause all outbound YouTube
    // starts briefly, then retry with the healthy pool intact. This pause is
    // deliberately fixed rather than exponential so long global backoff cannot
    // return while still preventing rapid key-by-key churn.
    const configuredPause = this.options.runtimeRateLimitPauseMs ?? this.options.initialRateLimitCooldownMs;
    const pauseMs = Math.max(1, Math.min(configuredPause, Math.max(1, this.options.maxRateLimitCooldownMs)));
    this.runtimeRateLimitRetryAt = Math.max(this.runtimeRateLimitRetryAt, now + pauseMs);
    return this.runtimeRateLimitRetryAt;
  }

  /** Monotonic per-provider failure generation for stale-success protection. */
  failureGeneration(key: string): number { return this.failureGenerations.get(key) ?? 0; }

  /**
   * A successful response may clear only project-specific state owned by the
   * same generation. It must not clear a runtime pause raised by another
   * concurrent request.
   */
  succeeded(key: string, expectedFailureGeneration?: number): boolean {
    if (expectedFailureGeneration !== undefined && this.failureGeneration(key) !== expectedFailureGeneration) return false;
    this.providers.delete(key);
    return true;
  }

  retryAt(key: string): number {
    return Math.max(this.activeRuntimeRateLimitRetryAt(), this.activeProviderState(key)?.retryAt ?? 0);
  }

  status(key: string): { status: YouTubeProviderOperationalStatus; retryAt: number | null } {
    // Provider-specific daily exhaustion is more authoritative than a shorter
    // runtime-wide pause. Keep the real daily reset visible in Queue Monitor.
    const state = this.activeProviderState(key);
    if (state) return { status: 'Daily Quota Exhausted', retryAt: state.retryAt };

    const runtimeRetryAt = this.activeRuntimeRateLimitRetryAt();
    if (runtimeRetryAt > 0) return { status: 'Cooling Down', retryAt: runtimeRetryAt };
    return { status: 'Active', retryAt: null };
  }

  earliestRetryAtIfAllCooling(keys: string[]): number | null {
    if (!keys.length) return null;
    const runtimeRetryAt = this.activeRuntimeRateLimitRetryAt();
    const now = this.now();
    const effectiveRetryTimes = keys.map(key => {
      const providerRetryAt = this.activeProviderState(key)?.retryAt ?? 0;
      return Math.max(runtimeRetryAt, providerRetryAt);
    });

    if (effectiveRetryTimes.some(retryAt => retryAt <= now)) return null;
    return Math.min(...effectiveRetryTimes);
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
  maxRateLimitCooldownMs: nonNegativeNumber(process.env.YOUTUBE_RATE_LIMIT_MAX_BACKOFF_MS, 5 * 60_000),
  runtimeRateLimitPauseMs: nonNegativeNumber(process.env.YOUTUBE_RUNTIME_RATE_LIMIT_PAUSE_MS, 1_000)
});
