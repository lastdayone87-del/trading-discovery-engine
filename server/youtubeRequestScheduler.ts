export type YouTubeRequestPriority =
  | 'manual'
  | 'autonomous'
  | 'enrichment'
  | 'incident-recovery';

export interface YouTubeRequestSchedulerOptions {
  minIntervalMs: number;
  initialRateLimitBackoffMs: number;
  maxRateLimitBackoffMs: number;
  starvationMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const PRIORITY: Record<YouTubeRequestPriority, number> = {
  manual: 0,
  autonomous: 1,
  enrichment: 2,
  'incident-recovery': 3
};

interface QueuedRequest<T> {
  call: () => Promise<T>;
  trace?: (stage: string) => void;
  priority: YouTubeRequestPriority;
  sequence: number;
  enqueuedAt: number;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function isRuntimeYouTubeRateLimit(error: unknown): boolean {
  let current: any = error;
  for (let depth = 0; current && depth < 5; depth++, current = current.cause) {
    if (current.quotaExceeded === true) return false;
    if (current.status === 429) return true;
    if (
      Array.isArray(current.providerReasons)
      && current.providerReasons.some((reason: unknown) =>
        /^rateLimitExceeded$/i.test(String(reason))
      )
    ) return true;
  }
  return false;
}

/**
 * YouTube applies request-rate limits independently from daily project quota.
 * Serialize requests from this runtime so concurrent workers and paired metadata
 * lookups cannot present one shared egress identity as a bursty client.
 *
 * Manual requests keep their explicit fast-path priority, but all other lanes
 * become FIFO once they have waited beyond the starvation ceiling. Selection is
 * performed only after shared pacing/rate-limit delay has elapsed, so a request
 * that becomes starved during a long cooldown is reconsidered before the next
 * outbound call starts.
 */
export class YouTubeRequestScheduler {
  private readonly queue: QueuedRequest<unknown>[] = [];
  private processing = false;
  private sequence = 0;
  private nextStartAt = 0;
  private rateLimitBackoffMs = 0;

  constructor(private readonly options: YouTubeRequestSchedulerOptions) {}

  run<T>(
    call: () => Promise<T>,
    trace?: (stage: string) => void,
    priority: YouTubeRequestPriority = 'enrichment'
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        call,
        trace,
        priority,
        sequence: this.sequence++,
        enqueuedAt: (this.options.now ?? Date.now)(),
        resolve,
        reject
      });
      void this.processQueue();
    });
  }

  isRateLimited(): boolean {
    return this.rateLimitBackoffMs > 0
      && this.nextStartAt > (this.options.now ?? Date.now)();
  }

  getCooldownUntil(): number | null {
    return this.isRateLimited() ? this.nextStartAt : null;
  }

  private takeNextRequest(): QueuedRequest<unknown> | undefined {
    if (!this.queue.length) return undefined;
    const now = (this.options.now ?? Date.now)();
    const starvationMs = Math.max(0, this.options.starvationMs ?? 2_000);

    const manual = this.queue
      .filter(request => request.priority === 'manual')
      .sort((left, right) => left.sequence - right.sequence)[0];
    if (manual) {
      this.queue.splice(this.queue.indexOf(manual), 1);
      return manual;
    }

    const starved = this.queue
      .filter(request => now - request.enqueuedAt >= starvationMs)
      .sort((left, right) => left.sequence - right.sequence)[0];
    if (starved) {
      this.queue.splice(this.queue.indexOf(starved), 1);
      return starved;
    }

    const prioritized = [...this.queue].sort(
      (left, right) =>
        PRIORITY[left.priority] - PRIORITY[right.priority]
        || left.sequence - right.sequence
    )[0];
    this.queue.splice(this.queue.indexOf(prioritized), 1);
    return prioritized;
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.queue.length) {
        const now = (this.options.now ?? Date.now)();
        const waitMs = Math.max(0, this.nextStartAt - now);
        if (waitMs) {
          await (
            this.options.sleep
            ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
          )(waitMs);
        }

        const request = this.takeNextRequest();
        if (!request) break;
        request.trace?.('scheduler-tail-released');

        this.nextStartAt =
          (this.options.now ?? Date.now)()
          + Math.max(0, this.options.minIntervalMs);
        request.trace?.(
          'before scheduled-call at server/youtubeRequestScheduler.ts:127'
        );

        try {
          const value = await request.call();
          this.succeeded();
          request.trace?.(
            'after scheduled-call at server/youtubeRequestScheduler.ts:127'
          );
          request.resolve(value);
        } catch (error) {
          if (isRuntimeYouTubeRateLimit(error)) this.rateLimited();
          request.reject(error);
        }
      }
    } finally {
      this.processing = false;
      if (this.queue.length) void this.processQueue();
    }
  }

  rateLimited(): void {
    const initial = Math.max(1, this.options.initialRateLimitBackoffMs);
    this.rateLimitBackoffMs = this.rateLimitBackoffMs
      ? Math.min(
          Math.max(initial, this.options.maxRateLimitBackoffMs),
          this.rateLimitBackoffMs * 2
        )
      : initial;
    this.nextStartAt = Math.max(
      this.nextStartAt,
      (this.options.now ?? Date.now)() + this.rateLimitBackoffMs
    );
  }

  succeeded(): void {
    this.rateLimitBackoffMs = 0;
  }
}

const nonNegativeNumber = (
  value: string | undefined,
  fallback: number
): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

export const youtubeRequestScheduler = new YouTubeRequestScheduler({
  minIntervalMs: nonNegativeNumber(
    process.env.YOUTUBE_MIN_REQUEST_INTERVAL_MS,
    250
  ),
  initialRateLimitBackoffMs: nonNegativeNumber(
    process.env.YOUTUBE_RATE_LIMIT_BACKOFF_MS,
    5_000
  ),
  maxRateLimitBackoffMs: nonNegativeNumber(
    process.env.YOUTUBE_RATE_LIMIT_MAX_BACKOFF_MS,
    5 * 60_000
  ),
  starvationMs: nonNegativeNumber(
    process.env.YOUTUBE_SCHEDULER_STARVATION_MS,
    2_000
  )
});
