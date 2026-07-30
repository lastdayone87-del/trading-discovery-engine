export interface YouTubeRequestSchedulerOptions {
  minIntervalMs: number;
  initialRateLimitBackoffMs: number;
  maxRateLimitBackoffMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * YouTube applies request-rate limits independently from daily project quota.
 * Serialize requests from this runtime so concurrent workers and paired metadata
 * lookups cannot present one shared egress identity as a bursty client.
 */
export class YouTubeRequestScheduler {
  private tail: Promise<void> = Promise.resolve();
  private nextStartAt = 0;
  private rateLimitBackoffMs = 0;

  constructor(private readonly options: YouTubeRequestSchedulerOptions) {}

  run<T>(call: () => Promise<T>, trace?: (stage: string) => void): Promise<T> {
    const scheduled = this.tail.then(async () => {
      trace?.('scheduler-tail-released');
      const now = (this.options.now ?? Date.now)();
      const waitMs = Math.max(0, this.nextStartAt - now);
      if (waitMs) {
        trace?.(`before scheduler-delay (${waitMs}ms) at server/youtubeRequestScheduler.ts:28`);
        await (this.options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(waitMs);
        trace?.('after scheduler-delay at server/youtubeRequestScheduler.ts:28');
      }
      this.nextStartAt = (this.options.now ?? Date.now)() + Math.max(0, this.options.minIntervalMs);
      trace?.('before scheduled-call at server/youtubeRequestScheduler.ts:33');
      const value = await call();
      trace?.('after scheduled-call at server/youtubeRequestScheduler.ts:33');
      return value;
    });
    this.tail = scheduled.then(() => undefined, () => undefined);
    return scheduled;
  }

  rateLimited(): void {
    const initial = Math.max(1, this.options.initialRateLimitBackoffMs);
    this.rateLimitBackoffMs = this.rateLimitBackoffMs
      ? Math.min(Math.max(initial, this.options.maxRateLimitBackoffMs), this.rateLimitBackoffMs * 2)
      : initial;
    this.nextStartAt = Math.max(this.nextStartAt, (this.options.now ?? Date.now)() + this.rateLimitBackoffMs);
  }

  succeeded(): void { this.rateLimitBackoffMs = 0; }
}

const nonNegativeNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

export const youtubeRequestScheduler = new YouTubeRequestScheduler({
  minIntervalMs: nonNegativeNumber(process.env.YOUTUBE_MIN_REQUEST_INTERVAL_MS, 250),
  initialRateLimitBackoffMs: nonNegativeNumber(process.env.YOUTUBE_RATE_LIMIT_BACKOFF_MS, 5_000),
  maxRateLimitBackoffMs: nonNegativeNumber(process.env.YOUTUBE_RATE_LIMIT_MAX_BACKOFF_MS, 5 * 60_000)
});
