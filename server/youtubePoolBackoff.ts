export interface YouTubePoolBackoffOptions {
  initialBackoffMs: number;
  maxBackoffMs: number;
  now?: () => number;
  log?: (level: 'warn' | 'info', message: string) => void;
}

export type YouTubeProviderFailure = 'QUOTA_EXHAUSTED' | 'INDETERMINATE';

/** An acquisition-scoped view of one breaker generation. */
export interface YouTubePoolAcquisition {
  readonly generation: number;
  providerSucceeded(): void;
  providerFailed(failure: YouTubeProviderFailure): void;
  release(): void;
}

/** A process-local circuit breaker for the shared YouTube API-project pool. */
export class YouTubePoolBackoff {
  private retryAt = 0;
  private backoffMs = 0;
  private probeInFlight: symbol | null = null;
  private exhausted = false;
  private generation = 0;

  constructor(private readonly options: YouTubePoolBackoffOptions) {}

  beginAcquisition(): YouTubePoolAcquisition {
    const now = (this.options.now ?? Date.now)();
    let probeId: symbol | null = null;
    if (this.exhausted) {
      if (now < this.retryAt || this.probeInFlight) throw new YouTubePoolExhaustedError(this.retryAt);
      // Only one caller may probe after the window. The scoped handle releases
      // this lease even when the caller exits before it can classify an outcome.
      probeId = Symbol('youtube-pool-probe');
      this.probeInFlight = probeId;
    }

    const acquisitionGeneration = this.generation;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (probeId && this.probeInFlight === probeId) this.probeInFlight = null;
    };

    return {
      generation: acquisitionGeneration,
      providerSucceeded: () => {
        if (released || acquisitionGeneration !== this.generation) return;
        const wasExhausted = this.exhausted;
        // Advancing the generation makes every older concurrent failure stale.
        this.generation++;
        this.exhausted = false;
        this.retryAt = 0;
        this.backoffMs = 0;
        release();
        if (wasExhausted) this.options.log?.('info', '[YouTube API Pool] Quota probe succeeded; YouTube acquisition resumed.');
      },
      providerFailed: failure => {
        if (released || acquisitionGeneration !== this.generation) return;
        // Generic failures open/extend the breaker only for an admitted recovery
        // probe. Normal closed-state transport failures retain the retry path.
        if (failure !== 'QUOTA_EXHAUSTED' && !this.exhausted) return;
        const first = !this.exhausted;
        this.exhausted = true;
        const initial = Math.max(1, this.options.initialBackoffMs);
        this.backoffMs = first ? initial : Math.min(Math.max(initial, this.options.maxBackoffMs), Math.max(initial, this.backoffMs * 2));
        this.retryAt = (this.options.now ?? Date.now)() + this.backoffMs;
        release();
        if (first) this.options.log?.('warn', `[YouTube API Pool] Every configured API project reported quotaExceeded; acquisition suspended until ${new Date(this.retryAt).toISOString()}.`);
      },
      release
    };
  }

  getRetryAt(): number { return this.retryAt; }
}

export class YouTubePoolExhaustedError extends Error {
  readonly code = 'YOUTUBE_PROVIDER_POOL_EXHAUSTED';
  constructor(public readonly retryAt: number) {
    super(`YouTube API project pool is quota-exhausted; next probe is scheduled for ${new Date(retryAt).toISOString()}.`);
    this.name = 'YouTubePoolExhaustedError';
  }
}

const positiveNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const youtubePoolBackoff = new YouTubePoolBackoff({
  initialBackoffMs: positiveNumber(process.env.YOUTUBE_POOL_BACKOFF_MS, 15 * 60_000),
  maxBackoffMs: positiveNumber(process.env.YOUTUBE_POOL_MAX_BACKOFF_MS, 6 * 60 * 60_000),
  log: (level, message) => level === 'warn' ? console.warn(message) : console.info(message)
});

export function isQuotaExceeded(error: unknown): boolean {
  let current: any = error;
  for (let depth = 0; current && depth < 5; depth++, current = current.cause) {
    if (current.quotaExceeded === true || /quotaExceeded|dailyLimitExceeded/i.test(String(current.message ?? ''))) return true;
  }
  return false;
}
