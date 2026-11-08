import type { SemanticModelClient, SemanticObservabilityContext } from './providers/GeminiSemanticProvider';
import { isSemanticResultShape } from './semanticResultShape';

/**
 * Marks a result that was returned as one element of a multi-channel batch.
 * The marker is non-enumerable so it never reaches JSON, structural
 * validation, or persisted evidence, and provider caches can exclude results
 * whose realized request included sibling channels.
 */
const SEMANTIC_BATCH_RESULT_MARKER = Symbol.for('trading-discovery-engine.semantic-batch-result');

export function markSemanticBatchResult(value: unknown, batchSize: number): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  Object.defineProperty(value, SEMANTIC_BATCH_RESULT_MARKER, {
    value: { batchSize: Math.max(1, Math.floor(Number(batchSize) || 1)) },
    enumerable: false,
    configurable: true,
  });
}

export function semanticResultWasBatched(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const marker = (value as Record<symbol, { batchSize?: number } | undefined>)[SEMANTIC_BATCH_RESULT_MARKER];
  return Number(marker?.batchSize) > 1;
}

/**
 * Phase 4 semantic batching.
 *
 * Several enrichment workers run inside one process. A short, bounded
 * coalescing window groups independent channel prompts into one provider
 * call, cutting quota consumption by the realized batch factor. Each prompt
 * remains self-contained and each result is parsed independently: one bad
 * array element falls back to its own single call and never contaminates a
 * sibling channel.
 *
 * Opt-in. Default off until the labeled prefilter/shadow measurements and the
 * enrichment scale gate show provider headroom.
 */
export const SEMANTIC_BATCH_PROMPT_VERSION = 'semantic-batch-array-1';
export const DEFAULT_SEMANTIC_BATCH_WINDOW_MS = 400;
/**
 * Serialized-size budget for one provider batch. Item count alone is not a
 * bound: ten evidence-heavy prompts can exceed a provider request limit, and
 * an oversized batch fails as one call (rejecting every channel in it). The
 * scheduler splits on this budget before dispatch; a single oversized prompt
 * still travels alone so it can only fail itself.
 */
export const DEFAULT_SEMANTIC_BATCH_MAX_PROMPT_CHARS = 120_000;
/**
 * Citation-repair prompts are a plain-text header followed by the original
 * structured request. The marker is shared with the repair-prompt builder so
 * batch capping can split the instructions from the embedded request and
 * shorten nested documents while keeping the embedded JSON parseable.
 */
export const SEMANTIC_REPAIR_REQUEST_MARKER = ' Original request: ';

export interface SemanticBatchConfig {
  enabled: boolean;
  maxSize: number;
  windowMs: number;
  maxPromptChars: number;
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function semanticBatchConfig(env: NodeJS.ProcessEnv = process.env): SemanticBatchConfig {
  return {
    enabled: env.SEMANTIC_BATCH_CLASSIFICATION_ENABLED === 'true',
    maxSize: clamp(Number(env.SEMANTIC_BATCH_MAX_SIZE || '8'), 2, 10, 8),
    // The scheduler window is paid out of the 2s stage-0 semantic attempt
    // budget and may never exceed it: a longer window would let the caller
    // abort before the provider call even starts. Keep the default small
    // enough that inference still has most of the attempt window; operators
    // can raise it up to the attempt budget when quota, not latency, is the
    // bottleneck.
    windowMs: clamp(Number(env.SEMANTIC_BATCH_WINDOW_MS || String(DEFAULT_SEMANTIC_BATCH_WINDOW_MS)), 0, 2_000, DEFAULT_SEMANTIC_BATCH_WINDOW_MS),
    maxPromptChars: clamp(Number(env.SEMANTIC_BATCH_MAX_PROMPT_CHARS || String(DEFAULT_SEMANTIC_BATCH_MAX_PROMPT_CHARS)), 20_000, 400_000, DEFAULT_SEMANTIC_BATCH_MAX_PROMPT_CHARS),
  };
}

function parsePrompt(prompt: string): unknown {
  try {
    return JSON.parse(prompt);
  } catch {
    const markerIndex = prompt.indexOf(SEMANTIC_REPAIR_REQUEST_MARKER);
    if (markerIndex >= 0) {
      const raw = prompt.slice(0, markerIndex + SEMANTIC_REPAIR_REQUEST_MARKER.length);
      try {
        const repairRequest = JSON.parse(prompt.slice(raw.length));
        if (repairRequest && typeof repairRequest === 'object' && !Array.isArray(repairRequest)) {
          // Keep the instructions and the embedded request separable so the
          // batch cap can shorten nested document text instead of truncating
          // the tail (which would remove citations the repair must reuse).
          return { raw, repairRequest };
        }
      } catch {
        // The tail is not a standalone request; keep the prompt as raw text.
      }
    }
    return { raw: String(prompt || '') };
  }
}

/**
 * One provider request containing N independent classification requests.
 * The array schema is explicit so the model cannot silently drop or merge a
 * channel; the parser validates cardinality and isolates bad entries.
 */
export function buildSemanticBatchPrompt(prompts: string[]): string {
  return JSON.stringify({
    task: 'BATCH_CLASSIFICATION',
    promptVersion: SEMANTIC_BATCH_PROMPT_VERSION,
    instructions: [
      'Each input is an independent channel classification request.',
      'Return JSON {"results":[ ... ]} with exactly one result object per input, in input order.',
      'Every result must follow the schema requested by that input and include its own citations.',
      'Never merge evidence, citations, or verdicts across inputs.',
      'If one input cannot be interpreted, return an AMBIGUOUS abstention for that input only.',
    ],
    inputs: prompts.map((prompt, index) => ({ index, request: parsePrompt(prompt) })),
  });
}

/**
 * A malformed whole-batch response must fail the batch, not be interpreted as
 * N missing entries (which would turn one provider call into N+1). Require at
 * least one object entry: an array of primitives is just as unusable as an
 * empty one, and per-item retry would spend quota on every member.
 */
export function isSemanticBatchContainerUsable(value: unknown): boolean {
  const container = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { results?: unknown }).results)
      ? (value as { results: unknown[] }).results
      : undefined;
  return Array.isArray(container)
    && container.some(item => item !== null && typeof item === 'object' && !Array.isArray(item));
}

