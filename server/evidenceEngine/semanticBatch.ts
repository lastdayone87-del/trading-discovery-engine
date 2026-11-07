import type { SemanticModelClient, SemanticObservabilityContext } from './providers/GeminiSemanticProvider';

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

export interface SemanticBatchConfig {
  enabled: boolean;
  maxSize: number;
  windowMs: number;
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function semanticBatchConfig(env: NodeJS.ProcessEnv = process.env): SemanticBatchConfig {
  return {
    enabled: env.SEMANTIC_BATCH_CLASSIFICATION_ENABLED === 'true',
    maxSize: clamp(Number(env.SEMANTIC_BATCH_MAX_SIZE || '8'), 2, 10, 8),
    windowMs: clamp(Number(env.SEMANTIC_BATCH_WINDOW_MS || '1200'), 0, 10_000, 1200),
  };
}

function parsePrompt(prompt: string): unknown {
  try {
    return JSON.parse(prompt);
  } catch {
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
  if (!shared) return { requestMetadata };
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

  private flush(): void {
    const batch = this.queue.splice(0, Math.max(this.config.maxSize, this.queue.length));
    if (batch.length === 0) return;
    const groups = new Map<string, PendingRequest[]>();
    for (const request of batch) {
      const key = `${batchGroupFor(request.client)}|${request.model}`;
      const group = groups.get(key);
      if (group) group.push(request);
      else groups.set(key, [request]);
    }
    for (const group of groups.values()) {
      for (let offset = 0; offset < group.length; offset += this.config.maxSize) {
        const chunk = group.slice(offset, offset + this.config.maxSize);
        void this.executeChunk(chunk);
      }
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
      );
      const parsed = parseSemanticBatchResponse(response, pending.length);
      await Promise.all(pending.map(async (request, index) => {
        if (!active.has(request)) return;
        const item = parsed[index];
        if (item && typeof item === 'object') {
          request.resolve(item);
          return;
        }
        // Per-channel isolation: a missing/invalid array element is retried
        // alone. It cannot poison the sibling results that already succeeded.
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
  const key = `${config.enabled}|${config.maxSize}|${config.windowMs}`;
  if (!defaultScheduler || defaultSchedulerConfigKey !== key) {
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

/** Test seam: drops the process-wide scheduler and its queued work. */
export function resetSemanticBatchSchedulerForTests(): void {
  defaultScheduler = undefined;
  defaultSchedulerConfigKey = '';
}
