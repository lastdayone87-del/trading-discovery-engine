/**
 * YouTube.js (InnerTube) discovery provider — fully ACTIVE production retrieval
 * provider alongside the official YouTube Data API v3 path.
 *
 * Capability contract (mirrors server/youtube.ts discovery behavior):
 * - CHANNEL lane: genuine InnerTube channel search; bio description,
 *   matchedDocument{type:'CHANNEL', locator:'youtube:channel:<id>'}.
 * - VIDEO lane: genuine InnerTube video search; per-video titles/descriptions,
 *   channels attributed via the video author id, description left empty (the
 *   About bio is unknown until official enrichment hydrates it — same rule as
 *   the official provider), matchedDocument{type:'VIDEO', locator:'youtube:video:<id>'}.
 * - Ordering: InnerTube exposes no sort-by-date; every search runs in native
 *   relevance order and the actual ordering is recorded truthfully in provider
 *   event metadata (never misreported as DATE). InnerTube video timestamps are
 *   relative display text, so matchedDocument.publishedAt is left unset; the
 *   downstream staleness triage treats a missing timestamp as non-stale
 *   (fail-open toward inspection, never a wrongful withhold).
 *
 * Isolation contract: this module shares NO runtime state with
 * server/youtube.ts — no key pool, no scheduler, no quota ledger, no cooldown
 * flags. It spends zero official API quota (own costDomain), emits its own
 * provider_call_events under provider='youtube-innertube' so the official
 * provider's telemetry stays pure, and never falls back to (or borrows from)
 * the official API. Failures are reported with INNERTUBE_* codes and
 * propagate to the caller; Phase 9 treats them like any other provider
 * failure. A missing required continuation fails the page — the previous
 * page is never returned as fresh successful data.
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

/** InnerTube channel/video search never needs an API key; sessions are quota-free. */
export const YOUTUBE_INNERTUBE_MAX_PAGES = 3;
/** First-page result count is provider-determined (~20); official pages request up to 25. */
export const YOUTUBE_INNERTUBE_PAGE_SIZE = 20;

export const INNERTUBE_RATE_LIMITED_CODE = 'INNERTUBE_API_RATE_LIMIT_429';
export const INNERTUBE_TIMEOUT_CODE = 'INNERTUBE_API_TIMEOUT';
export const INNERTUBE_NETWORK_FAILURE_CODE = 'INNERTUBE_API_NETWORK_FAILURE';
export const INNERTUBE_FAILURE_CODE = 'INNERTUBE_API_FAILURE';
export const INNERTUBE_CONTINUATION_UNAVAILABLE_CODE = 'INNERTUBE_API_CONTINUATION_UNAVAILABLE';

const CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;

export function innertubeTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.YOUTUBE_INNERTUBE_TIMEOUT_MS || '30000');
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 30000;
}

export function innertubeCooldownMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.YOUTUBE_INNERTUBE_COOLDOWN_MS || '90000');
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 90000;
}

/**
 * Minimum spacing between InnerTube search requests (process-wide). The
 * official path paces via its priority scheduler to protect precious quota;
 * InnerTube quota is free, but unpaced concurrent bursts invite IP-level
 * throttling on an unofficial endpoint, so a light default interval applies.
 * Tune or disable (0) via YOUTUBE_INNERTUBE_MIN_INTERVAL_MS.
 */
export function innertubeMinIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.YOUTUBE_INNERTUBE_MIN_INTERVAL_MS || '500');
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 500;
}

let innertubeNextAllowedAtMs = 0;
let innertubePacingChain: Promise<void> = Promise.resolve();
export function resetInnertubePacingForTests(): void {
  innertubeNextAllowedAtMs = 0;
  innertubePacingChain = Promise.resolve();
}
function paceInnertubeRequest(minIntervalMs: number): Promise<void> {
  const run = innertubePacingChain.then(async () => {
    const waitMs = Math.max(0, innertubeNextAllowedAtMs - Date.now());
    if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    innertubeNextAllowedAtMs = Date.now() + minIntervalMs;
  });
  // Chain stays alive across rejections; callers observe only their own run.
  innertubePacingChain = run.catch(() => undefined);
  return run;
}

