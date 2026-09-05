import { candidateFromNativeInvite, extractDiscordCandidates, mergeDiscordCandidates, type DiscordCandidate } from './discordCandidates';
import { browserLaunchOptions, classifyBrowserFailure, isBrowserRuntimeFailure, markBrowserCapabilityReady, markBrowserCapabilityUnavailable, withBrowserRuntimeLease, type BrowserFailureClass } from './browserCapability';
import {
  DEFAULT_RENDERED_MAX_REQUEST_RETRIES,
  DEFAULT_RENDERED_MAX_SESSION_ROTATIONS,
  classifyRenderedCrawlerFailure,
  renderedCrawlerHostBackoffMs,
  renderedCrawlerRetryPolicy,
  isRenderedNavigationTimeout,
  type RenderedCrawlerFailureClass,
} from './renderedCrawlerPolicy';

export interface BrowserFallbackBudget {
  maxPages: number;
  maxScrollsPerPage: number;
  maxClicksPerPage: number;
  maxRequestRetries: number;
  maxSessionRotations: number;
  navigationTimeoutMs: number;
  totalTimeoutMs: number;
}

export interface BrowserFallbackTelemetry {
  requestsStarted: number;
  requestsFinished: number;
  requestsFailed: number;
  navigationTimeouts: number;
  blockedRequests: number;
  rateLimitedRequests: number;
  transientRequests: number;
  /**
   * Failed request targets with no later success (terminal unresolved
   * failures). A failed attempt that later succeeds on retry is recovered,
   * not terminal: only unresolved failures can invalidate coverage. Tracked
   * per request URL by the crawler (failed URLs minus succeeded URLs).
   */
  unresolvedFailedRequests: number;
  hostBackoffsApplied: number;
  clicksStarted: number;
  clicksSucceeded: number;
  clicksFailed: number;
  clickFailureClasses: Record<RenderedCrawlerFailureClass, number>;
}

export function browserFallbackTelemetrySummary(telemetry: BrowserFallbackTelemetry): string {
  return `telemetry{started:${telemetry.requestsStarted},finished:${telemetry.requestsFinished},failed:${telemetry.requestsFailed},navigationTimeouts:${telemetry.navigationTimeouts},blocked:${telemetry.blockedRequests},rateLimited:${telemetry.rateLimitedRequests},transient:${telemetry.transientRequests},hostBackoffs:${telemetry.hostBackoffsApplied},clicksStarted:${telemetry.clicksStarted},clicksSucceeded:${telemetry.clicksSucceeded},clicksFailed:${telemetry.clicksFailed},clickFailureClasses:${JSON.stringify(telemetry.clickFailureClasses)}}`;
}

export interface BrowserFallbackResult {
  foundInvite: string | null;
  foundLocation?: string;
  candidates?: DiscordCandidate[];
  inspectedPages: number;
  scrolls: number;
  clicks: number;
  complete: boolean;
  retryable: boolean;
  /**
   * True when the per-seed time budget expired before coverage completed.
   * Threaded separately from failure classes so budget expiration stays
   * semantically distinct from target blocking, zero-page results, and
   * transient/network failures in telemetry and outcome classification.
   */
  timedOut?: boolean;
  /**
   * Browser-gate saturation is capacity, not a launch defect: it is typed
   * alongside (not inside) BrowserFailureClass so retry accounting can defer
   * it attempt-free without tripping browser-capability health marking.
   */
  failureClass?: BrowserFailureClass | 'NO_PAGE_PROCESSED' | 'RENDERED_FALLBACK_SATURATED';
  telemetry?: BrowserFallbackTelemetry;
  detail: string;
}

export const DEFAULT_BROWSER_FALLBACK_BUDGET: BrowserFallbackBudget = {
  maxPages: 6,
  maxScrollsPerPage: 5,
  maxClicksPerPage: 4,
  maxRequestRetries: DEFAULT_RENDERED_MAX_REQUEST_RETRIES,
  maxSessionRotations: DEFAULT_RENDERED_MAX_SESSION_ROTATIONS,
  navigationTimeoutMs: 15_000,
  totalTimeoutMs: 60_000,
};

