import { getYouTubeQuotaGroupForKey } from './youtubeKeyPool';

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
  ratePressureWindowMs?: number;
  quotaGroupForProvider?: (providerKey: string) => string | undefined;
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

interface RuntimeRateLimitObservation {
  at: number;
  providerFingerprint: string;
  quotaGroupFingerprint?: string;
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

interface RuntimeRateLimitDetails {
  providerKey?: string;
  providerReasons: string[];
  status?: number;
}

function runtimeRateLimitDetails(error: unknown, depth = 0): RuntimeRateLimitDetails | null {
  if (!error || typeof error !== 'object' || depth > 4) return null;
  const candidate = error as {
    status?: unknown;
    quotaExceeded?: unknown;
    errorClass?: unknown;
    providerReasons?: unknown;
    providerKey?: unknown;
    cause?: unknown;
  };
  const reasons = Array.isArray(candidate.providerReasons)
    ? candidate.providerReasons.map(reason => String(reason))
    : [];
  const normalizedReasons = reasons.map(reason => reason.toLowerCase());
  const rateLimited = candidate.errorClass === 'RATE_LIMIT'
    || Number(candidate.status) === 429
    || normalizedReasons.some(reason => reason.includes('ratelimit'));
  const nested = runtimeRateLimitDetails(candidate.cause, depth + 1);
  if (rateLimited && candidate.quotaExceeded !== true) {
    return {
      providerKey: typeof candidate.providerKey === 'string' ? candidate.providerKey : nested?.providerKey,
      providerReasons: reasons.length ? reasons : (nested?.providerReasons ?? []),
      status: Number.isFinite(Number(candidate.status)) ? Number(candidate.status) : nested?.status
    };
  }
  return nested;
}

function stableFingerprint(value: string, prefix: 'ytp' | 'ytq'): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${prefix}-${hash.toString(16).padStart(8, '0')}`;
}

function providerFingerprint(providerKey: string | undefined): string {
  return providerKey ? stableFingerprint(providerKey, 'ytp') : 'unknown';
}

function sanitizeProviderReasons(reasons: string[]): string {
  if (!reasons.length) return 'unknown';
  return [...new Set(reasons.map(reason => reason.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48)).filter(Boolean))]
    .slice(0, 4)
    .join(',') || 'unknown';
}

export class YouTubeRequestScheduler {
  private readonly queue: QueuedRequest<unknown>[] = [];
  private processing = false;
  private sequence = 0;
  private nextStartAt = 0;
  private adaptiveIntervalMs = 0;
  private successfulCallsUnderPressure = 0;
  private lastDispatchAt: number | null = null;
  private lastSuccessfulCallAt: number | null = null;
  private readonly recentRuntimeRateLimits: RuntimeRateLimitObservation[] = [];

  constructor(private readonly options: YouTubeRequestSchedulerOptions) {}

  run<T>(call: () => Promise<T>, trace?: (stage: string) => void, priority: YouTubeRequestPriority = 'enrichment'): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ call, trace, priority, sequence: this.sequence++, enqueuedAt: (this.options.now ?? Date.now)(), resolve, reject });
      void this.processQueue();
    });
  }

  isRateLimited(): boolean { return false; }
  getCooldownUntil(): number | null { return null; }

  getRatePressureSnapshot(): {
    adaptiveIntervalMs: number;
    recent429s: number;
    affectedProviders: number;
    affectedQuotaGroups: number;
    unattributedProviderObservations: number;
    lastSuccessfulCallAt: number | null;
    lastDispatchAt: number | null;
  } {
    const now = (this.options.now ?? Date.now)();
    this.trimRuntimeRateLimits(now);
    return {
      adaptiveIntervalMs: this.currentIntervalMs(),
      recent429s: this.recentRuntimeRateLimits.length,
      affectedProviders: new Set(this.recentRuntimeRateLimits.map(item => item.providerFingerprint)).size,
      affectedQuotaGroups: new Set(this.recentRuntimeRateLimits.map(item => item.quotaGroupFingerprint).filter((value): value is string => Boolean(value))).size,
      unattributedProviderObservations: this.recentRuntimeRateLimits.filter(item => !item.quotaGroupFingerprint).length,
      lastSuccessfulCallAt: this.lastSuccessfulCallAt,
      lastDispatchAt: this.lastDispatchAt
    };
  }

  private baseIntervalMs(): number { return Math.max(0, this.options.minIntervalMs); }
  private currentIntervalMs(): number { return Math.max(this.baseIntervalMs(), this.adaptiveIntervalMs); }
  private pressureWindowMs(): number { return Math.max(1_000, this.options.ratePressureWindowMs ?? 60_000); }

  private trimRuntimeRateLimits(now: number): void {
    const cutoff = now - this.pressureWindowMs();
    while (this.recentRuntimeRateLimits.length && this.recentRuntimeRateLimits[0].at < cutoff) this.recentRuntimeRateLimits.shift();
  }

  private noteRuntimeRateLimit(details: RuntimeRateLimitDetails, actualSpacingMs: number | null, priority: YouTubeRequestPriority, trace?: (stage: string) => void): void {
    const base = this.baseIntervalMs();

    // Preserve #244's explicit opt-in contract: constructed schedulers that do
    // not provide a runtime floor keep their historical fixed-spacing behavior.
    // Diagnostics still record the 429 below, so observability is independent
    // from whether adaptive pacing is enabled for this scheduler instance.
    if (this.options.runtimeRateLimitFloorMs !== undefined) {
      const floor = Math.max(base, this.options.runtimeRateLimitFloorMs);
      const max = Math.max(floor, this.options.maxAdaptiveIntervalMs ?? 5_000);
      this.adaptiveIntervalMs = this.adaptiveIntervalMs > 0
        ? Math.min(max, Math.max(floor, this.adaptiveIntervalMs * 2))
        : floor;
      this.successfulCallsUnderPressure = 0;

      const pressureNow = (this.options.now ?? Date.now)();
      this.nextStartAt = Math.max(this.nextStartAt, pressureNow + this.adaptiveIntervalMs);
      trace?.(`adaptive-rate-pressure ${this.adaptiveIntervalMs}ms`);
    }

    const now = (this.options.now ?? Date.now)();
    const fingerprint = providerFingerprint(details.providerKey);
    const quotaGroup = details.providerKey
      ? (this.options.quotaGroupForProvider ?? getYouTubeQuotaGroupForKey)(details.providerKey)
      : undefined;
    const quotaGroupFingerprint = quotaGroup ? stableFingerprint(quotaGroup, 'ytq') : undefined;
    this.recentRuntimeRateLimits.push({ at: now, providerFingerprint: fingerprint, quotaGroupFingerprint });
    this.trimRuntimeRateLimits(now);
    const snapshot = this.getRatePressureSnapshot();
    trace?.(
      `runtime-rate-pressure-diagnostic status=${details.status ?? 429} quota=false provider=${fingerprint}`
      + ` quota-group=${quotaGroupFingerprint ?? 'unconfigured'}`
      + ` reasons=${sanitizeProviderReasons(details.providerReasons)}`
      + ` actual-spacing-ms=${actualSpacingMs ?? 'first'}`
      + ` target-spacing-ms=${this.currentIntervalMs()}`
      + ` recent-429s-${Math.round(this.pressureWindowMs() / 1000)}s=${snapshot.recent429s}`
      + ` affected-providers=${snapshot.affectedProviders}`
      + ` affected-quota-groups=${snapshot.affectedQuotaGroups}`
      + ` unattributed-provider-observations=${snapshot.unattributedProviderObservations}`
      + ` priority=${priority}`
    );
  }

  private noteSuccessfulCall(trace?: (stage: string) => void): void {
    const now = (this.options.now ?? Date.now)();
    this.lastSuccessfulCallAt = now;
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
    const manual = this.queue.filter(request => request.priority === 'manual').sort((left, right) => left.sequence - right.sequence)[0];
    if (manual) { this.queue.splice(this.queue.indexOf(manual), 1); return manual; }
    const starved = this.queue.filter(request => now - request.enqueuedAt >= starvationMs).sort((left, right) => left.sequence - right.sequence)[0];
    if (starved) { this.queue.splice(this.queue.indexOf(starved), 1); return starved; }
    const prioritized = [...this.queue].sort((left, right) => PRIORITY[left.priority] - PRIORITY[right.priority] || left.sequence - right.sequence)[0];
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
      const dispatchAt = (this.options.now ?? Date.now)();
      const actualSpacingMs = this.lastDispatchAt === null ? null : Math.max(0, dispatchAt - this.lastDispatchAt);
      this.lastDispatchAt = dispatchAt;
      try {
        const value = await request.call();
        this.noteSuccessfulCall(request.trace);
        request.trace?.('after scheduled-call at server/youtubeRequestScheduler.ts:166');
        request.resolve(value);
        return;
      } catch (error) {
        const coolingDelayMs = sharedRuntimeCoolingDelayMs(error);
        if (coolingDelayMs === null) {
          const details = runtimeRateLimitDetails(error);
          if (details) this.noteRuntimeRateLimit(details, actualSpacingMs, request.priority, request.trace);
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
        if (waitMs > 0) { await this.wait(waitMs); request = this.takeNextRequest(); }
        else request = this.takeNextRequest();
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
  ratePressureWindowMs: nonNegativeNumber(process.env.YOUTUBE_RATE_PRESSURE_WINDOW_MS, 60_000),
  starvationMs: nonNegativeNumber(process.env.YOUTUBE_SCHEDULER_STARVATION_MS, 2_000)
});
