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
  runtimeRateLimitFloorMs?: number;
  maxAdaptiveIntervalMs?: number;
  adaptiveRecoverySuccesses?: number;
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

function sharedRuntimeCoolingDelayMs(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as { code?: unknown; retryable?: unknown; retryAfterMs?: unknown };
  if (candidate.code !== 'YOUTUBE_PROVIDERS_COOLING_DOWN' || candidate.retryable !== true) return null;
  const retryAfterMs = Number(candidate.retryAfterMs);
  if (!Number.isFinite(retryAfterMs) || retryAfterMs < 0) return null;
  return retryAfterMs;
}

function isRuntimeRateLimit(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth > 4) return false;
  const candidate = error as {
    status?: unknown;
    quotaExceeded?: unknown;
    errorClass?: unknown;
    providerReasons?: unknown;
    cause?: unknown;
  };
  const reasons = Array.isArray(candidate.providerReasons)
    ? candidate.providerReasons.map(reason => String(reason).toLowerCase())
    : [];
  const rateLimited = candidate.errorClass === 'RATE_LIMIT'
    || Number(candidate.status) === 429
    || reasons.some(reason => reason.includes('ratelimit'));
  if (rateLimited && candidate.quotaExceeded !== true) return true;
  return isRuntimeRateLimit(candidate.cause, depth + 1);
}

/**
 * Runtime-wide YouTube request serializer and pressure controller.
 *
 * Daily quota remains provider-specific. Short shared cooling signals are
 * absorbed and retried inside the same logical request. Production also opts
 * into bounded adaptive pacing: repeated real runtime 429s increase spacing
 * between outbound starts, while sustained successes gradually restore the
 * baseline. This keeps work moving without walking the API-key pool at a rate
 * the shared Railway egress identity cannot sustain.
 */
export class YouTubeRequestScheduler {
  private readonly queue: QueuedRequest<unknown>[] = [];
  private processing = false;
  private sequence = 0;
  private nextStartAt = 0;
  private adaptiveIntervalMs = 0;
  private successfulCallsUnderPressure = 0;

  constructor(private readonly options: YouTubeRequestSchedulerOptions) {}