/**
 * Every provider request — initial search and each continuation — passes
 * through pacing first, so bursts (including multi-page walks) never hit the
 * unofficial endpoint unthrottled.
 */
async function pacedSearch(
  session: InnertubeSession,
  query: string,
  searchType: string,
  timeoutMs: number,
): Promise<InnertubeFeedLike> {
  await paceInnertubeRequest(innertubeMinIntervalMs());
  return withInnertubeDeadline(session.search(query, { type: searchType }), timeoutMs);
}

async function pacedContinuation(
  feed: InnertubeFeedLike,
  timeoutMs: number,
): Promise<unknown> {
  await paceInnertubeRequest(innertubeMinIntervalMs());
  return withInnertubeDeadline(feed.getContinuation!(), timeoutMs);
}

/**
 * In-process (replica-local) backpressure flag. Module-private: the official
 * provider's pool cannot see it.
 *
 * Replica-locality is intentional and matches the official YouTube provider's
 * model (server/youtubeProviderCooldown.ts keeps per-key rate-limit, daily,
 * and suspension state in memory Maps): a 429 arms a short local quarantine
 * so the hot replica stops hammering the endpoint immediately, without a
 * cross-replica round-trip on the failure path.
 *
 * Cross-replica safety and observability come from the persisted ledger, not
 * this flag: every InnerTube attempt (SUCCESS, TRANSIENT_ERROR, RATE_LIMITED)
 * is appended to provider_call_events under provider='youtube-innertube' with
 * zero official cost, and both allocation sites (frontier allocator rotation
 * and ordinary scheduling rotation) exclude providers with a recent
 * RATE_LIMITED ledger row while a healthy alternative remains
 * (PROVIDER_COOLDOWN_OBSERVATION_WINDOW_SECS window, fail-open to the full
 * pool). Persisted events therefore remain the sufficient, queryable record
 * for dashboards, rotation, and post-incident review; this flag is only the
 * fast local backpressure layer on top.
 */
let innertubeCooldownUntilMs = 0;
export function innertubeCooldownRemainingMs(nowMs: number = Date.now()): number {
  return Math.max(0, innertubeCooldownUntilMs - nowMs);
}
/** Test-only reset for the in-process cooldown. */
export function resetInnertubeCooldownForTests(): void {
  innertubeCooldownUntilMs = 0;
}

export interface InnertubeTextLike { text?: unknown }
export interface InnertubeThumbnailLike { url?: unknown; width?: unknown }
export interface InnertubeAuthorLike {
  id?: unknown;
  name?: unknown;
  thumbnails?: InnertubeThumbnailLike[];
  avatar_thumbnail_url?: unknown;
}
export interface InnertubeChannelLike {
  id?: unknown;
  author?: InnertubeAuthorLike;
  subscriber_count?: InnertubeTextLike;
  subscribers?: InnertubeTextLike;
  description_snippet?: InnertubeTextLike;
}
export interface InnertubeVideoLike {
  video_id?: unknown;
  title?: InnertubeTextLike;
  author?: InnertubeAuthorLike;
  description_snippet?: InnertubeTextLike;
  thumbnails?: InnertubeThumbnailLike[];
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as { text?: unknown }).text === 'string') {
    return (value as { text: string }).text;
  }
  return '';
}

function bestThumbnailUrl(thumbnails: InnertubeThumbnailLike[] | undefined): string {
  if (!Array.isArray(thumbnails)) return '';
  let best = '';
  let bestWidth = -1;
  for (const thumb of thumbnails) {
    if (typeof thumb?.url !== 'string' || !thumb.url) continue;
    const width = Number(thumb.width);
    if (Number.isFinite(width) ? width > bestWidth : !best) {
      best = thumb.url;
      bestWidth = Number.isFinite(width) ? width : 0;
    }
  }
  return best;
}

function channelIdOf(authorId: string, nodeId: string): string {
  if (CHANNEL_ID_PATTERN.test(authorId)) return authorId;
  if (CHANNEL_ID_PATTERN.test(nodeId)) return nodeId;
  return '';
}

