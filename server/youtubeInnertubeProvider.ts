/**
 * YouTube.js (InnerTube) discovery provider — fully ACTIVE production retrieval
 * provider alongside the official YouTube Data API v3 path.
 *
 * Isolation contract (the reason for this file's shape): this module shares NO
 * runtime state with server/youtube.ts — no key pool, no scheduler, no quota
 * ledger, no cooldown flags. It spends zero official API quota (own costDomain),
 * emits its own provider_call_events under provider='youtube-innertube' so the
 * official provider's telemetry stays pure, and never falls back to (or borrows
 * from) the official API. Failures are reported with INNERTUBE_* codes and
 * propagate to the caller; Phase 9 treats them like any other provider failure.
 */
import { Innertube } from 'youtubei.js';
import { appendProviderCallEvent } from './db';
import {
  registerRetrievalExecutor,
  type ProviderAllocation,
  type RetrievalPage,
  type RetrievalRequest,
} from './providerAwareRetrieval';
import type { DiscoveredChannelRaw } from './youtube';

export const YOUTUBE_INNERTUBE_PROVIDER_KEY = 'youtube-innertube';
export const YOUTUBE_INNERTUBE_SURFACE = 'YOUTUBE_NATIVE';
export const YOUTUBE_INNERTUBE_CAPABILITY = 'SEARCH_YOUTUBE';
export const YOUTUBE_INNERTUBE_COST_DOMAIN = 'YOUTUBE_INNERTUBE_FREE';

export const YOUTUBE_INNERTUBE_PROVIDER: ProviderAllocation = Object.freeze({
  providerKey: YOUTUBE_INNERTUBE_PROVIDER_KEY,
  retrievalSurface: YOUTUBE_INNERTUBE_SURFACE,
  capability: YOUTUBE_INNERTUBE_CAPABILITY,
  costDomain: YOUTUBE_INNERTUBE_COST_DOMAIN,
  continuationOwner: 'PHASE_9',
});

/** Innertube channel-search never needs an API key; sessions are quota-free. */
export const YOUTUBE_INNERTUBE_MAX_PAGES = 3;

export const INNERTUBE_RATE_LIMITED_CODE = 'INNERTUBE_API_RATE_LIMIT_429';
export const INNERTUBE_TIMEOUT_CODE = 'INNERTUBE_API_TIMEOUT';
export const INNERTUBE_NETWORK_FAILURE_CODE = 'INNERTUBE_API_NETWORK_FAILURE';
export const INNERTUBE_FAILURE_CODE = 'INNERTUBE_API_FAILURE';

const CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;

export function innertubeTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.YOUTUBE_INNERTUBE_TIMEOUT_MS || '30000');
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 30000;
}

export function innertubeCooldownMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.YOUTUBE_INNERTUBE_COOLDOWN_MS || '90000');
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 90000;
}

/** In-process backpressure flag. Module-private: the official provider's pool cannot see it. */
let innertubeCooldownUntilMs = 0;
export function innertubeCooldownRemainingMs(nowMs: number = Date.now()): number {
  return Math.max(0, innertubeCooldownUntilMs - nowMs);
}
/** Test-only reset for the in-process cooldown. */
export function resetInnertubeCooldownForTests(): void {
  innertubeCooldownUntilMs = 0;
}