/**
 * Normalize a batch response to an array aligned with the submitted prompts.
 * Entries are matched by their explicit `index` when present, else by order.
 * Missing or non-object entries stay undefined so the caller can isolate them.
 */
export function parseSemanticBatchResponse(value: unknown, expectedCount: number): Array<unknown | undefined> {
  const container = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { results?: unknown }).results)
      ? (value as { results: unknown[] }).results
      : undefined;
  const out = new Array<unknown | undefined>(expectedCount).fill(undefined);
  if (!container) return out;
  for (let position = 0; position < container.length; position++) {
    const item = container[position];
    if (!item || typeof item !== 'object') continue;
    const explicitIndex = (item as { index?: unknown }).index;
    const index = Number.isInteger(explicitIndex) ? Number(explicitIndex) : position;
    if (index < 0 || index >= expectedCount || out[index] !== undefined) continue;
    out[index] = item;
  }
  return out;
}

interface PendingRequest {
  id: number;
  client: SemanticModelClient;
  prompt: string;
  model: string;
  observability?: SemanticObservabilityContext;
  signal?: AbortSignal;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  removeAbortListener: () => void;
}

const clientGroupIds = new WeakMap<object, number>();
let nextClientGroupId = 1;

function batchGroupFor(client: SemanticModelClient): string {
  if (client.batchGroup) return `provider:${client.batchGroup}`;
  let id = clientGroupIds.get(client as object);
  if (!id) {
    id = nextClientGroupId++;
    clientGroupIds.set(client as object, id);
  }
  return `client:${id}`;
}

function abortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error('Semantic batch request aborted.');
  error.name = 'AbortError';
  return error;
}

function commonObservability(requests: PendingRequest[], batchSize: number): SemanticObservabilityContext | undefined {
  const attribution = requests.map(request => ({
    jobId: request.observability?.jobId,
    runId: request.observability?.runId,
  }));
  const first = attribution[0];
  const shared = attribution.every(item => item.jobId === first.jobId && item.runId === first.runId);
  const requestMetadata: Record<string, string> = { semanticBatchSize: String(batchSize) };
  if (!shared) {
    // A mixed-attribution batch has one ledger row but served several jobs.
    // Carry bounded member IDs so an incident can still be joined back to
    // the affected work instead of dropping attribution entirely.
    const jobIds = [...new Set(attribution.map(item => item.jobId).filter((value): value is string => Boolean(value)))];
    const runIds = [...new Set(attribution.map(item => item.runId).filter((value): value is string => Boolean(value)))];
    if (jobIds.length) requestMetadata.semanticBatchJobIds = jobIds.slice(0, 10).join(',');
    if (runIds.length) requestMetadata.semanticBatchRunIds = runIds.slice(0, 10).join(',');
    return { requestMetadata };
  }
  return {
    ...(first.jobId ? { jobId: first.jobId } : {}),
    ...(first.runId ? { runId: first.runId } : {}),
    requestMetadata,
  };
}