/**
 * Pure CHANNEL-lane mapping from InnerTube channel-search nodes.
 * Nodes without a resolvable UC channel id are dropped (never fabricated).
 */
export function mapInnertubeChannelsToRaw(
  nodes: InnertubeChannelLike[],
  _country: string,
): DiscoveredChannelRaw[] {
  const out: DiscoveredChannelRaw[] = [];
  for (const node of nodes || []) {
    const authorId = typeof node?.author?.id === 'string' ? node.author.id : '';
    const nodeId = typeof node?.id === 'string' ? node.id : '';
    const channelId = channelIdOf(authorId, nodeId);
    if (!channelId) continue;
    const authorName = typeof node?.author?.name === 'string' && node.author.name.trim()
      ? node.author.name.trim()
      : channelId;
    const description = textOf(node?.description_snippet);
    const avatar = typeof node?.author?.avatar_thumbnail_url === 'string'
      ? node.author.avatar_thumbnail_url
      : bestThumbnailUrl(node?.author?.thumbnails);
    out.push({
      channelId,
      channelName: authorName,
      youtubeUrl: `https://www.youtube.com/channel/${channelId}`,
      description,
      videoTitles: [],
      videoDescriptions: [],
      subscriberCount: textOf(node?.subscriber_count) || textOf(node?.subscribers) || undefined,
      channelThumbnailUrl: avatar || undefined,
      matchedDocument: {
        type: 'CHANNEL',
        providerNativeId: channelId,
        title: authorName,
        description,
        locator: `youtube:channel:${channelId}`,
      },
    });
  }
  return out;
}

/**
 * Pure VIDEO-lane mapping from InnerTube video-search nodes. Videos sharing
 * an author channel are merged into one entry (titles/descriptions
 * accumulated, first video's matchedDocument kept) — mirroring the official
 * provider's per-channel merge — so downstream channel dedupe cannot silently
 * discard legitimate video evidence. matchedDocument.publishedAt is
 * intentionally unset: InnerTube exposes only relative display text
 * ("3 days ago"), never a timestamp, and a fabricated timestamp would corrupt
 * the downstream staleness triage (which fail-opens on a missing value).
 */
export function mapInnertubeVideosToRaw(nodes: InnertubeVideoLike[]): DiscoveredChannelRaw[] {
  const byChannel = new Map<string, DiscoveredChannelRaw>();
  for (const node of nodes || []) {
    const authorId = typeof node?.author?.id === 'string' ? node.author.id : '';
    const channelId = channelIdOf(authorId, '');
    if (!channelId) continue;
    const videoId = typeof node?.video_id === 'string' ? node.video_id : '';
    const title = textOf(node?.title);
    if (!videoId || !title) continue;
    const videoDescription = textOf(node?.description_snippet);
    const existing = byChannel.get(channelId);
    if (existing) {
      existing.videoTitles.push(title);
      if (videoDescription) (existing.videoDescriptions ??= []).push(videoDescription);
      continue;
    }
    const authorName = typeof node?.author?.name === 'string' && node.author.name.trim()
      ? node.author.name.trim()
      : channelId;
    byChannel.set(channelId, {
      channelId,
      channelName: authorName,
      youtubeUrl: `https://www.youtube.com/channel/${channelId}`,
      // VIDEO search snippets describe the video; the channel About bio is
      // unknown until official enrichment hydrates it (official rule).
      description: '',
      videoTitles: [title],
      videoDescriptions: videoDescription ? [videoDescription] : [],
      channelThumbnailUrl: bestThumbnailUrl(node?.thumbnails) || undefined,
      matchedDocument: {
        type: 'VIDEO',
        providerNativeId: videoId,
        title,
        description: videoDescription,
        locator: `youtube:video:${videoId}`,
      },
    });
  }
  return [...byChannel.values()];
}

export function parseInnertubeCursor(cursor: string | null | undefined): number {
  if (!cursor) return 1;
  const page = Math.floor(Number(cursor));
  return Number.isInteger(page) && page >= 1 ? Math.min(page, YOUTUBE_INNERTUBE_MAX_PAGES) : 1;
}

