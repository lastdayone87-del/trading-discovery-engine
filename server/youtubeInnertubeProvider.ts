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

/**
 * Timeout contract: YOUTUBE_INNERTUBE_TIMEOUT_MS is the maximum wall-clock
 * duration of an ENTIRE retrieval page — session creation, pacing waits, the
 * initial search, and every continuation walk step share ONE absolute
 * deadline established when executeInnertubeRetrievalPage starts. It is NOT
 * a per-request budget: a page can never consume N x timeout no matter how
 * many provider operations it performs. This bounds worker hold time on the
 * unofficial endpoint, where stalls (hung session/search/continuation) would
 * otherwise stack per-operation timeouts severalfold.
 */
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
/** Test-only count of pacing-gate acquisitions since the last reset. */
let innertubePacingGatePasses = 0;
/**
 * Pacing generation: bumped by the test reset so a stale pace run abandoned
 * via page-deadline (its wait still sleeping in the background) can never
 * write a stale nextAllowed over newer state when it finally wakes.
 * Production never resets, so the guard is a no-op outside tests.
 */
let innertubePacingGeneration = 0;
export function resetInnertubePacingForTests(): void {
  innertubeNextAllowedAtMs = 0;
  innertubePacingChain = Promise.resolve();
  innertubePacingGatePasses = 0;
  innertubePacingGeneration += 1;
}
/** Test-only read of pacing-gate acquisitions (one per actual outbound request). */
export function innertubePacingGatePassesForTests(): number {
  return innertubePacingGatePasses;
}
function paceInnertubeRequest(minIntervalMs: number): Promise<void> {
  // One gate acquisition per call; every caller below is an actual outbound
  // provider request (initial search or continuation), so the count proves
  // each request is paced exactly once — no duplicate waits per page.
  innertubePacingGatePasses += 1;
  const generation = innertubePacingGeneration;
  const run = innertubePacingChain.then(async () => {
    const waitMs = Math.max(0, innertubeNextAllowedAtMs - Date.now());
    if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    if (generation === innertubePacingGeneration) {
      innertubeNextAllowedAtMs = Date.now() + minIntervalMs;
    }
  });
  // Chain stays alive across rejections; callers observe only their own run.
  innertubePacingChain = run.catch(() => undefined);
  return run;
}

/**
 * Every provider request — initial search and each continuation — passes
 * through pacing first, so bursts (including multi-page walks) never hit the
 * unofficial endpoint unthrottled. Pacing waits run INSIDE the page deadline
 * (they consume the same budget via withInnertubeRemaining), so the timeout
 * contract bounds total wall-clock time including queueing, not just I/O.
 */
async function pacedSearch(
  session: InnertubeSession,
  query: string,
  searchType: string,
  deadlineAtMs: number,
): Promise<InnertubeFeedLike> {
  await withInnertubeRemaining(paceInnertubeRequest(innertubeMinIntervalMs()), deadlineAtMs);
  return withInnertubeRemaining(session.search(query, { type: searchType }), deadlineAtMs);
}