const COMMUNITY_HINTS = /discord|community|join|chat|member|membership|vip|group|private|trading.?room|links?|social|contact|about/i;

/**
 * Telegram channel pages contain a link for virtually every message. Those
 * message permalinks are content pages, not additional creator/community
 * surfaces, so recursively crawling them spends the rendered acquisition
 * budget without increasing Discord coverage. A post permalink can still be
 * used as the initial seed when explicitly supplied; this only filters links
 * discovered while traversing a rendered page.
 */
export function isTelegramPostPermalink(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (hostname !== 't.me' && hostname !== 'telegram.me') return false;
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length === 2) return /^\d+$/.test(parts[1]);
    if (parts.length === 3 && parts[0].toLowerCase() === 's') return /^\d+$/.test(parts[2]);
    return false;
  } catch {
    return false;
  }
}

export function shouldEnqueueRenderedCommunityLink(rawUrl: string): boolean {
  if (isTelegramPostPermalink(rawUrl)) return false;
  return COMMUNITY_HINTS.test(rawUrl);
}

/**
 * Rendered completion invariant (recall correctness): `complete=true` must
 * never occur when zero pages/requests were processed. The crawler can resolve
 * without ever admitting a request to the request handler (seed rejected
 * pre-handler, deadline before admission, unresolvable hosts such as
 * `https://g/`, redirect-dead short links); all failure counters then stay at
 * zero and the naive `!timedOut && requestsFailed===0` check wrongly reports a
 * clean, fully inspected surface. That false clean suppresses retryability and
 * destroys Discord discovery recall downstream.
 */
export function wasRenderedResultProcessed(
  result: { inspectedPages?: unknown; telemetry?: { requestsStarted?: unknown } | undefined } | null | undefined,
): boolean {
  if (!result || typeof result !== 'object') return false;
  // Processing requires actual successfully inspected page evidence. A
  // request merely starting (admitted but never inspected, e.g. deadline
  // before admission or pre-handler rejection) is zero-page evidence and must
  // not count as processed.
  return (Number(result.inspectedPages) || 0) > 0;
}

/**
 * Order-aware lifecycle dispositions: the LAST terminal event for a request
 * URL wins. A later failure revokes an earlier success (the page's later
 * processing stage failed terminally), and a later full success resolves an
 * earlier failure (retry recovery). This is what keeps a permanently failed
 * child incomplete while letting genuinely recovered retries complete.
 */
export interface RenderedRequestTracker {
  failedRequestUrls: Set<string>;
  succeededRequestUrls: Set<string>;
}

export function createRenderedRequestTracker(): RenderedRequestTracker {
  return { failedRequestUrls: new Set<string>(), succeededRequestUrls: new Set<string>() };
}

/**
 * Crawlee errorHandler path: record a failed attempt for the request URL,
 * revoking any earlier success for the same URL (a later terminal failure
 * must not be erased by an earlier success mark).
 */
export function markRenderedRequestFailed(tracker: RenderedRequestTracker, url: string): void {
  if (!url) return;
  tracker.failedRequestUrls.add(url);
  tracker.succeededRequestUrls.delete(url);
}

/**
 * Crawlee requestHandler path: record fully successful page processing for
 * the request URL, resolving any earlier failure (retry recovery). Call only
 * after the request's page-processing lifecycle completed (initial/scroll
 * inspection, control enumeration, link enqueueing) — never for click
 * handling, never after a merely started request.
 */
export function markRenderedRequestSucceeded(tracker: RenderedRequestTracker, url: string): void {
  if (!url) return;
  tracker.succeededRequestUrls.add(url);
  tracker.failedRequestUrls.delete(url);
}