type InnertubeFeedLike = {
  channels?: unknown;
  videos?: unknown;
  has_continuation?: boolean;
  getContinuation?: () => Promise<unknown>;
};

type InnertubeSession = {
  search: (query: string, filters?: Record<string, unknown>) => Promise<InnertubeFeedLike>;
};

let sessionPromise: Promise<InnertubeSession> | null = null;
let sessionFactory: (() => Promise<InnertubeSession>) | null = null;
/** Test seam: inject a stub session so no test ever touches the network. */
export function setInnertubeSessionFactoryForTests(factory: (() => Promise<InnertubeSession>) | null): void {
  sessionFactory = factory;
  sessionPromise = null;
}

type EmitSink = (event: Parameters<typeof appendProviderCallEvent>[0]) => Promise<void>;
let emitSink: EmitSink | null = null;
/** Test seam: observe emitted provider_call_events without a database. */
export function setInnertubeEmitSinkForTests(sink: EmitSink | null): void {
  emitSink = sink;
}
function emit(event: Parameters<typeof appendProviderCallEvent>[0]): Promise<void> {
  return (emitSink ? emitSink(event) : appendProviderCallEvent(event)).catch(() => undefined);
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

export function innertubeTimeoutError(): Error & { code?: string; retryable?: boolean } {
  return Object.assign(
    new Error('YouTube.js InnerTube search exceeded its wall-clock deadline.'),
    { code: INNERTUBE_TIMEOUT_CODE, retryable: true },
  );
}

/**
 * Races provider work against the wall-clock deadline. Whichever settles
 * first wins; a late loser is ignored, so a timed-out operation can never
 * emit success telemetry after the fact. Both sides carry handlers, so late
 * rejections are never unhandled.
 */
export function withInnertubeDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(innertubeTimeoutError()), timeoutMs);
  });
  const guarded = work.then(
    (value) => { if (timer) clearTimeout(timer); return value; },
    (error) => { if (timer) clearTimeout(timer); throw error; },
  );
  return Promise.race([guarded, timeout]);
}

