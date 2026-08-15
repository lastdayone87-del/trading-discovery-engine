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

/**
 * Serialize YouTube requests from this runtime so concurrent workers and paired
 * metadata lookups cannot present one shared egress identity as a bursty client.
 *
 * Provider-specific quota/rate-limit health is intentionally owned by
 * youtubeProviderCooldown. A 429 from one configured API key must not impose a
 * process-wide scheduler cooldown before the same operation can fail over to a
 * different healthy key. The scheduler therefore owns pacing/fairness only.
 *
 * Manual requests keep their explicit fast-path priority, but all other lanes
 * become FIFO once they have waited beyond the starvation ceiling. Selection is
 * performed after the shared pacing delay so starvation is reconsidered before
 * every outbound call.
 */
export class YouTubeRequestScheduler {
  private readonly queue: QueuedRequest<unknown>[] = [];
  private processing = false;
  private sequence = 0;
  private nextStartAt = 0;

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

  // Kept for incident-recovery callers that use scheduler health as an input.
  // Per-provider cooldown is authoritative, so the shared scheduler itself is
  // never globally rate-limited by an individual key's 429.
  isRateLimited(): boolean { return false; }
  getCooldownUntil(): number | null { return null; }

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
          'before scheduled-call at server/youtubeRequestScheduler.ts:116'
        );

        try {
          const value = await request.call();
          request.trace?.(
            'after scheduled-call at server/youtubeRequestScheduler.ts:116'
          );
          request.resolve(value);
        } catch (error) {
          request.reject(error);
        }
      }
    } finally {
      this.processing = false;
      if (this.queue.length) void this.processQueue();
    }
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
  // Retained in the options contract for compatibility with existing tests and
  // construction sites; provider cooldown now owns rate-limit backoff.
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
