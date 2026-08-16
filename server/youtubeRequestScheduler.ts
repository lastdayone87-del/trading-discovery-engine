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

const sleepFor = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * This error is emitted before an HTTP dispatch when youtubeProviderCooldown
 * says the shared runtime/egress rate-limit pause is still active. It is not a
 * provider failure and therefore must not escape to provider failover loops,
 * where it would make the same operation churn through every configured key.
 */
function sharedRuntimeCoolingDelayMs(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as {
    code?: unknown;
    retryable?: unknown;
    retryAfterMs?: unknown;
  };
  if (
    candidate.code !== 'YOUTUBE_PROVIDERS_COOLING_DOWN'
    || candidate.retryable !== true
  ) return null;
  const retryAfterMs = Number(candidate.retryAfterMs);
  if (!Number.isFinite(retryAfterMs) || retryAfterMs < 0) return null;
  return retryAfterMs;
}

/**
 * Serialize YouTube requests from this runtime so concurrent workers and paired
 * metadata lookups cannot present one shared egress identity as a bursty client.
 *
 * Daily quota exhaustion remains provider-specific in youtubeProviderCooldown.
 * Generic runtime/egress 429s create a short shared pause there. If a queued
 * request reaches dispatch while that shared pause is active, the scheduler
 * waits for the pause and retries the same logical request instead of returning
 * the pre-dispatch cooling error to a provider loop and walking every API key.
 * Raw provider 429s still escape normally so youtube.ts can record the failure
 * and apply its ordinary failover/retry policy.
 *
 * Manual requests keep their explicit fast-path priority, but all other lanes
 * become FIFO once they have waited beyond the starvation ceiling. When a
 * pacing delay is actually required, selection is performed after that delay so
 * starvation is reconsidered immediately before the next outbound call. When
 * the scheduler is idle and no pacing delay is due, the first request is claimed
 * synchronously so later arrivals cannot overtake work that is already active.
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
  // Provider cooldown remains authoritative; short shared runtime pauses are
  // consumed internally and are not exposed as a long-lived scheduler state.
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

  private async wait(ms: number): Promise<void> {
    if (ms <= 0) return;
    await (this.options.sleep ?? sleepFor)(ms);
  }

  private async runSelectedRequest(request: QueuedRequest<unknown>): Promise<void> {
    for (;;) {
      request.trace?.(
        'before scheduled-call at server/youtubeRequestScheduler.ts:166'
      );
      try {
        const value = await request.call();
        request.trace?.(
          'after scheduled-call at server/youtubeRequestScheduler.ts:166'
        );
        request.resolve(value);
        return;
      } catch (error) {
        const coolingDelayMs = sharedRuntimeCoolingDelayMs(error);
        if (coolingDelayMs === null) {
          request.reject(error);
          return;
        }

        // This is a pre-dispatch shared-pause signal, not a failed provider
        // attempt. Keep the logical request inside the scheduler until the
        // pause expires so outer key loops cannot churn through the pool.
        const now = (this.options.now ?? Date.now)();
        const pacingDelayMs = Math.max(0, this.nextStartAt - now);
        const waitMs = Math.max(coolingDelayMs, pacingDelayMs);
        request.trace?.(`shared-runtime-cooling-wait ${waitMs}ms`);
        await this.wait(waitMs);

        this.nextStartAt =
          (this.options.now ?? Date.now)()
          + Math.max(0, this.options.minIntervalMs);
        request.trace?.('shared-runtime-cooling-retry');
      }
    }
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.queue.length) {
        const now = (this.options.now ?? Date.now)();
        const waitMs = Math.max(0, this.nextStartAt - now);

        // Do not yield before claiming work that can start immediately. An
        // unconditional `await wait(0)` lets later, higher-priority arrivals
        // overtake the request that made the scheduler active. If pacing is
        // required, however, deliberately wait first and then select so aging
        // and starvation are evaluated against the post-delay clock.
        let request: QueuedRequest<unknown> | undefined;
        if (waitMs > 0) {
          await this.wait(waitMs);
          request = this.takeNextRequest();
        } else {
          request = this.takeNextRequest();
        }

        if (!request) break;
        request.trace?.('scheduler-tail-released');

        this.nextStartAt =
          (this.options.now ?? Date.now)()
          + Math.max(0, this.options.minIntervalMs);

        await this.runSelectedRequest(request);
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
  // construction sites; provider cooldown owns actual rate-limit state.
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