function classifyInnertubeError(error: unknown): Error & { code?: string; retryable?: boolean } {
  const existingCode = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  if (typeof existingCode === 'string' && existingCode.startsWith('INNERTUBE_API_')) {
    // Provider-raised errors (timeout, missing continuation, cooldown) keep
    // their specific codes so callers and retry policy can distinguish them.
    return error as Error & { code?: string; retryable?: boolean };
  }
  const message = error instanceof Error ? error.message : String(error);
  const typed = new Error(`YouTube.js InnerTube search failed: ${message.slice(0, 300)}`) as Error & {
    code?: string;
    retryable?: boolean;
  };
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
  const lane = request.lane === 'VIDEO' ? 'VIDEO' : 'CHANNEL';
  const requestedOrdering = request.ordering === 'DATE' ? 'DATE' : 'RELEVANCE';
  // InnerTube search has no sort-by-date: relevance is the only available
  // order. Recorded truthfully; never misreported as DATE downstream.
  const actualOrdering = 'RELEVANCE';
  const pageNumber = parseInnertubeCursor(request.cursor);
  const started = Date.now();
  const base = {
    id: `${request.queryRunId || 'adhoc'}:youtube-innertube:${lane.toLowerCase()}:p${pageNumber}:${Date.now()}`,
    provider: 'youtube-innertube',
    operation: 'search',
    runId: request.queryRunId,
    jobId: request.jobId,
    requestMetadata: {
      innertubePage: String(pageNumber),
      innertubeLane: lane,
      requestedOrdering,
      innertubeOrdering: actualOrdering,
      ...(requestedOrdering === 'DATE' ? { orderingFallback: 'RELEVANCE_FALLBACK' } : {}),
    },
    attempt: 1,
    reservedCost: 0,
    policyVersion: 'provider-resilience-v1',
  };
  try {
    await paceInnertubeRequest(innertubeMinIntervalMs());
    const session = await withInnertubeDeadline(getInnertubeSession(), timeoutMs);
    // Page walk: InnerTube continuations belong to a live feed object, so page
    // N is reached by re-running the search and advancing N-1 continuations.
    // Bounded to YOUTUBE_INNERTUBE_MAX_PAGES (mirrors the autonomous 3-page cap).
    // NOTE on durability: youtubei.js exposes no serializable continuation
    // token, so cross-job pages re-run the search and walk live continuations
    // rather than resuming an opaque cursor. Result churn between jobs can
    // duplicate (absorbed downstream: per-page channelId dedupe, duplicate-
    // ratio stop, idempotent page records) or skip (bounded to pages 2-3)
    // results; within one call the walk uses live continuations with no drift.
    // A cursor is therefore a page number, not an equivalent server cursor.
    const searchType = lane === 'VIDEO' ? 'video' : 'channel';
    let feed = await pacedSearch(session, request.query, searchType, timeoutMs);
    for (let walked = 1; walked < pageNumber; walked++) {
      if (!feed?.has_continuation || typeof feed.getContinuation !== 'function') {
        throw Object.assign(
          new Error(`YouTube.js InnerTube continuation unavailable for page ${pageNumber} (walk stopped at ${walked}).`),
          { code: INNERTUBE_CONTINUATION_UNAVAILABLE_CODE, retryable: true },
        );
      }
      // Rejections propagate with their original classification (429s arm the
      // cooldown, network errors stay network errors); only a genuinely empty
      // (null/undefined) continuation becomes CONTINUATION_UNAVAILABLE.
      const next = (await withInnertubeDeadline(
        pacedContinuation(feed, timeoutMs),
        timeoutMs,
      )) as InnertubeFeedLike | null;
      if (!next) {
        throw Object.assign(
          new Error(`YouTube.js InnerTube continuation returned no feed for page ${pageNumber}.`),
          { code: INNERTUBE_CONTINUATION_UNAVAILABLE_CODE, retryable: true },
        );
      }
      feed = next;
    }
    const rawNodes = (lane === 'VIDEO' ? feed?.videos : feed?.channels) ?? [];
    const nodes: Array<InnertubeChannelLike & InnertubeVideoLike> = Array.isArray(rawNodes) ? rawNodes : [];
    // rawResultCount counts raw InnerTube results BEFORE mapping drops
    // invalid/unresolvable nodes — same metric semantics as the official
    // provider (items.length), which downstream yield math relies on.
    const rawResultCount = nodes.length;
    const channels = lane === 'VIDEO'
      ? mapInnertubeVideosToRaw(nodes)
      : mapInnertubeChannelsToRaw(nodes, request.country);
    const hasMore = feed?.has_continuation === true && pageNumber < YOUTUBE_INNERTUBE_MAX_PAGES;
    await emit({
      ...base, status: 'SUCCESS', latencyMs: Date.now() - started,
      actualCost: 0, occurredAt: new Date().toISOString(),
    }).catch(() => undefined);
    return {
      channels,
      rawResultCount,
      nextPageToken: hasMore ? String(pageNumber + 1) : null,
      providerCostUsd: 0,
      providerRequestId: request.queryRunId ? `${request.queryRunId}:youtube-innertube:${lane.toLowerCase()}:p${pageNumber}` : undefined,
    };
  } catch (error) {
    const typed = classifyInnertubeError(error);
    if (typed.code === INNERTUBE_RATE_LIMITED_CODE && !String(typed.message).includes('cooling down')) {
      innertubeCooldownUntilMs = Date.now() + innertubeCooldownMs();
    }
    await emit({
      ...base,
      status: typed.code === INNERTUBE_RATE_LIMITED_CODE ? 'RATE_LIMITED' : 'TRANSIENT_ERROR',
      latencyMs: Date.now() - started,
      actualCost: 0,
      errorClass: typed.code === INNERTUBE_RATE_LIMITED_CODE ? 'RATE_LIMIT' : 'TRANSIENT',
      occurredAt: new Date().toISOString(),
    }).catch(() => undefined);
    throw typed;
  }
}

registerRetrievalExecutor(YOUTUBE_INNERTUBE_PROVIDER, executeInnertubeRetrievalPage);