  run<T>(call: () => Promise<T>, trace?: (stage: string) => void, priority: YouTubeRequestPriority = 'enrichment'): Promise<T> {
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

  isRateLimited(): boolean { return false; }
  getCooldownUntil(): number | null { return null; }

  private baseIntervalMs(): number {
    return Math.max(0, this.options.minIntervalMs);
  }

  private currentIntervalMs(): number {
    return Math.max(this.baseIntervalMs(), this.adaptiveIntervalMs);
  }

  private noteRuntimeRateLimit(trace?: (stage: string) => void): void {
    // Keep adaptive pressure control explicit for constructed schedulers. The
    // production singleton opts in below; legacy/unit construction sites that
    // do not provide a floor retain their historical fixed-spacing semantics.
    if (this.options.runtimeRateLimitFloorMs === undefined) return;

    const base = this.baseIntervalMs();
    const floor = Math.max(base, this.options.runtimeRateLimitFloorMs);
    const max = Math.max(floor, this.options.maxAdaptiveIntervalMs ?? 5_000);
    this.adaptiveIntervalMs = this.adaptiveIntervalMs > 0
      ? Math.min(max, Math.max(floor, this.adaptiveIntervalMs * 2))
      : floor;
    this.successfulCallsUnderPressure = 0;

    const now = (this.options.now ?? Date.now)();
    this.nextStartAt = Math.max(this.nextStartAt, now + this.adaptiveIntervalMs);
    trace?.(`adaptive-rate-pressure ${this.adaptiveIntervalMs}ms`);
  }

  private noteSuccessfulCall(trace?: (stage: string) => void): void {
    const base = this.baseIntervalMs();
    if (this.adaptiveIntervalMs <= base) {
      this.adaptiveIntervalMs = 0;
      this.successfulCallsUnderPressure = 0;
      return;
    }

    this.successfulCallsUnderPressure += 1;
    const requiredSuccesses = Math.max(1, Math.floor(this.options.adaptiveRecoverySuccesses ?? 4));
    if (this.successfulCallsUnderPressure < requiredSuccesses) return;

    this.successfulCallsUnderPressure = 0;
    const reduced = Math.floor(this.adaptiveIntervalMs / 2);
    this.adaptiveIntervalMs = reduced <= base ? 0 : Math.max(base, reduced);
    trace?.(`adaptive-rate-recovery ${this.currentIntervalMs()}ms`);
  }

  private takeNextRequest(): QueuedRequest<unknown> | undefined {
    if (!this.queue.length) return undefined;
    const now = (this.options.now ?? Date.now)();
    const starvationMs = Math.max(0, this.options.starvationMs ?? 2_000);

    const manual = this.queue.filter(request => request.priority === 'manual')
      .sort((left, right) => left.sequence - right.sequence)[0];
    if (manual) {
      this.queue.splice(this.queue.indexOf(manual), 1);
      return manual;
    }

    const starved = this.queue.filter(request => now - request.enqueuedAt >= starvationMs)
      .sort((left, right) => left.sequence - right.sequence)[0];
    if (starved) {
      this.queue.splice(this.queue.indexOf(starved), 1);
      return starved;
    }

    const prioritized = [...this.queue].sort(
      (left, right) => PRIORITY[left.priority] - PRIORITY[right.priority] || left.sequence - right.sequence
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
      request.trace?.('before scheduled-call at server/youtubeRequestScheduler.ts:166');
      try {
        const value = await request.call();
        this.noteSuccessfulCall(request.trace);
        request.trace?.('after scheduled-call at server/youtubeRequestScheduler.ts:166');
        request.resolve(value);
        return;
      } catch (error) {
        const coolingDelayMs = sharedRuntimeCoolingDelayMs(error);
        if (coolingDelayMs === null) {
          if (isRuntimeRateLimit(error)) this.noteRuntimeRateLimit(request.trace);
          request.reject(error);
          return;
        }

        const now = (this.options.now ?? Date.now)();
        const pacingDelayMs = Math.max(0, this.nextStartAt - now);
        const waitMs = Math.max(coolingDelayMs, pacingDelayMs);
        request.trace?.(`shared-runtime-cooling-wait ${waitMs}ms`);
        await this.wait(waitMs);
        this.nextStartAt = (this.options.now ?? Date.now)() + this.currentIntervalMs();
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
        let request: QueuedRequest<unknown> | undefined;
        if (waitMs > 0) {
          await this.wait(waitMs);
          request = this.takeNextRequest();
        } else {
          request = this.takeNextRequest();
        }

        if (!request) break;
        request.trace?.('scheduler-tail-released');
        this.nextStartAt = (this.options.now ?? Date.now)() + this.currentIntervalMs();
        await this.runSelectedRequest(request);
      }
    } finally {
      this.processing = false;
      if (this.queue.length) void this.processQueue();
    }
  }
}

const nonNegativeNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

export const youtubeRequestScheduler = new YouTubeRequestScheduler({
  minIntervalMs: nonNegativeNumber(process.env.YOUTUBE_MIN_REQUEST_INTERVAL_MS, 250),
  initialRateLimitBackoffMs: nonNegativeNumber(process.env.YOUTUBE_RATE_LIMIT_BACKOFF_MS, 5_000),
  maxRateLimitBackoffMs: nonNegativeNumber(process.env.YOUTUBE_RATE_LIMIT_MAX_BACKOFF_MS, 5 * 60_000),
  runtimeRateLimitFloorMs: nonNegativeNumber(process.env.YOUTUBE_RUNTIME_RATE_LIMIT_FLOOR_MS, 1_000),
  maxAdaptiveIntervalMs: nonNegativeNumber(process.env.YOUTUBE_MAX_ADAPTIVE_REQUEST_INTERVAL_MS, 5_000),
  adaptiveRecoverySuccesses: nonNegativeNumber(process.env.YOUTUBE_ADAPTIVE_RECOVERY_SUCCESSES, 4),
  starvationMs: nonNegativeNumber(process.env.YOUTUBE_SCHEDULER_STARVATION_MS, 2_000)
});
