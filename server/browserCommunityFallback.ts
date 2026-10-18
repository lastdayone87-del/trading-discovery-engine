import * as cheerio from 'cheerio';
import { assessCrawlAdmission } from './communitySurfacePolicy';
import { candidateFromNativeInvite, extractDiscordCandidates, mergeDiscordCandidates, type DiscordCandidate } from './discordCandidates';
import { browserLaunchOptions, classifyBrowserFailure, isBrowserRuntimeFailure, markBrowserCapabilityReady, markBrowserCapabilityUnavailable, withBrowserRuntimeLease, type BrowserFailureClass } from './browserCapability';
import type { RenderedLifecycleStage, RenderedZeroPageReason, CrawlDropReason } from './crawlerTelemetry';
import { redactCauseSnippet, createDropCounter } from './crawlerTelemetry';
import {
  DEFAULT_RENDERED_MAX_REQUEST_RETRIES,
  DEFAULT_RENDERED_MAX_SESSION_ROTATIONS,
  classifyRenderedCrawlerFailure,
  classifyRenderedClickFailure,
  emptyRenderedClickFailureDetail,
  type RenderedClickFailureKind,
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
  /**
   * Already-inspected absolute URLs (shared same-inspection evidence): the
   * enqueue transform drops them as already-visited instead of refetching,
   * and required classification counts them as visited. Contract: entries
   * must be terminal-success RENDERED evidence at the caller's required tier
   * — static-only evidence must never be passed here, since it cannot satisfy
   * a rendered requirement. Optional and additive; absent behaves exactly as
   * before.
   */
  alreadyVisited?: string[];
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
  /**
   * Additive per-click failure taxonomy (fixed 7 keys; see
   * classifyRenderedClickFailure). The coarser clickFailureClasses buckets
   * above are unchanged. Optional for backward compatibility with rows and
   * test fixtures predating instrumentation; the crawler always initializes
   * it. Sparse in the ledger: omitted when no click has failed yet.
   */
  clickFailureDetail?: Record<RenderedClickFailureKind, number>;
  /**
   * Failed-click control kinds (fixed anchor/button/role keys) and href
   * presence count. Bounded aggregates only: no selectors, texts, or URLs.
   * Optional/sparse like clickFailureDetail.
   */
  clickFailedTargetKinds?: { anchor: number; button: number; role: number };
  clickFailedWithHref?: number;
  /**
   * Single sanitized first-failure sample per crawl
   * ("kind|href|message", URL-stripped, secrets-redacted, capped at 200
   * chars). Never a raw exception object or unbounded text. Optional/sparse.
   */
  firstClickFailureSample?: string;
  /**
   * Furthest lifecycle stage with affirmative evidence for this crawl
   * (seed accepted → gate acquired → crawler running → handler entered →
   * page processed). Required: every telemetry object must state where its
   * crawl stopped, so zero-page outcomes are diagnosable from the ledger.
   */
  lastLifecycleStage: RenderedLifecycleStage;
  /**
   * Explicit zero-page reason, set only when no page was inspected (see
   * resolveRenderedZeroPageReason). Diagnosability only: outcome, retry, and
   * collapse semantics keep reading failureClass and page evidence.
   */
  zeroPageReason?: RenderedZeroPageReason;
  /**
   * Bounded underlying launch/start error text (whitespace-collapsed, capped
   * at 500 chars). Preserves the actual Playwright/browser cause instead of
   * only the generic classifier label.
   */
  launchCauseSnippet?: string;
}