async function pacedContinuation(
  feed: InnertubeFeedLike,
  deadlineAtMs: number,
): Promise<unknown> {
  await withInnertubeRemaining(paceInnertubeRequest(innertubeMinIntervalMs()), deadlineAtMs);
  return withInnertubeRemaining(feed.getContinuation!(), deadlineAtMs);
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
 * (providerCooldownObservationWindowSecs window — 300s floor or the
 * configured YOUTUBE_INNERTUBE_COOLDOWN_MS when longer — fail-open to the full
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
 * discard legitimate video evidence. videoTitles and videoDescriptions are
 * kept index-parallel (a missing description contributes ''), because
 * downstream ingestion pairs them by index; omitting empties would shift a
 * later video's description onto an earlier title. matchedDocument.publishedAt
 * is intentionally unset: InnerTube exposes only relative display text
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
      // Always push (even ''): titles and descriptions stay index-parallel so
      // a missing description can never shift a later video's description
      // onto this title downstream.
      (existing.videoDescriptions ??= []).push(videoDescription);
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
      // Index-parallel with videoTitles from the start: a missing first
      // description is '' rather than omitted (see the merge branch above).
      videoDescriptions: [videoDescription],
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
/** Attempts that already settled (success or failure) — never invalidated. */
const settledSessionAttempts = new WeakSet<Promise<InnertubeSession>>();
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

/**
 * Returns the shared session promise itself (NOT an async wrapper), so
 * callers can compare its identity — the stuck-attempt invalidation in
 * executeInnertubeRetrievalPage relies on object identity with the cached
 * attempt. An `async` wrapper would hand out a fresh promise per call and
 * silently defeat that check.
 */
function getInnertubeSession(): Promise<InnertubeSession> {
  if (!sessionPromise) {
    const attempt: Promise<InnertubeSession> = (sessionFactory
      ? sessionFactory()
      : Innertube.create().then((session) => session as unknown as InnertubeSession)
    ).then(
      (session) => {
        settledSessionAttempts.add(attempt);
        return session;
      },
      (error) => {
        settledSessionAttempts.add(attempt);
        if (sessionPromise === attempt) sessionPromise = null;
        throw error;
      },
    );
    sessionPromise = attempt;
  }
  return sessionPromise;
}

/**
 * Drops a stuck session attempt after a page-deadline timeout so later pages
 * can create a fresh session instead of reusing a permanently pending
 * promise (which would disable InnerTube until process restart). Narrow by
 * construction: only the still-current attempt is cleared (an older timed-out
 * request can never clear a newer attempt), and settled attempts — including
 * a successfully initialized shared session — are always preserved.
 */
function invalidateStuckSessionAttempt(attempt: Promise<InnertubeSession>): void {
  if (sessionPromise === attempt && !settledSessionAttempts.has(attempt)) {
    sessionPromise = null;
  }
}

export function innertubeTimeoutError(): Error & { code?: string; retryable?: boolean } {
  return Object.assign(
    new Error('YouTube.js InnerTube search exceeded its wall-clock deadline.'),
    { code: INNERTUBE_TIMEOUT_CODE, retryable: true },
  );
}

/**
 * Races provider work against a timeout budget. Whichever settles
 * first wins; a late loser is ignored, so a timed-out operation can never
 * emit success telemetry after the fact. Both sides carry handlers, so late
 * rejections are never unhandled.
 *
 * Cancellation limitation (verified against the installed youtubei.js
 * 18.0.0 API surface): `Innertube.create`, `search`, and `getContinuation`
 * accept no AbortSignal and expose no cancel operation, so a timed-out
 * operation is NOT cancelled — it may still complete in the background.
 * That is safe by construction here: its result is discarded (never
 * emitted, never returned), its rejection is already handled (never
 * unhandled), a late session success is not cached (the timed-out attempt
 * was already invalidated), and the page still rejects with
 * INNERTUBE_API_TIMEOUT inside the absolute page budget. No fake
 * cancellation is introduced: there is nothing to signal.
 *
 * This is the per-operation primitive. Page execution never calls it with the
 * full configured timeout directly — it goes through withInnertubeRemaining
 * so every operation shares the page's single absolute deadline.
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

/**
 * Page-deadline enforcement: races work against the time REMAINING until the
 * page's absolute deadline (established once in executeInnertubeRetrievalPage
 * from the configured timeout). Each successive provider operation therefore
 * gets a shrinking budget, and the page as a whole can never exceed the
 * configured timeout no matter how many operations it performs. An already-
 * exhausted deadline rejects immediately with the standard timeout error
 * (classified INNERTUBE_API_TIMEOUT downstream, like any other expiry).
 */
export function withInnertubeRemaining<T>(work: Promise<T>, deadlineAtMs: number): Promise<T> {
  const remainingMs = deadlineAtMs - Date.now();
  if (!(remainingMs > 0)) return Promise.reject(innertubeTimeoutError());
  return withInnertubeDeadline(work, remainingMs);
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
  // Single absolute page deadline: session creation, pacing, the initial
  // search, and every continuation share this one budget (see the timeout
  // contract on innertubeTimeoutMs). Operations arriving after it expired get
  // zero budget and fail immediately with INNERTUBE_API_TIMEOUT.
  const timeoutMs = innertubeTimeoutMs();
  const deadlineAtMs = Date.now() + timeoutMs;
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
    // Exactly one pacing slot per actual outbound request: the initial search
    // is paced inside pacedSearch and each continuation inside
    // pacedContinuation. No pacing here — a second admission would halve
    // throughput and could expire queued pages before they search. Session
    // creation still consumes the page deadline below.
    const sessionAttempt = getInnertubeSession();
    let session: InnertubeSession;
    try {
      session = await withInnertubeRemaining(sessionAttempt, deadlineAtMs);
    } catch (error) {
      // A deadline expiry during session creation must not wedge the shared
      // session forever: drop the attempt so the next page creates a fresh
      // session. Narrow: only the still-current pending attempt is cleared
      // (never a newer attempt, never a settled session).
      invalidateStuckSessionAttempt(sessionAttempt);
      throw error;
    }
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
    let feed = await pacedSearch(session, request.query, searchType, deadlineAtMs);
    for (let walked = 1; walked < pageNumber; walked++) {
      if (!feed?.has_continuation || typeof feed.getContinuation !== 'function') {
        throw Object.assign(
          new Error(`YouTube.js InnerTube continuation unavailable for page ${pageNumber} (walk stopped at ${walked}).`),
          { code: INNERTUBE_CONTINUATION_UNAVAILABLE_CODE, retryable: true },
        );
      }
      // Rejections propagate with their original classification (429s arm the
      // cooldown, network errors stay network errors); only a genuinely empty
      // (null/undefined) continuation becomes CONTINUATION_UNAVAILABLE. The
      // walk shares the page deadline, so a stalled continuation cannot stack
      // another full timeout on top of the search that preceded it.
      const next = (await withInnertubeRemaining(
        pacedContinuation(feed, deadlineAtMs),
        deadlineAtMs,
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