export interface InnertubeChannelLike {
  id?: unknown;
  author?: { id?: unknown; name?: unknown };
  subscriber_count?: { text?: unknown };
  description_snippet?: { text?: unknown };
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Pure mapping from InnerTube channel-search nodes to DiscoveredChannelRaw.
 * Nodes without a resolvable UC channel id are dropped (never fabricated).
 */
export function mapInnertubeChannelsToRaw(
  nodes: InnertubeChannelLike[],
  country: string,
): DiscoveredChannelRaw[] {
  const out: DiscoveredChannelRaw[] = [];
  for (const node of nodes || []) {
    const authorId = typeof node?.author?.id === 'string' ? node.author.id : '';
    const nodeId = typeof node?.id === 'string' ? node.id : '';
    const channelId = CHANNEL_ID_PATTERN.test(authorId)
      ? authorId
      : CHANNEL_ID_PATTERN.test(nodeId)
        ? nodeId
        : '';
    if (!channelId) continue;
    const authorName = typeof node?.author?.name === 'string' && node.author.name.trim()
      ? node.author.name.trim()
      : channelId;
    out.push({
      channelId,
      channelName: authorName,
      youtubeUrl: `https://www.youtube.com/channel/${channelId}`,
      description: textOf(node?.description_snippet?.text),
      videoTitles: [],
      subscriberCount: textOf(node?.subscriber_count?.text) || undefined,
    });
  }
  return out;
}

export function parseInnertubeCursor(cursor: string | null | undefined): number {
  if (!cursor) return 1;
  const page = Math.floor(Number(cursor));
  return Number.isInteger(page) && page >= 1 ? Math.min(page, YOUTUBE_INNERTUBE_MAX_PAGES) : 1;
}

type InnertubeSession = {
  search: (query: string, filters?: Record<string, unknown>) => Promise<{
    channels?: InnertubeChannelLike[] | { length?: number };
    has_continuation?: boolean;
    getContinuation?: () => Promise<unknown>;
  }>;
};

let sessionPromise: Promise<InnertubeSession> | null = null;
let sessionFactory: (() => Promise<InnertubeSession>) | null = null;
/** Test seam: inject a stub session so no test ever touches the network. */
export function setInnertubeSessionFactoryForTests(factory: (() => Promise<InnertubeSession>) | null): void {
  sessionFactory = factory;
  sessionPromise = null;
}

async function getInnertubeSession(): Promise<InnertubeSession> {
  if (!sessionPromise) {
    sessionPromise = (sessionFactory
      ? sessionFactory()
      : Innertube.create().then((session) => session as unknown as InnertubeSession)
    ).catch((error) => {
      sessionPromise = null;
      throw error;
    });
  }
  return sessionPromise;
}

function classifyInnertubeError(error: unknown, timeoutMs: number): Error & { code?: string; retryable?: boolean } {
  const message = error instanceof Error ? error.message : String(error);
  const typed = new Error(`YouTube.js InnerTube search failed: ${message.slice(0, 300)}`) as Error & {
    code?: string;
    retryable?: boolean;
  };
  if (error instanceof Error && error.name === 'AbortError') {
    typed.code = INNERTUBE_TIMEOUT_CODE;
    typed.retryable = true;
    return typed;
  }
  if (/429|too many requests|rate.?limit/i.test(message)) {
    typed.code = INNERTUBE_RATE_LIMITED_CODE;
    typed.retryable = true;
    return typed;
  }
  if (/ENOTFOUND|ENETUNREACH|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|network/i.test(message)) {
    typed.code = INNERTUBE_NETWORK_FAILURE_CODE;
    typed.retryable = true;
    return typed;
  }
  typed.code = INNERTUBE_FAILURE_CODE;
  typed.retryable = true;
  return typed;
}

export async function executeInnertubeRetrievalPage(request: RetrievalRequest): Promise<RetrievalPage> {
  const timeoutMs = innertubeTimeoutMs();
  const remainingMs = innertubeCooldownRemainingMs();
  if (remainingMs > 0) {
    throw Object.assign(
      new Error(`YouTube.js provider cooling down for ${remainingMs}ms.`),
      { code: INNERTUBE_RATE_LIMITED_CODE, retryable: true, retryAfterMs: remainingMs },
    );
  }
  const pageNumber = parseInnertubeCursor(request.cursor);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  const base = {
    id: `${request.queryRunId || 'adhoc'}:youtube-innertube:p${pageNumber}:${Date.now()}`,
    provider: 'youtube-innertube',
    operation: 'search',
    runId: request.queryRunId,
    jobId: request.jobId,
    requestMetadata: { innertubePage: String(pageNumber) },
    attempt: 1,
    reservedCost: 0,
    policyVersion: 'provider-resilience-v1',
  };
  try {
    if (controller.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const session = await getInnertubeSession();
    // Page walk: InnerTube continuations belong to a live feed object, so page
    // N is reached by re-running the search and advancing N-1 continuations.
    // Bounded to YOUTUBE_INNERTUBE_MAX_PAGES (mirrors the autonomous 3-page cap).
    let feed = await session.search(request.query, { type: 'channel' });
    for (let walked = 1; walked < pageNumber; walked++) {
      if (!feed?.has_continuation || typeof feed.getContinuation !== 'function') break;
      const next = (await feed.getContinuation()) as typeof feed;
      if (!next) break;
      feed = next;
    }
    const rawNodes = (feed?.channels ?? []) as unknown;
    const nodes: InnertubeChannelLike[] = Array.isArray(rawNodes) ? rawNodes as InnertubeChannelLike[] : [];
    const channels = mapInnertubeChannelsToRaw(nodes, request.country);
    const hasMore = feed?.has_continuation === true && pageNumber < YOUTUBE_INNERTUBE_MAX_PAGES;
    await appendProviderCallEvent({
      ...base, status: 'SUCCESS', latencyMs: Date.now() - started,
      actualCost: 0, occurredAt: new Date().toISOString(),
    }).catch(() => undefined);
    return {
      channels,
      rawResultCount: channels.length,
      nextPageToken: hasMore ? String(pageNumber + 1) : null,
      providerCostUsd: 0,
      providerRequestId: request.queryRunId ? `${request.queryRunId}:youtube-innertube:p${pageNumber}` : undefined,
    };
  } catch (error) {
    const typed = classifyInnertubeError(error, timeoutMs);
    if (typed.code === INNERTUBE_RATE_LIMITED_CODE && !String(typed.message).includes('cooling down')) {
      innertubeCooldownUntilMs = Date.now() + innertubeCooldownMs();
    }
    await appendProviderCallEvent({
      ...base,
      status: typed.code === INNERTUBE_RATE_LIMITED_CODE ? 'RATE_LIMITED' : 'TRANSIENT_ERROR',
      latencyMs: Date.now() - started,
      actualCost: 0,
      errorClass: typed.code === INNERTUBE_RATE_LIMITED_CODE ? 'RATE_LIMIT' : 'TRANSIENT',
      occurredAt: new Date().toISOString(),
    }).catch(() => undefined);
    throw typed;
  } finally {
    clearTimeout(timer);
  }
}

registerRetrievalExecutor(YOUTUBE_INNERTUBE_PROVIDER, executeInnertubeRetrievalPage);