export interface SemanticBatchSchedulerDeps {
  config: SemanticBatchConfig;
  /** Test seam; production uses the client's own classify method. */
  setTimeoutFn?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (timer: ReturnType<typeof setTimeout>) => void;
}

export class SemanticBatchScheduler {
  private queue: PendingRequest[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private nextRequestId = 1;
  private readonly config: SemanticBatchConfig;
  private readonly setTimeoutFn: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimeoutFn: (timer: ReturnType<typeof setTimeout>) => void;

  constructor(deps: SemanticBatchSchedulerDeps) {
    this.config = deps.config;
    this.setTimeoutFn = deps.setTimeoutFn || ((callback, ms) => setTimeout(callback, ms));
    this.clearTimeoutFn = deps.clearTimeoutFn || (timer => clearTimeout(timer));
  }

  /**
   * Cancel every queued request and the pending flush timer. Used when the
   * process-wide scheduler is replaced (config change) or torn down for
   * tests: orphaned timers must never flush work into a dead scheduler.
   */
  cancel(reason?: unknown): void {
    if (this.timer) {
      this.clearTimeoutFn(this.timer);
      this.timer = undefined;
    }
    const queued = this.queue.splice(0);
    for (const request of queued) {
      request.removeAbortListener();
      request.reject(abortError(reason));
    }
  }

  submit(input: {
    client: SemanticModelClient;
    prompt: string;
    model: string;
    observability?: SemanticObservabilityContext;
    signal?: AbortSignal;
  }): Promise<unknown> {
    if (!this.config.enabled) {
      return input.client.classify(input.prompt, input.model, input.observability, input.signal);
    }
    if (input.signal?.aborted) return Promise.reject(abortError(input.signal.reason));

    return new Promise((resolve, reject) => {
      const request: PendingRequest = {
        id: this.nextRequestId++,
        client: input.client,
        prompt: input.prompt,
        model: input.model,
        observability: input.observability,
        signal: input.signal,
        resolve,
        reject,
        removeAbortListener: () => undefined,
      };
      if (input.signal) {
        const onAbort = () => {
          const index = this.queue.indexOf(request);
          if (index >= 0) this.queue.splice(index, 1);
          reject(abortError(input.signal?.reason));
          this.scheduleIfNeeded();
        };
        input.signal.addEventListener('abort', onAbort, { once: true });
        request.removeAbortListener = () => input.signal?.removeEventListener('abort', onAbort);
      }
      this.queue.push(request);
      if (this.queue.length >= this.config.maxSize) this.scheduleFlush(0);
      else this.scheduleIfNeeded();
    });
  }

  private scheduleIfNeeded(): void {
    if (this.queue.length === 0 || this.timer) return;
    this.scheduleFlush(this.config.windowMs);
  }

  private scheduleFlush(delayMs: number): void {
    if (this.timer) this.clearTimeoutFn(this.timer);
    this.timer = this.setTimeoutFn(() => {
      this.timer = undefined;
      void this.flush();
    }, delayMs);
    this.timer.unref?.();
  }

  /**
   * Split one provider group into chunks bounded by both item count and the
   * serialized batch-prompt size. A single oversized prompt is still sent
   * alone because it cannot be split without dropping evidence, so an
   * over-budget request can only reject its own channel.
   */
  private chunkGroup(group: PendingRequest[]): PendingRequest[][] {
    const chunks: PendingRequest[][] = [];
    let current: PendingRequest[] = [];
    for (const request of group) {
      const next = [...current, request];
      const overCount = next.length > this.config.maxSize;
      const overChars = next.length > 1
        && buildSemanticBatchPrompt(next.map(item => item.prompt)).length > this.config.maxPromptChars;
      if (current.length > 0 && (overCount || overChars)) {
        chunks.push(current);
        current = [request];
      } else {
        current = next;
      }
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
  }

  private flush(): void {
    const batch = this.queue.splice(0);
    if (batch.length === 0) return;
    const groups = new Map<string, PendingRequest[]>();
    for (const request of batch) {
      const key = `${batchGroupFor(request.client)}|${request.model}`;
      const group = groups.get(key);
      if (group) group.push(request);
      else groups.set(key, [request]);
    }
    for (const group of groups.values()) {
      for (const chunk of this.chunkGroup(group)) void this.executeChunk(chunk);
    }
    this.scheduleIfNeeded();
  }

  private async executeChunk(chunk: PendingRequest[]): Promise<void> {
    for (const request of chunk) request.removeAbortListener();

    if (chunk.length === 1) {
      const request = chunk[0];
      try {
        request.resolve(await request.client.classify(request.prompt, request.model, request.observability, request.signal));
      } catch (error) {
        request.reject(error);
      }
      return;
    }

    const controller = new AbortController();
    const active = new Set(chunk);
    const abortListeners = new Map<PendingRequest, () => void>();
    const settleAborted = (request: PendingRequest) => {
      if (!active.delete(request)) return;
      request.reject(abortError(request.signal?.reason));
      if (active.size === 0) controller.abort(request.signal?.reason);
    };
    for (const request of chunk) {
      if (request.signal?.aborted) {
        settleAborted(request);
        continue;
      }
      if (!request.signal) continue;
      const listener = () => settleAborted(request);
      request.signal.addEventListener('abort', listener, { once: true });
      abortListeners.set(request, listener);
    }
    const cleanup = () => {
      for (const [request, listener] of abortListeners) request.signal?.removeEventListener('abort', listener);
    };

    const pending = chunk.filter(request => active.has(request));
    if (pending.length === 0) {
      cleanup();
      return;
    }
    if (pending.length === 1) {
      cleanup();
      const request = pending[0];
      try {
        request.resolve(await request.client.classify(request.prompt, request.model, request.observability, request.signal));
      } catch (error) {
        request.reject(error);
      }
      return;
    }

    try {
      const response = await pending[0].client.classify(
        buildSemanticBatchPrompt(pending.map(request => request.prompt)),
        pending[0].model,
        commonObservability(pending, pending.length),
        controller.signal,
        { batchSize: pending.length },
      );
      if (!isSemanticBatchContainerUsable(response)) {
        // A malformed container is a whole-batch failure. Per-item fallback
        // here would turn one call into N+1 and consume quota precisely when
        // the provider is already misbehaving.
        throw new Error('Semantic batch response was not a usable result container.');
      }
      const parsed = parseSemanticBatchResponse(response, pending.length);
      await Promise.all(pending.map(async (request, index) => {
        if (!active.has(request)) return;
        const item = parsed[index];
        if (isSemanticResultShape(item)) {
          markSemanticBatchResult(item, pending.length);
          request.resolve(item);
          return;
        }
        // Per-channel isolation: a missing or malformed array element is
        // retried alone. It cannot poison the sibling results that already
        // succeeded, and a partial object never becomes a cached abstention.
        try {
          request.resolve(await request.client.classify(request.prompt, request.model, request.observability, request.signal));
        } catch (error) {
          request.reject(error);
        }
      }));
    } catch (error) {
      for (const request of pending) {
        if (active.has(request)) request.reject(error);
      }
    } finally {
      cleanup();
    }
  }
}

let defaultScheduler: SemanticBatchScheduler | undefined;
let defaultSchedulerConfigKey = '';

function schedulerForCurrentConfig(): SemanticBatchScheduler {
  const config = semanticBatchConfig();
  const key = `${config.enabled}|${config.maxSize}|${config.windowMs}|${config.maxPromptChars}`;
  if (!defaultScheduler || defaultSchedulerConfigKey !== key) {
    // Replacing the scheduler must settle work queued under the old window;
    // otherwise an orphaned timer flushes into a scheduler nobody awaits.
    defaultScheduler?.cancel(new Error('Semantic batch scheduler configuration changed.'));
    defaultScheduler = new SemanticBatchScheduler({ config });
    defaultSchedulerConfigKey = key;
  }
  return defaultScheduler;
}

/** Provider entry point. Disabled or single-request calls behave exactly as before. */
export function classifySemanticPrompt(input: {
  client: SemanticModelClient;
  prompt: string;
  model: string;
  observability?: SemanticObservabilityContext;
  signal?: AbortSignal;
}): Promise<unknown> {
  const config = semanticBatchConfig();
  if (!config.enabled) return input.client.classify(input.prompt, input.model, input.observability, input.signal);
  return schedulerForCurrentConfig().submit(input);
}

/** Test seam: cancels the process-wide scheduler and its queued work. */
export function resetSemanticBatchSchedulerForTests(): void {
  defaultScheduler?.cancel(new Error('Semantic batch scheduler reset.'));
  defaultScheduler = undefined;
  defaultSchedulerConfigKey = '';
}