/** Terminal unresolved failures for completion accounting. */
export function renderedUnresolvedFailureCount(tracker: RenderedRequestTracker): number {
  return terminalUnresolvedFailures(tracker.failedRequestUrls, tracker.succeededRequestUrls);
}

/**
 * Pure terminal-failure accounting: failed request URLs minus URLs with a
 * later success. Deduplicated; click outcomes never participate (callers must
 * only supply request lifecycle URLs).
 */
export function terminalUnresolvedFailures(
  failedRequestUrls: Iterable<string>,
  succeededRequestUrls: Iterable<string>,
): number {
  const succeeded = new Set(succeededRequestUrls);
  let unresolved = 0;
  for (const url of new Set(failedRequestUrls)) {
    if (!succeeded.has(url)) unresolved++;
  }
  return unresolved;
}

export function resolveRenderedCompletionState(input: {
  inspectedPages: number;
  timedOut: boolean;
  telemetry: BrowserFallbackTelemetry;
}): { complete: boolean; retryable: boolean; failureClass: 'NO_PAGE_PROCESSED' | undefined } {
  // Processed means actual successfully inspected page evidence — a request
  // merely starting (admitted but never inspected) is zero-page evidence.
  const processed = input.inspectedPages > 0;
  // Completion considers terminal unresolved failures, not raw attempts: a
  // failed attempt that later succeeds (retry recovery) is resolved and never
  // invalidates coverage, while a request that permanently fails after its
  // retry budget keeps the acquisition incomplete even when sibling pages
  // succeeded (the failed child may hold the Discord evidence sought).
  // Timeouts still fail even with pages (expired budget leaves coverage
  // genuinely unknown; reported as partial downstream when pages exist).
  // Click outcomes never participate: clicks are opportunistic traversal,
  // not acquisition evidence.
  const terminalFailures = input.telemetry?.unresolvedFailedRequests || 0;
  // Failures with zero inspected pages also stay incomplete: page evidence is
  // what the Discord search consumes, so failed attempts that never yielded a
  // page cannot count as coverage (in production these are always terminal,
  // since a recovered request processes its page; the clause keeps partial
  // telemetry from resolving clean).
  const failedWithNoPages = (input.telemetry?.requestsFailed || 0) > 0 && input.inspectedPages === 0;
  const incomplete = !processed || input.timedOut || terminalFailures > 0 || failedWithNoPages;
  return { complete: !incomplete, retryable: incomplete, failureClass: !processed ? 'NO_PAGE_PROCESSED' : undefined };
}

function boundedEnvInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

export class RenderedFallbackGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly concurrency: number, readonly maxPending: number) {}

  private acquire(): Promise<() => void> {
    if (this.active >= this.concurrency && this.waiters.length >= this.maxPending) return Promise.reject(new Error('RENDERED_FALLBACK_SATURATED'));
    return new Promise(resolve => {
      const grant = () => {
        this.active++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active--;
          const next = this.waiters.shift();
          if (next) next();
        });
      };
      if (this.active < this.concurrency) grant(); else this.waiters.push(grant);
    });
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try { return await operation(); } finally { release(); }
  }

  snapshot(): { active: number; pending: number; concurrency: number; maxPending: number } {
    return { active: this.active, pending: this.waiters.length, concurrency: this.concurrency, maxPending: this.maxPending };
  }
}

export const renderedFallbackGate = new RenderedFallbackGate(
  boundedEnvInt(process.env.RENDERED_FALLBACK_CONCURRENCY, 1, 1, 2),
  boundedEnvInt(process.env.RENDERED_FALLBACK_MAX_PENDING, 8, 0, 32),
);

/** Expensive Tier-2 acquisition. Finding one invite no longer terminates the
 * rendered crawl: every invite visible within the bounded page/click budget is
 * retained so ownership can be decided after acquisition. */