export function browserFallbackTelemetrySummary(telemetry: BrowserFallbackTelemetry): string {
  const base = `telemetry{started:${telemetry.requestsStarted},finished:${telemetry.requestsFinished},failed:${telemetry.requestsFailed},navigationTimeouts:${telemetry.navigationTimeouts},blocked:${telemetry.blockedRequests},rateLimited:${telemetry.rateLimitedRequests},transient:${telemetry.transientRequests},hostBackoffs:${telemetry.hostBackoffsApplied},clicksStarted:${telemetry.clicksStarted},clicksSucceeded:${telemetry.clicksSucceeded},clicksFailed:${telemetry.clicksFailed},clickFailureClasses:${JSON.stringify(telemetry.clickFailureClasses)}}`;
  // Stage/reason suffixes are conditional: snapshots predating instrumentation
  // (and all existing contracted strings) keep their exact legacy shape.
  const extras: string[] = [];
  if (telemetry.lastLifecycleStage) extras.push(`stage:${telemetry.lastLifecycleStage}`);
  if (telemetry.zeroPageReason) extras.push(`zeroPage:${telemetry.zeroPageReason}`);
  return extras.length ? `${base.slice(0, -1)},${extras.join(',')}}` : base;
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
  /**
   * Compact per-crawl drop/stop counters (ints only, no URLs/payloads).
   * Records where candidate links/pages were lost: hint-rejected enqueues,
   * control-slice cuts, page-budget and queue-exhausted stops. Sparse.
   */
  dropReasons?: Partial<Record<CrawlDropReason, number>>;
  /**
   * Required-set acquisition record (v2 coverage contract, all optional and
   * additive — producers lacking instrumentation behave exactly as before):
   * terminal-success page URLs in visit order; the seed document's directly
   * discovered same-host community-hint links; and the required members left
   * unvisited or terminally failed at stop, split by class. Lets callers
   * distinguish sufficient coverage, bounded gaps, and genuine failures
   * without re-parsing page content.
   */
  visitedUrls?: string[];
  /**
   * Per visited page, the same-host community-hint links discovered on it,
   * keyed by normalized visit identity. Present only when pages were
   * inspected; lets callers prove required-set closure for shared-evidence
   * reuse. Additive and optional like the other v2 fields.
   */
  pageHintLinks?: Record<string, string[]>;
  requiredTotal?: number;
  requiredUnvisited?: string[];
  requiredTransientFailures?: string[];
  requiredPermanentFailures?: string[];
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

export const COMMUNITY_HINTS = /discord|community|join|chat|member|membership|vip|group|private|trading.?room|links?|social|contact|about/i;

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
 * Visit identities for one inspected request (redirect-safe evidence
 * filing): the normalized request URL plus, when different, the normalized
 * final page URL. Both identities were terminally inspected, so required
 * closure and shared-evidence decisions stay correct whichever identity a
 * later seed presents. Pure and unit-tested.
 */
export function visitIdentityKeys(requestUrl: string, finalUrl: string): string[] {
  const keys: string[] = [];
  for (const raw of [requestUrl, finalUrl]) {
    const key = normalizeVisitUrl(raw);
    const fallback = (typeof key === 'string' && key.length > 0 ? key : String(raw || '').trim());
    if (fallback && !keys.includes(fallback)) keys.push(fallback);
  }
  return keys;
}

/**
 * Normalized identity for visit-set matching (shared-evidence registry and
 * already-visited exclusion): scheme + lowercased host + non-default port +
 * pathname (trailing slash trimmed) + verbatim query. Same rule both sides
 * so independently recorded URLs meet on one key. Null when unparsable.
 */
export function normalizeVisitUrl(rawUrl: string): string | null {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const path = parsed.pathname.replace(/\/+$/, '') || '/';
  const port = parsed.port ? `:${parsed.port}` : '';
  return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${port}${path}${parsed.search}`;
}

/**
 * Required-set classification (v2 coverage contract), pure and unit-tested:
 * partitions a required URL set into unvisited, transient-failed, and
 * permanent-failed members given terminal-success keys, per-URL terminal
 * failure classes, and already-covered shared keys. BLOCKED is the only
 * permanent access-denial evidence (identical refetch patterns cannot clear
 * a WAF wall within any wall-clock); every other recorded class stays
 * transient-capable under tail-bounded retry rules. Shared-covered members
 * count as visited: exclusion sets passed to crawls must contain only
 * terminal-success evidence at the required-or-higher tier.
 */
export interface RequiredCoverageInput {
  requiredKeys: Iterable<string>;
  succeededKeys: Iterable<string>;
  failedClassesByKey: Map<string, string> | Record<string, string>;
  sharedCoveredKeys?: Iterable<string>;
}

export function classifyRequiredCoverage(input: RequiredCoverageInput): {
  unvisited: string[];
  transientFailures: string[];
  permanentFailures: string[];
} {
  const failedByKey = input.failedClassesByKey instanceof Map
    ? input.failedClassesByKey
    : new Map(Object.entries(input.failedClassesByKey || {}));
  const succeeded = new Set(input.succeededKeys);
  if (input.sharedCoveredKeys) {
    // Shared evidence satisfies a required member only when the current run
    // did not terminally fail it: fresh failure evidence always wins over
    // borrowed success (last-terminal-wins philosophy applied across runs).
    for (const key of input.sharedCoveredKeys) {
      if (key && !failedByKey.has(key)) succeeded.add(key);
    }
  }
  const unvisited: string[] = [];
  const transientFailures: string[] = [];
  const permanentFailures: string[] = [];
  for (const key of new Set(input.requiredKeys)) {
    if (!key || succeeded.has(key)) continue;
    if (!failedByKey.has(key)) {
      unvisited.push(key);
      continue;
    }
    if (failedByKey.get(key) === 'BLOCKED') permanentFailures.push(key);
    else transientFailures.push(key);
  }
  return { unvisited, transientFailures, permanentFailures };
}

/**
 * Required-set discovery (v2 coverage contract): the seed document plus its
 * directly discovered same-host community-hint links. Uses the exact same
 * admission predicate as the enqueue path (same-hostname + community-hint
 * filter + shared crawl admission boundary), so every required URL is
 * enqueue-eligible by construction, admission-rejected URLs can never become
 * required obligations (and therefore never REQUIRED_UNVISITED gaps or retry
 * owners), and any required-but-unvisited URL at stop is genuinely a
 * bounded-traversal gap rather than a filter artifact. Attribute entities are
 * decoded with the project HTML parser (cheerio, same as the static crawler)
 * so encoded identities such as `?x=1&amp;y=2` resolve exactly like the
 * enqueue path sees them. Pure and unit-tested.
 */
export function discoverRequiredSeedLinks(seedHtml: string, seedUrl: string): string[] {
  let page: URL;
  try {
    page = new URL(seedUrl);
  } catch {
    return [];
  }
  let hrefs: string[];
  try {
    const $ = cheerio.load(String(seedHtml || ''));
    hrefs = $('a[href]')
      .map((_, el) => String($(el).attr('href') || '').trim())
      .get()
      .filter(Boolean);
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of hrefs) {
    let absolute: URL;
    try {
      absolute = new URL(raw, seedUrl);
    } catch {
      continue;
    }
    if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') continue;
    if (absolute.hostname.toLowerCase() !== page.hostname.toLowerCase()) continue;
    absolute.hash = '';
    if (!shouldEnqueueRenderedCommunityLink(absolute.toString())) continue;
    // R6 admission boundary: a URL the crawl/enqueue path would reject can
    // never become a required obligation (no false REQUIRED_UNVISITED gaps,
    // no retry ownership from inadmissible candidates).
    if (!assessCrawlAdmission(absolute.toString()).eligible) continue;
    const url = absolute.toString();
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/**
 * One rendered control click attempt (extracted verbatim from the crawl loop
 * so fakes can drive the identical sequence in tests). Sequence is fixed:
 * read href → retain candidate text → click → settle → post-click inspect on
 * success; on failure record both the legacy coarse bucket and the additive
 * fine-grained taxonomy, then return without throwing. Failed clicks never
 * touch request accounting (see markRenderedRequestSucceeded: click handling
 * owns no marks) and never affect page completion — the caller decides
 * completion from page/request evidence only.
 */
export interface RenderedClickAttemptDeps {
  control: RenderedControlTarget;
  pageUrl: string;
  getHref(): Promise<string | null>;
  performClick(): Promise<void>;
  settle(): Promise<void>;
  retain(text: string, pageUrl: string): void;
  inspect(): Promise<void>;
  telemetry: BrowserFallbackTelemetry;
}

export async function attemptRenderedControlClick(
  deps: RenderedClickAttemptDeps,
): Promise<{ ok: boolean; clickFailureKind?: RenderedClickFailureKind }> {
  const { control, pageUrl, getHref, performClick, settle, retain, inspect, telemetry } = deps;
  const href = await getHref().catch(() => null);
  retain(`${control.text} ${href || ''}`, pageUrl);
  telemetry.clicksStarted++;
  try {
    await performClick();
    telemetry.clicksSucceeded++;
    await settle();
    await inspect();
    return { ok: true };
  } catch (error) {
    telemetry.clicksFailed++;
    const failureClass = classifyRenderedCrawlerFailure(error);
    telemetry.clickFailureClasses[failureClass]++;
    const kind = classifyRenderedClickFailure(error);
    if (!telemetry.clickFailureDetail) telemetry.clickFailureDetail = emptyRenderedClickFailureDetail();
    telemetry.clickFailureDetail[kind]++;
    if (!telemetry.clickFailedTargetKinds) telemetry.clickFailedTargetKinds = { anchor: 0, button: 0, role: 0 };
    telemetry.clickFailedTargetKinds[control.tag ?? 'role']++;
    if (typeof href === 'string' && href.length > 0) {
      telemetry.clickFailedWithHref = (telemetry.clickFailedWithHref || 0) + 1;
    }
    if (telemetry.firstClickFailureSample === undefined) {
      telemetry.firstClickFailureSample = buildClickFailureSample(kind, href, error);
    }
    return { ok: false, clickFailureKind: kind };
  }
}

/**
 * Bounded first-failure sample ("kind|href|message", URL-stripped,
 * secrets-redacted, capped at 200 chars). Never a raw exception object or
 * unbounded text; the same sanitizer guards the persistence boundary in
 * crawlerTelemetry.ts.
 */
export function buildClickFailureSample(
  kind: RenderedClickFailureKind,
  href: string | null,
  error: unknown,
): string {
  const message = sanitizeClickFailureMessage(error);
  const sample = `${kind}|${typeof href === 'string' && href.length > 0 ? 'href' : 'nohref'}|${message}`;
  return sample.slice(0, 200);
}

export function sanitizeClickFailureMessage(error: unknown): string {
  const raw = String((error as any)?.message || error || '');
  const stripped = raw.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, '[url]').replace(/[\r\n\t]+/g, ' ').trim();
  const redacted = redactCauseSnippet(stripped, 180);
  return (redacted || 'unknown-click-error').slice(0, 180);
}

/**
 * Production wiring adapter for attemptRenderedControlClick (the exact
 * call-site callbacks). settle() waits only — the single post-click
 * inspect() lives in attemptRenderedControlClick, so a successful click is
 * never double-inspected and a redundant second inspection can never turn a
 * success into a failure. Timeouts keep production values via defaults.
 */
export interface RenderedClickEndpoint {
  getAttribute(name: string): Promise<string | null>;
  click(options: { timeout: number }): Promise<void>;
}

export interface RenderedClickSettler {
  waitForTimeout(ms: number): Promise<void>;
  url(): string;
}

export function createRenderedControlClickDeps(input: {
  locator: RenderedClickEndpoint;
  page: RenderedClickSettler;
  control: RenderedControlTarget;
  retain: (text: string, pageUrl: string) => void;
  inspect: () => Promise<void>;
  telemetry: BrowserFallbackTelemetry;
  onClicked: () => void;
  clickTimeoutMs?: number;
  settleMs?: number;
}): RenderedClickAttemptDeps {
  const { locator, page, control, retain, inspect, telemetry, onClicked } = input;
  const clickTimeoutMs = input.clickTimeoutMs ?? 2_000;
  const settleMs = input.settleMs ?? 400;
  return {
    control,
    pageUrl: page.url(),
    getHref: () => locator.getAttribute('href'),
    performClick: () => locator.click({ timeout: clickTimeoutMs }).then(() => {
      onClicked();
    }),
    settle: () => page.waitForTimeout(settleMs),
    retain,
    inspect,
    telemetry,
  };
}

/**
 * Rendered click targeting (acquisition efficiency): controls whose href
 * resolves to a same-host navigable document that also passes the rendered
 * enqueue/admission rule are discovered deterministically through
 * `enqueueLinks` (same-hostname strategy) and have their text+href
 * Discord-scanned before any click, so clicking them only burns wall-clock
 * (up to 2s timeout + waits per click against the 60s total budget) without
 * adding coverage. Those clicks are skipped; everything else keeps existing
 * behavior exactly:
 * - missing/unparseable href → clicked (fail-open toward recall; a JS
 *   handler may still act),
 * - fragment-only hrefs (`#section`) → clicked (may reveal in-page content),
 * - `javascript:`/non-http(s) hrefs → clicked (only a click can act),
 * - same-host hrefs failing the enqueue rule → clicked (otherwise the URL
 *   would be neither clicked nor enqueued and discovery could be lost),
 * - cross-host http(s) hrefs → clicked (current navigation-away semantics
 *   preserved; `enqueueLinks` would not capture them).
 * Pure and unit-tested; the handler below only consumes the plan.
 */
export interface RenderedControlTarget {
  index: number;
  text: string;
  href: string | null;
  /**
   * Control kind for bounded click-failure aggregates (anchor/button/role).
   * Set at enumeration from the element tag name; optional for backward
   * compatibility with rows predating instrumentation (counted as 'role').
   * Never a selector or payload.
   */
  tag?: 'anchor' | 'button' | 'role';
}

export function isSkippableNavigableAnchorClick(
  target: Pick<RenderedControlTarget, 'href'>,
  pageUrl: string,
): boolean {
  const href = (target.href || '').trim();
  if (!href) return false;
  let page: URL;
  let absolute: URL;
  try {
    page = new URL(pageUrl);
    absolute = new URL(href, pageUrl);
  } catch {
    return false;
  }
  if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') return false;
  const withoutHash = (url: URL): string => {
    const copy = new URL(url.toString());
    copy.hash = '';
    return copy.toString();
  };
  // Fragment-only navigation stays on the same document: clicking may reveal
  // content, so it is never skipped.
  if (withoutHash(absolute) === withoutHash(page)) return false;
  if (absolute.origin !== page.origin) return false;
  // Same admission predicate as the enqueue path: a same-origin anchor that
  // the enqueue rule would reject must still be clicked, otherwise it is
  // neither clicked nor enqueued and discovery could be lost.
  return shouldEnqueueRenderedCommunityLink(absolute.toString());
}

export function partitionRenderedClickTargets(
  controls: RenderedControlTarget[],
  pageUrl: string,
  maxClicks: number,
): { toClick: RenderedControlTarget[]; skippedNavigableAnchors: number } {
  const toClick: RenderedControlTarget[] = [];
  let skippedNavigableAnchors = 0;
  const cap = Math.max(0, Math.trunc(maxClicks) || 0);
  for (const control of controls) {
    if (isSkippableNavigableAnchorClick(control, pageUrl)) {
      skippedNavigableAnchors++;
      continue;
    }
    if (toClick.length >= cap) continue;
    toClick.push(control);
  }
  return { toClick, skippedNavigableAnchors };
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
  /**
   * Terminal failure class per failed URL (v2 required-set accounting):
   * lets classification split required terminal failures into transient
   * (bounded recovery) and permanent (visible, never retries). Additive;
   * entries without a recorded class count as transient-capable.
   */
  failedRequestClasses: Map<string, string>;
}

export function createRenderedRequestTracker(): RenderedRequestTracker {
  return { failedRequestUrls: new Set<string>(), succeededRequestUrls: new Set<string>(), failedRequestClasses: new Map<string, string>() };
}

/**
 * Crawlee errorHandler path: record a failed attempt for the request URL,
 * revoking any earlier success for the same URL (a later terminal failure
 * must not be erased by an earlier success mark).
 */
export function markRenderedRequestFailed(tracker: RenderedRequestTracker, url: string, failureClass?: string): void {
  if (!url) return;
  tracker.failedRequestUrls.add(url);
  tracker.succeededRequestUrls.delete(url);
  if (failureClass) tracker.failedRequestClasses.set(url, failureClass);
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
  tracker.failedRequestClasses.delete(url);
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
  /**
   * Explicit request-budget cutoff: eligible requests remained queued when
   * maxRequestsPerCrawl stopped the crawl. A successful final HTTP response
   * is not coverage proof in that case.
   */
  pageBudgetExhausted?: boolean;
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
  // maxRequestsPerCrawl can stop a crawl whose every started request
  // succeeded: success of the final response must not mask eligible requests
  // still queued, so an explicit budget cutoff keeps the result incomplete
  // and retryable even when nothing failed.
  const pageBudgetCutoff = input.pageBudgetExhausted === true;
  const incomplete = !processed || input.timedOut || terminalFailures > 0 || failedWithNoPages || pageBudgetCutoff;
  return { complete: !incomplete, retryable: incomplete, failureClass: !processed ? 'NO_PAGE_PROCESSED' : undefined };
}

/** Bounded underlying error text: message plus one cause level, redacted, capped. */
export function browserCauseSnippet(error: unknown, maxLength = 500): string | undefined {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
  const causeMessage = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
  const flat = [message, causeMessage && causeMessage !== message ? causeMessage : '']
    .filter(Boolean)
    .join(' | ')
    .replace(/\s+/g, ' ')
    .trim();
  return redactCauseSnippet(flat, maxLength);
}
/**
 * Classifies a crawler-run catch into its durable failure identity. Pure and
 * exported for regression coverage. `launchCauseSnippet` (the
 * browser-launch/startup cause field) is preserved ONLY on affirmative
 * browser launch/startup/runtime failure: an ordinary crawler execution error
 * must never populate a field named "launch cause", so generic throws leave
 * it unset (redaction alone cannot fix that semantic contamination).
 */
export function classifyCrawlCatch(error: unknown, options: { saturated: boolean }): {
  browserLaunchFailed: boolean;
  failureClass: BrowserFailureClass | 'NO_PAGE_PROCESSED' | 'RENDERED_FALLBACK_SATURATED' | undefined;
  preserveLaunchCause: boolean;
} {
  if (options.saturated) {
    return { browserLaunchFailed: false, failureClass: 'RENDERED_FALLBACK_SATURATED', preserveLaunchCause: false };
  }
  const browserLaunchFailed = isBrowserRuntimeFailure(error);
  return {
    browserLaunchFailed,
    failureClass: browserLaunchFailed ? classifyBrowserFailure(error) : undefined,
    preserveLaunchCause: browserLaunchFailed,
  };
}
/**
 * Monotonic lifecycle advance: stages only move forward along
 * GATE_QUEUED → GATE_ACQUIRED → CRAWLER_RUNNING → HANDLER_ENTERED →
 * PAGE_PROCESSED. A later event at a shallower stage (e.g. another handler
 * entry after a page was already processed) can never downgrade the recorded
 * furthest stage, so a successful crawl always retains PAGE_PROCESSED as its
 * terminal observed stage. Pure and exported for regression coverage.
 */
const RENDERED_LIFECYCLE_RANK: Record<RenderedLifecycleStage, number> = {
  GATE_QUEUED: 0,
  GATE_ACQUIRED: 1,
  CRAWLER_RUNNING: 2,
  HANDLER_ENTERED: 3,
  PAGE_PROCESSED: 4,
};
export function advanceRenderedLifecycleStage(
  current: RenderedLifecycleStage,
  event: RenderedLifecycleStage,
): RenderedLifecycleStage {
  return RENDERED_LIFECYCLE_RANK[event] > RENDERED_LIFECYCLE_RANK[current] ? event : current;
}
/**
 * Maps a zero-page crawl to its explicit terminal reason. Pure and exported
 * for regression coverage. Precedence is affirmative-evidence-first:
 * saturation and browser-launch failure classify at their throw sites, then
 * lifecycle stage (startup stages mean the run never began, even when it
 * threw; HANDLER_ENTERED proves admission), then the thrown flag (an aborted
 * started run is never a clean no-op return).
 * Then request-level evidence (failures before admission, deadline before
 * admission), then the residual "returned without requests" bucket. Returns
 * undefined when pages exist. Never perturbs outcome/retry/collapse
 * semantics: those keep reading failureClass and page evidence.
 */
export function resolveRenderedZeroPageReason(input: {
  inspectedPages: number;
  timedOut: boolean;
  saturated: boolean;
  browserLaunchFailed: boolean;
  thrown?: boolean;
  telemetry: Pick<BrowserFallbackTelemetry, 'requestsStarted' | 'requestsFailed' | 'lastLifecycleStage'>;
}): RenderedZeroPageReason | undefined {
  if (input.inspectedPages > 0) return undefined;
  if (input.saturated) return 'GATE_SATURATED';
  if (input.browserLaunchFailed) return 'BROWSER_LAUNCH_FAILED';
  // Lifecycle evidence precedes the thrown flag: a throw before crawler.run()
  // began (module load, construction, lease) never progressed past startup,
  // while a throw at CRAWLER_RUNNING or later aborted a started execution.
  // HANDLER_ENTERED keeps its proof even when the run later threw.
  const stage = input.telemetry.lastLifecycleStage;
  if (stage === 'GATE_QUEUED' || stage === 'GATE_ACQUIRED') return 'CRAWLER_START_FAILED';
  if (stage === 'HANDLER_ENTERED') return 'HANDLER_ENTERED_NO_PAGES';
  if (input.thrown) return 'CRAWLER_RUN_THREW';
  const started = input.telemetry.requestsStarted || 0;
  const failed = input.telemetry.requestsFailed || 0;
  if (failed > 0 && started === 0) return 'PRE_HANDLER_REQUEST_FAILURE';
  if (input.timedOut && started === 0) return 'DEADLINE_BEFORE_ADMISSION';
  return 'CRAWLER_RETURNED_WITHOUT_REQUESTS';
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
  // Stays at 1: withBrowserRuntimeLease serializes every crawler.run() onto
  // one process-wide lease, and each crawl's total-budget clock starts at
  // gate acquisition — admitting 2 would let the second burn its budget
  // waiting for the lease. Env override still wins within the 1..2 bounds.
  boundedEnvInt(process.env.RENDERED_FALLBACK_CONCURRENCY, 1, 1, 2),
  boundedEnvInt(process.env.RENDERED_FALLBACK_MAX_PENDING, 8, 0, 32),
);

let renderedQueueSequence = 0;
/**
 * Opens a request queue isolated to one rendered crawl invocation. Crawlee's
 * process-default persisted queue remembers handled uniqueKeys across crawls,
 * so reusing it lets a repeat crawl of an already-handled seed URL resolve
 * cleanly with zero requests/pages — burning a bounded retry attempt for zero
 * work. A per-invocation named queue makes every crawl independent while
 * preserving within-crawl deduplication (seed plus enqueueLinks children
 * share the instance queue). The caller must drop() the queue in a finally;
 * names are unique per process lifetime so concurrent crawls never collide.
 * The opener is injected so unit tests can prove the contract without
 * touching real storage.
 */
export async function openIsolatedRenderedRequestQueue<T extends { drop: () => Promise<void> }>(
  open: (name: string) => Promise<T>,
): Promise<{ name: string; queue: T }> {
  renderedQueueSequence = (renderedQueueSequence + 1) % Number.MAX_SAFE_INTEGER;
  const name =
    `rendered-community-${process.pid.toString(36)}-` +
    `${Date.now().toString(36)}-${renderedQueueSequence.toString(36)}` +
    Math.floor(Math.random() * 0xffffffff).toString(36);
  return { name, queue: await open(name) };
}

/**
 * Best-effort cleanup for a per-crawl isolated queue. Drop failures never
 * change the crawl result (the crawl already settled): they emit one bounded
 * operational warning carrying only the generated queue name plus the
 * redacted storage error, so silent accumulation stays observable without
 * ever leaking URLs, credentials, or tokens.
 */
export async function dropIsolatedRenderedQueue(
  queue: { drop: () => Promise<void> },
  name: string,
): Promise<void> {
  try {
    await queue.drop();
  } catch (error) {
    console.warn(
      `[RenderedAcquisition] Isolated request queue cleanup failed for ${name}: ${browserCauseSnippet(error) || 'unknown storage error'}`,
    );
  }
}

/**
 * Minimal structural view of Crawlee's process-wide `AsyncEventEmitter`
 * (reachable at runtime as `EventManager.events`; protected in Crawlee's type
 * declarations). Only the listener bookkeeping methods are needed.
 */
export interface RenderedQueueLifecycleEmitter {
  listeners(event: string): unknown[];
  off(event: string, listener: unknown): unknown;
}

/** Listener identities registered before a crawl opened its isolated queue. */
export interface RenderedQueueListenerLedger {
  migrating: Set<unknown>;
  aborting: Set<unknown>;
}

const RENDERED_QUEUE_LIFECYCLE_EVENTS = ['migrating', 'aborting'] as const;

function isRenderedQueueLifecycleEmitter(value: unknown): value is RenderedQueueLifecycleEmitter {
  const candidate = value as Partial<RenderedQueueLifecycleEmitter> | null | undefined;
  return !!candidate && typeof candidate.listeners === 'function' && typeof candidate.off === 'function';
}

/** Extracts the process-wide queue lifecycle emitter from a Crawlee
 * EventManager, or undefined when that shape is unavailable. */
export function renderedQueueLifecycleEmitter(eventManager: unknown): RenderedQueueLifecycleEmitter | undefined {
  const events = (eventManager as { events?: unknown } | null | undefined)?.events;
  return isRenderedQueueLifecycleEmitter(events) ? events : undefined;
}

/** Records the 'migrating'/'aborting' listeners already present before a crawl
 * opens its isolated queue. */
export function captureRenderedQueueLifecycleListeners(
  emitter: RenderedQueueLifecycleEmitter | undefined,
): RenderedQueueListenerLedger {
  return {
    migrating: new Set(emitter ? emitter.listeners('migrating') : []),
    aborting: new Set(emitter ? emitter.listeners('aborting') : []),
  };
}

/**
 * Removes exactly the 'migrating'/'aborting' listeners that were registered
 * since the ledger was captured and returns the number removed.
 *
 * Crawlee 3.18 registers anonymous process-wide `migrating`/`aborting`
 * listeners when a RequestQueue is constructed and nothing ever removes them:
 * `drop()` only deletes storage, crawler teardown only removes the crawler's
 * own bound listeners, and `RequestQueue._reset()` (protected) does not touch
 * listeners. A dropped per-crawl queue therefore stayed strongly referenced
 * forever, and each retained instance keeps its RequestDeduplicationCache —
 * two `new Array(1_000_000)` slot tables, ~16 MB per instance (verified by
 * heap profiling: ~15 MB live growth per queue lifecycle; flat once listeners
 * are reclaimed). Reuse after `drop()` is not a supported alternative (no
 * public re-open; `drop()` closes the StorageManager registration), so the
 * smallest safe lifecycle change is to keep the fresh-queue-per-crawl
 * isolation semantics and reclaim the queue's process-wide registrations in
 * the crawl finally. `renderedFallbackGate` plus
 * `withRenderedQueueLifecycleLock` serialize each crawl end-to-end, so no
 * other live queue can own a listener added after the capture; a future
 * Crawlee that stops registering or stops leaking degrades to a harmless
 * no-op.
 */
export function reclaimRenderedQueueLifecycleListeners(
  emitter: RenderedQueueLifecycleEmitter | undefined,
  ledger: RenderedQueueListenerLedger,
): number {
  if (!emitter) return 0;
  let reclaimed = 0;
  for (const event of RENDERED_QUEUE_LIFECYCLE_EVENTS) {
    for (const listener of emitter.listeners(event)) {
      if (!ledger[event].has(listener)) {
        emitter.off(event, listener);
        reclaimed++;
      }
    }
  }
  return reclaimed;
}

let renderedQueueLifecycleTail: Promise<void> = Promise.resolve();

/**
 * Serializes a complete per-crawl queue lifecycle — emitter capture, isolated
 * queue open, crawler run, drop, and listener reclamation — on one
 * process-wide promise chain. The rendered fallback gate admits up to
 * RENDERED_FALLBACK_CONCURRENCY crawls (env-bound 1..2), but the
 * snapshot-based reclamation above can only attribute listeners correctly
 * while no other queue is being constructed on the shared emitter: without
 * serialization an earlier crawl's cleanup removes a later crawl's still-live
 * listeners. At the default gate width of 1 this adds no scheduling (the gate
 * already serializes, and crawler runs are further serialized onto the
 * process-wide browser runtime lease).
 */
export async function withRenderedQueueLifecycleLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = renderedQueueLifecycleTail;
  let release!: () => void;
  renderedQueueLifecycleTail = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

/**
 * End-of-crawl cleanup shared by every path through the crawl finally: drop
 * the isolated queue (best-effort with a bounded warning — see
 * dropIsolatedRenderedQueue) and then reclaim the anonymous process-wide
 * listeners the queue construction added, so the dropped queue and its ~16 MB
 * RequestDeduplicationCache become collectable. Exported so tests can drive
 * the exact lifecycle the finally runs, including the failing-drop path.
 * Returns the number of reclaimed listeners.
 */
export async function finalizeRenderedQueueLifecycle(options: {
  queue: { drop(): Promise<void> } | undefined;
  name: string | undefined;
  emitter: RenderedQueueLifecycleEmitter | undefined;
  ledger: RenderedQueueListenerLedger;
}): Promise<number> {
  if (options.queue && options.name !== undefined) {
    await dropIsolatedRenderedQueue(options.queue, options.name);
  }
  return reclaimRenderedQueueLifecycleListeners(options.emitter, options.ledger);
}

/** Expensive Tier-2 acquisition. Finding one invite no longer terminates the
 * rendered crawl: every invite visible within the bounded page/click budget is
 * retained so ownership can be decided after acquisition. */
export async function crawlRenderedCommunitySurface(seedUrl: string, budget: Partial<BrowserFallbackBudget> = {}): Promise<BrowserFallbackResult> {
  const limits = { ...DEFAULT_BROWSER_FALLBACK_BUDGET, ...budget };
  let inspectedPages = 0, scrolls = 0, clicks = 0;
  // Per-crawl drop accounting (compact ints only): where candidate links or
  // pages were lost to enqueue/click/budget rules. Attached to the result for
  // ledger persistence; never URLs or payloads.
  const drops = createDropCounter();
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
    clickFailureDetail: emptyRenderedClickFailureDetail(),
    clickFailedTargetKinds: { anchor: 0, button: 0, role: 0 },
    clickFailedWithHref: 0,
    lastLifecycleStage: 'GATE_QUEUED',
  };
  // Terminal-vs-recovered accounting shared with completion logic below.
  // Failed attempts and page-processing successes are recorded per request
  // URL; a later success resolves an earlier failure (retry recovery).
  const requestTracker = createRenderedRequestTracker();
  const hostBackoffUntil = new Map<string, number>();
  // v2 required-set tracking: the seed document plus its directly discovered
  // same-host community-hint links (computed once from the first inspected
  // page with the same predicate as the enqueue path). Terminal-success page
  // URLs accumulate in visit order for the shared-evidence registry.
  let seedDocumentSeen = false;
  let seedRequiredLinks: string[] = [];
  const terminalSuccessUrls: string[] = [];
  // Per visited page, the same-host community-hint links discovered on it
  // (same predicate as the enqueue path): lets callers prove required-set
  // closure for shared-evidence reuse without re-parsing page content.
  const pageHintLinks = new Map<string, Set<string>>();
  // Already-inspected URLs from earlier same-inspection work: excluded from
  // enqueueing (counted as already-visited) instead of being refetched.
  const alreadyVisitedSet = new Set(
    (limits.alreadyVisited || [])
      .map(normalizeVisitUrl)
      .filter((key): key is string => typeof key === 'string' && key.length > 0),
  );
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
    return await renderedFallbackGate.run(() => withRenderedQueueLifecycleLock(async () => {
      telemetry.lastLifecycleStage = advanceRenderedLifecycleStage(telemetry.lastLifecycleStage, 'GATE_ACQUIRED');
      const startedAt = Date.now();
      const { PlaywrightCrawler, RequestQueue, Configuration } = await import('crawlee');
      // Crawlee 3.18 registers anonymous process-wide `migrating`/`aborting`
      // listeners for every RequestQueue instance and never removes them, and
      // each instance carries a ~16 MB RequestDeduplicationCache (two
      // 1,000,000-slot arrays). Unreclaimed, every dropped per-crawl queue
      // stayed strongly referenced forever — ~15 MB live growth per crawl,
      // reaching the 2048 MB heap cap in ~35 minutes at production render
      // rates (FATAL ERROR: Reached heap limit). Capture the emitter state
      // before opening and reclaim the new listeners in the finally below:
      // the fresh-queue-per-crawl isolation semantics stay unchanged while the
      // dropped queue graph becomes collectable. The whole capture-through-
      // reclamation window runs under withRenderedQueueLifecycleLock so
      // overlapping crawls (env concurrency 2) cannot cross-remove listeners.
      const queueEventEmitter = renderedQueueLifecycleEmitter(Configuration.getGlobalConfig().getEventManager());
      const queueListenerLedger = captureRenderedQueueLifecycleListeners(queueEventEmitter);
      let isolated: { name: string; queue: InstanceType<typeof RequestQueue> } | undefined;
      try {
        // Per-invocation isolated queue: never the process-default persisted
        // queue (see openIsolatedRenderedRequestQueue). Dropped in the finally
        // below on every path so named queues cannot accumulate.
        isolated = await openIsolatedRenderedRequestQueue((name) => RequestQueue.open(name));
        const crawler = new PlaywrightCrawler({
          requestQueue: isolated.queue,
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
            const failureClass = classifyRenderedCrawlerFailure(error);
            markRenderedRequestFailed(requestTracker, request.url, failureClass);
            const retryCount = request.retryCount || 0;
            const policy = renderedCrawlerRetryPolicy(error, retryCount);
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
            // Handler entry proves navigation completed (Crawlee navigates
            // before invoking the handler). Recorded before the deadline
            // guards so even an immediately-returning handler leaves proof
            // that admission happened.
            telemetry.lastLifecycleStage = advanceRenderedLifecycleStage(telemetry.lastLifecycleStage, 'HANDLER_ENTERED');
            if (Date.now() - startedAt >= limits.totalTimeoutMs) return;
            const remainingMs = Math.max(0, limits.totalTimeoutMs - (Date.now() - startedAt));
            await waitForHostBackoff(request.url, remainingMs);
            if (Date.now() - startedAt >= limits.totalTimeoutMs) return;
            telemetry.requestsStarted++;
            try {
            // Snapshot lifetime: candidates are extracted from the FULL page
            // source (never truncated before extraction) and the multi-MB
            // string is released before any scroll/click work, so at most one
            // snapshot is ever retained. URL and markup are scanned in
            // separate retain() calls: invite patterns exclude whitespace, so
            // no match can span the former "\n" join — identical recall with
            // half the peak transient (no url+html duplicate string).
            const inspect = async () => {
              const url = page.url();
              let html: string | null = await page.content();
              try {
                retain(url, url);
                if (html !== null) {
                  retain(html, url);
                  try {
                    // Request and final-page identities share one evidence bucket
                    // (see visitIdentityKeys): for a redirected request both
                    // identities were terminally inspected, so required-closure
                    // and shared-evidence decisions stay correct whichever
                    // identity a later seed presents.
                    for (const identity of visitIdentityKeys(request.url, url)) {
                      let bucket = pageHintLinks.get(identity);
                      if (!bucket) {
                        bucket = new Set<string>();
                        pageHintLinks.set(identity, bucket);
                      }
                      for (const link of discoverRequiredSeedLinks(html, url)) bucket.add(link);
                    }
                  } catch { /* hint inventory never breaks inspection */ }
                }
              } finally {
                html = null;
              }
            };
            // Page evidence counts only after the required extraction actually
            // succeeds: a throw here leaves zero processed evidence (finding:
            // failed extraction must never claim a page).
            await inspect();
            inspectedPages++;
            telemetry.lastLifecycleStage = advanceRenderedLifecycleStage(telemetry.lastLifecycleStage, 'PAGE_PROCESSED');
            if (!seedDocumentSeen) {
              seedDocumentSeen = true;
              try {
                seedRequiredLinks = discoverRequiredSeedLinks(await page.content(), page.url());
              } catch {
                seedRequiredLinks = [];
              }
            }

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
              // Bounded candidate pool (64): the click plan partitions the
              // complete matching set FIRST so skipped navigable anchors can
              // never hide a later click-only control behind the old take-12
              // window. Locator indexes stay positional in the full query.
              // The tag feeds bounded click-failure aggregates (anchor/button/
              // role) and nothing else: selection behavior is unchanged.
              return nodes.map((node, index) => {
                const tagName = ((node as HTMLElement).tagName || '').toLowerCase();
                return {index,text:`${(node as HTMLElement).innerText || ''} ${(node as HTMLAnchorElement).href || ''} ${(node as HTMLElement).getAttribute('aria-label') || ''}`,href:(node as HTMLAnchorElement).href || null,tag:(tagName === 'a' ? 'anchor' : tagName === 'button' ? 'button' : 'role') as 'anchor' | 'button' | 'role'};
              }).filter(item => re.test(item.text)).slice(0, 64);
            }, COMMUNITY_HINTS.source);
            // Navigable same-host anchors are already discovered through
            // enqueueLinks and Discord-scanned before any click, so the click
            // budget is reserved for controls that only a click can act on
            // (href-less buttons, fragments, JS links, cross-host targets).
            // Slice accounting covers the remainder beyond clicks and skips.
            const clickPlan = partitionRenderedClickTargets(controls, page.url(), limits.maxClicksPerPage);
            drops.count('control-slice', Math.max(0, controls.length - clickPlan.toClick.length - clickPlan.skippedNavigableAnchors));
            // Shared enqueue admission (single rule definition): already-visited
            // exclusion, then the shared crawl admission boundary, then the
            // community-hint filter. Used by both enqueue passes below.
            const admitEnqueueRequest = (url: string): boolean => {
              const visitKey = normalizeVisitUrl(url);
              if (visitKey && alreadyVisitedSet.has(visitKey)) {
                drops.count('already-visited');
                return false;
              }
              if (!assessCrawlAdmission(url).eligible) {
                drops.count('admission-rejected');
                return false;
              }
              if (shouldEnqueueRenderedCommunityLink(url)) return true;
              drops.count('hint-rejected');
              return false;
            };
            // Capture the original page's discoverable anchors BEFORE executing
            // controls that may navigate away: a button/cross-host click can
            // replace the document, and the post-click enqueue below would
            // then scan the new page instead. The post-click enqueue is kept
            // (JS-revealed links), so both DOM states contribute; queue
            // dedupe makes repeats free. Hint-rejected double counts across
            // the two passes are bounded diagnostic noise (≤1 extra pass).
            if (Date.now() - startedAt < limits.totalTimeoutMs) {
              await enqueueLinks({ strategy: 'same-hostname', transformRequestFunction: req => (admitEnqueueRequest(req.url) ? req : false) });
            }

            for (const control of clickPlan.toClick) {
              if (Date.now() - startedAt >= limits.totalTimeoutMs) break;
              const locator=page.locator('a,button,[role="button"]').nth(control.index);
              await attemptRenderedControlClick(createRenderedControlClickDeps({
                locator: locator as unknown as RenderedClickEndpoint,
                page: page as unknown as RenderedClickSettler,
                control,
                retain,
                inspect,
                telemetry,
                onClicked: () => { clicks++; },
              }));
            }

            if (Date.now() - startedAt < limits.totalTimeoutMs) {
              await enqueueLinks({strategy:'same-hostname',transformRequestFunction:req=>(admitEnqueueRequest(req.url)?req:false)});
            }
            // Success is recorded only after the request's full page-processing
            // lifecycle completes (load, scroll traversal, control enumeration,
            // link enqueueing). A later terminal failure propagates before this
            // mark, so an earlier success can never erase it; a later full
            // success resolves an earlier failure (retry recovery). Click
            // handling owns no marks: clicks never affect terminal accounting.
            markRenderedRequestSucceeded(requestTracker, request.url);
            for (const identity of visitIdentityKeys(request.url, page.url())) {
              if (!terminalSuccessUrls.includes(identity)) terminalSuccessUrls.push(identity);
            }
            } catch (attemptError) {
              // Release only the failed page; Crawlee still classifies the
              // original error and retries with a fresh page per
              // maxRequestRetries/maxSessionRotations. The close is
              // best-effort and never masks the error: classification, the
              // errorHandler accounting above, and retry see attemptError
              // unchanged, and a failed page is never referenced afterwards.
              await page.close().catch(() => undefined);
              throw attemptError;
            } finally {
              telemetry.requestsFinished++;
            }
          },
        });

        // Proves the crawl was scheduled and attempted; the handler overwrites
        // this with deeper stages when navigation/admission actually happens.
        // A throw below (e.g. browser launch failure) keeps CRAWLER_RUNNING,
        // and the browser flag — not the stage — carries that classification.
        telemetry.lastLifecycleStage = advanceRenderedLifecycleStage(telemetry.lastLifecycleStage, 'CRAWLER_RUNNING');
        await withBrowserRuntimeLease(() => crawler.run([seedUrl]));
        markBrowserCapabilityReady();
        // Request-budget cutoff is measured from the supported queue-info API:
        // after the run, pendingRequestCount reports eligible requests that
        // maxRequestsPerCrawl left unstarted, so a successful final response
        // cannot prove complete coverage while work remains queued. When the
        // stat is unreadable AND the crawl reached maxPages, fail
        // conservatively (assume cutoff) rather than proving completion.
        // Best-effort read only (the queue drops in the finally below): it
        // never throws into the crawl result.
        let pendingEligibleRequests: number | null = null;
        try {
          const info = await (isolated.queue as unknown as { getInfo?: () => Promise<{ pendingRequestCount?: unknown }> }).getInfo?.();
          const pending = (info as { pendingRequestCount?: unknown } | null | undefined)?.pendingRequestCount;
          if (typeof pending === 'number' && Number.isFinite(pending)) {
            pendingEligibleRequests = Math.max(0, Math.floor(pending));
          }
        } catch { pendingEligibleRequests = null; }
        const reachedPageBudget = telemetry.requestsStarted >= limits.maxPages;
        const pageBudgetExhausted = pendingEligibleRequests === null
          ? reachedPageBudget
          : pendingEligibleRequests > 0 && reachedPageBudget;
        const timedOut=Date.now()-startedAt>=limits.totalTimeoutMs;
        telemetry.unresolvedFailedRequests=renderedUnresolvedFailureCount(requestTracker);
        const completion=resolveRenderedCompletionState({inspectedPages,timedOut,telemetry,pageBudgetExhausted});
        const noPageProcessed=completion.failureClass==='NO_PAGE_PROCESSED';
        const zeroPageReason=resolveRenderedZeroPageReason({inspectedPages,timedOut,saturated:false,browserLaunchFailed:false,thrown:false,telemetry});
        if (zeroPageReason) telemetry.zeroPageReason=zeroPageReason;
        const candidates=mergeDiscordCandidates(discovered);
        const first=candidates[0];
        // Terminal stop attribution: a complete crawl below the page budget
        // with nothing still queued ended for lack of enqueueable links;
        // eligible requests still queued mean the request budget cut coverage.
        // v2 required-set classification (pure helper): the seed document plus
        // its directly discovered same-host community-hint links, partitioned
        // by terminal state. Shared-covered members count as visited: the
        // already-visited exclusion set carries terminal-success rendered
        // evidence by contract, so it can never manufacture a false
        // REQUIRED_UNVISITED gap. Depth-2+ remainder is opportunistic by
        // definition and never appears here.
        const succeededKeys = new Set(
          [...requestTracker.succeededRequestUrls]
            .map(normalizeVisitUrl)
            .filter((key): key is string => typeof key === 'string' && key.length > 0),
        );
        const failedByKey = new Map<string, string | undefined>();
        for (const failed of requestTracker.failedRequestUrls) {
          const key = normalizeVisitUrl(failed);
          if (typeof key === 'string' && key.length > 0 && !succeededKeys.has(key) && !failedByKey.has(key)) {
            failedByKey.set(key, requestTracker.failedRequestClasses.get(failed));
          }
        }
        const requiredUnvisited: string[] = [];
        const requiredTransientFailures: string[] = [];
        const requiredPermanentFailures: string[] = [];
        let requiredTotal = 0;
        if (seedDocumentSeen) {
          const requiredKeys = new Set(
            [seedUrl, ...seedRequiredLinks]
              .map(normalizeVisitUrl)
              .filter((key): key is string => typeof key === 'string' && key.length > 0),
          );
          requiredTotal = requiredKeys.size;
          const classified = classifyRequiredCoverage({
            requiredKeys,
            succeededKeys,
            failedClassesByKey: failedByKey,
            sharedCoveredKeys: alreadyVisitedSet,
          });
          requiredUnvisited.push(...classified.unvisited);
          requiredTransientFailures.push(...classified.transientFailures);
          requiredPermanentFailures.push(...classified.permanentFailures);
        }
        if (completion.complete && !pageBudgetExhausted && inspectedPages < limits.maxPages) drops.count('queue-exhausted');
        if (pageBudgetExhausted) drops.count('page-budget');
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
          dropReasons:drops.snapshot(),
          visitedUrls: terminalSuccessUrls.length ? [...terminalSuccessUrls] : undefined,
          pageHintLinks: (() => {
            const record: Record<string, string[]> = {};
            let entries = 0;
            for (const [page, links] of pageHintLinks) {
              if (entries >= 64) break;
              record[page] = [...links].slice(0, 64);
              entries++;
            }
            return entries ? record : undefined;
          })(),
          requiredTotal: seedDocumentSeen ? requiredTotal : undefined,
          requiredUnvisited: seedDocumentSeen && requiredUnvisited.length ? requiredUnvisited : undefined,
          requiredTransientFailures: seedDocumentSeen && requiredTransientFailures.length ? requiredTransientFailures : undefined,
          requiredPermanentFailures: seedDocumentSeen && requiredPermanentFailures.length ? requiredPermanentFailures : undefined,
          detail:candidates.length
            ? `Rendered fallback retained ${candidates.length} distinct Discord candidate(s) across ${inspectedPages} page(s); ${telemetry.requestsFailed} request(s) failed within the bounded crawl; ${browserFallbackTelemetrySummary(telemetry)}`
            : timedOut?`Rendered acquisition budget expired before coverage completed; ${browserFallbackTelemetrySummary(telemetry)}`:telemetry.unresolvedFailedRequests>0?`Rendered acquisition incomplete: ${telemetry.unresolvedFailedRequests} request(s) terminally failed within the bounded crawl; ${browserFallbackTelemetrySummary(telemetry)}`:noPageProcessed?`Rendered acquisition incomplete: no page was processed (NO_PAGE_PROCESSED); ${browserFallbackTelemetrySummary(telemetry)}`:`Rendered acquisition completed across ${inspectedPages} page(s) without an invite; ${browserFallbackTelemetrySummary(telemetry)}`,
        };
      } catch (error:any) {
        const candidates=mergeDiscordCandidates(discovered);
        const catchClass=classifyCrawlCatch(error,{saturated:false});
        const browserLaunchFailed=catchClass.browserLaunchFailed;
        const failureClass=catchClass.failureClass;
        if (failureClass) markBrowserCapabilityUnavailable(error);
        const causeSnippet=catchClass.preserveLaunchCause?browserCauseSnippet(error):undefined;
        if (causeSnippet) telemetry.launchCauseSnippet=causeSnippet;
        const zeroPageReason=resolveRenderedZeroPageReason({inspectedPages,timedOut:false,saturated:false,browserLaunchFailed,thrown:true,telemetry});
        if (zeroPageReason) telemetry.zeroPageReason=zeroPageReason;
        return {foundInvite:candidates[0]?.nativeInviteCode||null,foundLocation:candidates[0]?.sourceUrl,candidates,inspectedPages,scrolls,clicks,complete:false,retryable:true,timedOut:false,failureClass,telemetry,dropReasons:drops.snapshot(),detail:`Rendered acquisition unavailable or failed${causeSnippet?` (cause: ${causeSnippet})`:''}: ${browserFallbackTelemetrySummary(telemetry)}`};
      } finally {
        // The isolated queue must never outlive its crawl: the lifecycle
        // finalizer drops it on success, failure, and unexpected throws alike
        // (best-effort with a bounded warning — see dropIsolatedRenderedQueue)
        // and then reclaims the anonymous process-wide listeners the queue
        // construction added (see the capture above), so the dropped queue and
        // its ~16 MB deduplication cache become collectable. Runs on every
        // path, including open failures and drop failures; it never affects
        // the crawl result.
        await finalizeRenderedQueueLifecycle({
          queue: isolated?.queue,
          name: isolated?.name,
          emitter: queueEventEmitter,
          ledger: queueListenerLedger,
        });
      }
    }));
  } catch (error:any) {
    const candidates=mergeDiscordCandidates(discovered);
    const saturated=error?.message==='RENDERED_FALLBACK_SATURATED';
    // Saturation is explicit browser-gate capacity, not a browser defect: keep
    // it classified as capacity (so retry accounting can defer attempt-free)
    // without marking the browser capability itself unavailable.
    const catchClass=classifyCrawlCatch(error,{saturated});
    const browserLaunchFailed=catchClass.browserLaunchFailed;
    const failureClass=catchClass.failureClass;
    if (failureClass&&!saturated) markBrowserCapabilityUnavailable(error);
    const causeSnippet=catchClass.preserveLaunchCause?browserCauseSnippet(error):undefined;
    if (causeSnippet) telemetry.launchCauseSnippet=causeSnippet;
    const zeroPageReason=resolveRenderedZeroPageReason({inspectedPages,timedOut:false,saturated,browserLaunchFailed,telemetry});
    if (zeroPageReason) telemetry.zeroPageReason=zeroPageReason;
    return {foundInvite:candidates[0]?.nativeInviteCode||null,foundLocation:candidates[0]?.sourceUrl,candidates,inspectedPages,scrolls,clicks,complete:false,retryable:true,timedOut:false,failureClass,telemetry,detail:saturated?`Rendered acquisition deferred because the process-wide browser launch gate is saturated; ${browserFallbackTelemetrySummary(telemetry)}`:`Rendered acquisition unavailable or failed${causeSnippet?` (cause: ${causeSnippet})`:''}: ${browserFallbackTelemetrySummary(telemetry)}`};
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