export async function crawlRenderedCommunitySurface(seedUrl: string, budget: Partial<BrowserFallbackBudget> = {}): Promise<BrowserFallbackResult> {
  const limits = { ...DEFAULT_BROWSER_FALLBACK_BUDGET, ...budget };
  let inspectedPages = 0, scrolls = 0, clicks = 0;
  const telemetry: BrowserFallbackTelemetry = {
    requestsStarted: 0,
    requestsFinished: 0,
    requestsFailed: 0,
    navigationTimeouts: 0,
    blockedRequests: 0,
    rateLimitedRequests: 0,
    transientRequests: 0,
    unresolvedFailedRequests: 0,
    hostBackoffsApplied: 0,
    clicksStarted: 0,
    clicksSucceeded: 0,
    clicksFailed: 0,
    clickFailureClasses: { BLOCKED: 0, RATE_LIMITED: 0, TRANSIENT: 0, OTHER: 0 },
  };
  // Terminal-vs-recovered accounting shared with completion logic below.
  // Failed attempts and page-processing successes are recorded per request
  // URL; a later success resolves an earlier failure (retry recovery).
  const requestTracker = createRenderedRequestTracker();
  const hostBackoffUntil = new Map<string, number>();
  const discovered:DiscordCandidate[]=[];
  const hostKey = (rawUrl: string): string => {
    try { return new URL(rawUrl).hostname.toLowerCase().replace(/^www\\./, '') || 'unknown'; }
    catch { return 'unknown'; }
  };
  const waitForHostBackoff = async (rawUrl: string, remainingMs: number): Promise<void> => {
    const waitMs = Math.min(remainingMs, Math.max(0, (hostBackoffUntil.get(hostKey(rawUrl)) || 0) - Date.now()));
    if (waitMs <= 0) return;
    telemetry.hostBackoffsApplied++;
    await new Promise(resolve => setTimeout(resolve, waitMs));
  };
  const retain=(text:string,sourceUrl:string)=>{
    const candidates=extractDiscordCandidates(text,'CREATOR_WEBSITES',sourceUrl).filter(candidate=>candidate.nativeInviteCode);
    discovered.push(...candidates);
  };
  retain(seedUrl,seedUrl);

  try {
    return await renderedFallbackGate.run(async () => {
      const startedAt = Date.now();
      try {
        const { PlaywrightCrawler } = await import('crawlee');
        const crawler = new PlaywrightCrawler({
          maxRequestsPerCrawl: limits.maxPages,
          maxConcurrency: 1,
          maxRequestRetries: limits.maxRequestRetries,
          maxSessionRotations: limits.maxSessionRotations,
          useSessionPool: true,
          persistCookiesPerSession: true,
          retryOnBlocked: true,
          sameDomainDelaySecs: 1,
          navigationTimeoutSecs: Math.ceil(limits.navigationTimeoutMs / 1000),
          requestHandlerTimeoutSecs: Math.ceil(limits.totalTimeoutMs / 1000),
          launchContext: { launchOptions: browserLaunchOptions() },
          preNavigationHooks: [async ({ page }) => {
            await page.route('**/*', async route => {
              const type = route.request().resourceType();
              if (['image', 'media', 'font'].includes(type)) await route.abort(); else await route.continue();
            });
          }],
          errorHandler: async ({ request, session }, error) => {
            telemetry.requestsFailed++;
            markRenderedRequestFailed(requestTracker, request.url);
            const retryCount = request.retryCount || 0;
            const policy = renderedCrawlerRetryPolicy(error, retryCount);
            const failureClass = classifyRenderedCrawlerFailure(error);
            if (isRenderedNavigationTimeout(error)) telemetry.navigationTimeouts++;
            if (failureClass === 'BLOCKED') telemetry.blockedRequests++;
            if (failureClass === 'RATE_LIMITED') telemetry.rateLimitedRequests++;
            if (failureClass === 'TRANSIENT') telemetry.transientRequests++;
            if (policy.retireSession) session?.retire();
            const remainingMs = Math.max(0, limits.totalTimeoutMs - (Date.now() - startedAt));
            const backoffMs = Math.min(remainingMs, renderedCrawlerHostBackoffMs(failureClass, retryCount));
            const host = hostKey(request.url);
            if (backoffMs > 0) hostBackoffUntil.set(host, Math.max(hostBackoffUntil.get(host) || 0, Date.now() + backoffMs));
            if (policy.delayMs > 0 && remainingMs > 0) await new Promise(resolve => setTimeout(resolve, Math.min(policy.delayMs, remainingMs)));
          },
          async requestHandler({ page, request, enqueueLinks }) {
            if (Date.now() - startedAt >= limits.totalTimeoutMs) return;
            const remainingMs = Math.max(0, limits.totalTimeoutMs - (Date.now() - startedAt));
            await waitForHostBackoff(request.url, remainingMs);
            if (Date.now() - startedAt >= limits.totalTimeoutMs) return;
            telemetry.requestsStarted++;
            try {
            const inspect = async () => {
              const url=page.url(),html=await page.content();
              retain(`${url}\n${html}`,url);
            };
            // Page evidence counts only after the required extraction actually
            // succeeds: a throw here leaves zero processed evidence (finding:
            // failed extraction must never claim a page).
            await inspect();
            inspectedPages++;

            for (let i = 0; i < limits.maxScrollsPerPage; i++) {
              if (Date.now() - startedAt >= limits.totalTimeoutMs) break;
              const before = await page.evaluate(() => document.body?.scrollHeight || 0);
              await page.evaluate(() => window.scrollTo(0, document.body?.scrollHeight || 0));
              await page.waitForTimeout(500); scrolls++; await inspect();
              const after = await page.evaluate(() => document.body?.scrollHeight || 0);
              if (after <= before) break;
            }

            const controls = await page.locator('a,button,[role="button"]').evaluateAll((nodes, pattern) => {
              const re = new RegExp(pattern, 'i');
              return nodes.map((node, index) => ({index,text:`${(node as HTMLElement).innerText || ''} ${(node as HTMLAnchorElement).href || ''} ${(node as HTMLElement).getAttribute('aria-label') || ''}`})).filter(item => re.test(item.text)).slice(0, 12);
            }, COMMUNITY_HINTS.source);

            for (const control of controls.slice(0, limits.maxClicksPerPage)) {
              if (Date.now() - startedAt >= limits.totalTimeoutMs) break;
              const locator=page.locator('a,button,[role="button"]').nth(control.index);
              const href=await locator.getAttribute('href').catch(()=>null);
              retain(`${control.text} ${href||''}`,page.url());
              telemetry.clicksStarted++;
              try {
                await locator.click({timeout:2_000});
                clicks++;
                telemetry.clicksSucceeded++;
                await page.waitForTimeout(400);
            await inspect();
              } catch (error) {
                telemetry.clicksFailed++;
                const failureClass = classifyRenderedCrawlerFailure(error);
                telemetry.clickFailureClasses[failureClass]++;
              }
            }

            if (Date.now() - startedAt < limits.totalTimeoutMs) {
              await enqueueLinks({strategy:'same-hostname',transformRequestFunction:req=>shouldEnqueueRenderedCommunityLink(req.url)?req:false});
            }
            // Success is recorded only after the request's full page-processing
            // lifecycle completes (load, scroll traversal, control enumeration,
            // link enqueueing). A later terminal failure propagates before this
            // mark, so an earlier success can never erase it; a later full
            // success resolves an earlier failure (retry recovery). Click
            // handling owns no marks: clicks never affect terminal accounting.
            markRenderedRequestSucceeded(requestTracker, request.url);
            } finally {
              telemetry.requestsFinished++;
            }
          },
        });

        await withBrowserRuntimeLease(() => crawler.run([seedUrl]));
        markBrowserCapabilityReady();
        const timedOut=Date.now()-startedAt>=limits.totalTimeoutMs;
        telemetry.unresolvedFailedRequests=renderedUnresolvedFailureCount(requestTracker);
        const completion=resolveRenderedCompletionState({inspectedPages,timedOut,telemetry});
        const noPageProcessed=completion.failureClass==='NO_PAGE_PROCESSED';
        const candidates=mergeDiscordCandidates(discovered);
        const first=candidates[0];
        return {
          foundInvite:first?.nativeInviteCode||null,
          foundLocation:first?.sourceUrl,
          candidates,
          inspectedPages,scrolls,clicks,
          complete:completion.complete,
          retryable:completion.retryable,
          timedOut,
          failureClass:completion.failureClass,
          telemetry,
          detail:candidates.length
            ? `Rendered fallback retained ${candidates.length} distinct Discord candidate(s) across ${inspectedPages} page(s); ${telemetry.requestsFailed} request(s) failed within the bounded crawl; ${browserFallbackTelemetrySummary(telemetry)}`
            : timedOut?`Rendered acquisition budget expired before coverage completed; ${browserFallbackTelemetrySummary(telemetry)}`:telemetry.unresolvedFailedRequests>0?`Rendered acquisition incomplete: ${telemetry.unresolvedFailedRequests} request(s) terminally failed within the bounded crawl; ${browserFallbackTelemetrySummary(telemetry)}`:noPageProcessed?`Rendered acquisition incomplete: no page was processed (NO_PAGE_PROCESSED); ${browserFallbackTelemetrySummary(telemetry)}`:`Rendered acquisition completed across ${inspectedPages} page(s) without an invite; ${browserFallbackTelemetrySummary(telemetry)}`,
        };
      } catch (error:any) {
        const candidates=mergeDiscordCandidates(discovered);
        const failureClass=isBrowserRuntimeFailure(error)?classifyBrowserFailure(error):undefined;
        if (failureClass) markBrowserCapabilityUnavailable(error);
        return {foundInvite:candidates[0]?.nativeInviteCode||null,foundLocation:candidates[0]?.sourceUrl,candidates,inspectedPages,scrolls,clicks,complete:false,retryable:true,timedOut:false,failureClass,telemetry,detail:`Rendered acquisition unavailable or failed: ${browserFallbackTelemetrySummary(telemetry)}`};
      }
    });
  } catch (error:any) {
    const candidates=mergeDiscordCandidates(discovered);
    const saturated=error?.message==='RENDERED_FALLBACK_SATURATED';
    // Saturation is explicit browser-gate capacity, not a browser defect: keep
    // it classified as capacity (so retry accounting can defer attempt-free)
    // without marking the browser capability itself unavailable.
    const failureClass=saturated?'RENDERED_FALLBACK_SATURATED':(!isBrowserRuntimeFailure(error)?undefined:classifyBrowserFailure(error));
    if (failureClass&&!saturated) markBrowserCapabilityUnavailable(error);
    return {foundInvite:candidates[0]?.nativeInviteCode||null,foundLocation:candidates[0]?.sourceUrl,candidates,inspectedPages,scrolls,clicks,complete:false,retryable:true,timedOut:false,failureClass,telemetry,detail:saturated?`Rendered acquisition deferred because the process-wide browser launch gate is saturated; ${browserFallbackTelemetrySummary(telemetry)}`:`Rendered acquisition unavailable or failed: ${browserFallbackTelemetrySummary(telemetry)}`};
  }
}

export function shouldEscalateToRenderedFallback(input: {
  staticOutcome: 'FOUND'|'INSPECTED_NO_MATCH'|'PARTIALLY_INSPECTED'|'ACQUISITION_FAILED';
  creatorLikelyTrading?: boolean;
  surface: 'CREATOR_WEBSITES'|'SOCIAL_PROFILES'|'OTHER';
}): boolean {
  if (input.staticOutcome === 'FOUND') return false;
  if (!input.creatorLikelyTrading) return false;
  if (input.surface === 'OTHER') return false;
  return input.staticOutcome === 'PARTIALLY_INSPECTED' || input.staticOutcome === 'ACQUISITION_FAILED' || input.staticOutcome === 'INSPECTED_NO_MATCH';
}
