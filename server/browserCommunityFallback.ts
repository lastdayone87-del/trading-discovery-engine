import * as cheerio from 'cheerio';
import { assessCrawlAdmission } from './communitySurfacePolicy';
import { assessPublicDestination, type DnsResolver } from './publicDestination';
import { candidateFromNativeInvite, extractDiscordCandidates, mergeDiscordCandidates, type DiscordCandidate } from './discordCandidates';
import { browserLaunchOptions, classifyBrowserFailure, isBrowserRuntimeFailure, markBrowserCapabilityReady, markBrowserCapabilityUnavailable, withBrowserRuntimeLease, type BrowserFailureClass } from './browserCapability';
import { startBrowserEgressProxy, type BrowserEgressProxy } from './browserEgressProxy';
import type {
  RenderedLifecycleStage,
  RenderedZeroPageReason,
  CrawlDropReason,
  NavigationPolicyExclusionReason,
  RenderedCoverageReason,
} from './crawlerTelemetry';
import {
  redactCauseSnippet,
  createDropCounter,
  resolveRenderedCoverageReason,
  sanitizeNavigationPolicyExcluded,
  NAVIGATION_POLICY_EXCLUSION_REASONS,
} from './crawlerTelemetry';
import { normalizeVisitUrl } from './visitUrl';
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
  /** Rotate which evidence controls get the bounded click budget on retries.
   * Stable across a single page; callers may seed from scan attempts so a
   * retry can examine controls beyond the first budget window. */
  clickOffset?: number;
  /** Optional resolver for the rendered-tier public-destination guard. The
   * browser path is defense-in-depth: static SSRF blocks must never escalate,
   * and every navigation/subrequest is also checked here. Tests inject a
   * deterministic resolver; production defaults to system DNS. */
  resolveHost?: DnsResolver;
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
  /** Bounded control-coverage certificate (counts only). Sparse: omitted when
   * no evidence-bearing control was enumerated. */
  evidenceControlsTotal?: number;
  evidenceControlsClicked?: number;
  evidenceControlsFailed?: number;
  evidenceControlsSkipped?: number;
  /** True when every processed page with controls had an entirely navigable
   * evaluation window, so zero clicks were attempted but each window was fully
   * examined. Drives durable retry rotation past an otherwise zero-click
   * window; absent on pre-instrumentation rows. */
  evidenceControlsNavigableOnly?: boolean;
  /** True when at least one processed page had clickable controls inside its
   * evaluation window but recorded no progress (deadline, zero click budget,
   * detached marker). A shared per-seed offset must not advance based on
   * another page's progress while this page's window is unexamined. Sparse. */
  evidenceControlsUncertified?: boolean;
  /** Bounded number of full-pool positions the durable retry offset should
   * advance after this crawl: the smallest per-page progress, so a page with a
   * smaller pool is never rotated past controls it did not examine. Sparse;
   * absent on pre-instrumentation rows. */
  evidenceControlsOffsetAdvance?: number;
  /**
   * P0.2 navigation-coverage counters (counts only, no selectors/text/URLs).
   * `controlsEnumeratedTotal` is the pre-filter denominator; the difference
   * from the evidence-bearing matched set is `controlsHintRejected`.
   */
  controlsEnumeratedTotal?: number;
  controlsHintRejected?: number;
  controlsStructuralNavigation?: number;
  controlsStructuralHintRejected?: number;
  controlsIconLabelRecovered?: number;
  popupTargets?: number;
  frameCount?: number;
  shadowRootCount?: number;
  baseHrefPresent?: boolean;
  scrollCapReachedStillGrowing?: boolean;
  navigationPolicyExcluded?: Partial<Record<NavigationPolicyExclusionReason, number>>;
  coverageReason?: RenderedCoverageReason;
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
  failureClass?: BrowserFailureClass | 'NO_PAGE_PROCESSED' | 'RENDERED_FALLBACK_SATURATED' | 'SSRF_BLOCKED';
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
  /**
   * Interaction coverage certificate (v3 completion, all optional/additive):
   * evidence-bearing controls seen on processed pages, how many were clicked
   * or failed, and how many were skipped by the click/control budget. A
   * non-zero failure/skip count means content behind a control was never
   * examined and the run must not resolve as a clean no-match.
   */
  evidenceControlsTotal?: number;
  evidenceControlsClicked?: number;
  evidenceControlsFailed?: number;
  evidenceControlsSkipped?: number;
  /** True when every processed page with controls had an entirely navigable
   * evaluation window; each window was examined with zero clicks. */
  evidenceControlsNavigableOnly?: boolean;
  /** True when a processed page had clickable controls but no recorded
   * progress, so the shared seed offset must not advance. */
  evidenceControlsUncertified?: boolean;
  /** Full-pool positions to advance the durable retry offset (see
   * BrowserFallbackTelemetry.evidenceControlsOffsetAdvance). */
  evidenceControlsOffsetAdvance?: number;
  /** True when any evidence-bearing control failed or was skipped: coverage
   * is incomplete even if every request succeeded. */
  interactionGap?: boolean;
  /** True when the required set grew after scroll/click interactions (links
   * revealed only after the initial snapshot). Diagnostic, never a gap by
   * itself: newly revealed links classify normally in required coverage. */
  requiredSnapshotExpanded?: boolean;
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

export const COMMUNITY_HINTS = /discord|community|join|chat|member|membership|vip|group|private|trading.?room|links?|social|contact|about|whop|skool|circle|patreon|premium|paid|subscribe|signals?|mentor|access/i;

/**
 * Interactive controls that can reveal content only through interaction:
 * links, buttons, ARIA buttons/tabs, native disclosures (`summary`), and
 * collapsed accordion triggers. The selector is shared by enumeration and
 * clicking so locator indexes always refer to the same full query.
 */
export const RENDERED_CONTROL_SELECTOR = 'a,button,[role="button"],[role="tab"],summary,[aria-expanded="false"]';

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
 * A click that commits a new document can expose frames or shadow roots that
 * only that click saw. Count its context only when the destination is not
 * admitted as its own request (which samples it separately) and was not
 * already inspected by an earlier request (which already counted it).
 */
export function shouldSampleClickDestinationContext(input: {
  destinationKey: string | null;
  admittedKeys: ReadonlySet<string>;
  visitedKeys: ReadonlySet<string>;
}): boolean {
  if (!input.destinationKey) return false;
  return !input.admittedKeys.has(input.destinationKey)
    && !input.visitedKeys.has(input.destinationKey);
}

/**
 * Normalized identity for visit-set matching (shared-evidence registry and
 * already-visited exclusion): scheme + lowercased host + non-default port +
 * pathname (trailing slash trimmed) + verbatim query. Same rule both sides
 * so independently recorded URLs meet on one key. Null when unparsable.
 *
 * Re-exported from visitUrl so the static terminal-not-found barrier cannot
 * drift from the rendered crawler's identity rule.
 */
export { normalizeVisitUrl } from './visitUrl';

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
  /** Stable per-element marker assigned at enumeration. Positional indexes
   * become stale when an earlier click expands/collapses the DOM. */
  marker?: string;
  text: string;
  href: string | null;
  /**
   * Control kind for bounded click-failure aggregates (anchor/button/role).
   * Set at enumeration from the element tag name; optional for backward
   * compatibility with rows predating instrumentation (counted as 'role').
   * Never a selector or payload.
   */
  tag?: 'anchor' | 'button' | 'role';
  /**
   * True when this matched control is a popup/disclosure that requires
   * capture rather than navigation. Lets the caller exclude successfully
   * examined popups from the unexamined-context count. Never serialized.
   */
  popup?: boolean;
}

export interface RenderedControlEnumeration {
  /** Evidence-bearing controls (the existing community-hint matched set). */
  controls: RenderedControlTarget[];
  /** Pre-filter denominator: every node matched by the shared selector. */
  total: number;
  /** Nodes excluded by the community-hint filter (total - controls). */
  hintRejected: number;
  /** Menu/nav/hamburger/aria-haspopup/role=menuitem controls, matched or not. */
  structuralNavigation: number;
  /** Structural controls the hint filter would hide (P1.1 measurement). */
  structuralHintRejected: number;
  /** Controls recoverable only via title/aria-labelledby/alt/data-label (P1.2). */
  iconLabelRecovered: number;
  /**
   * Popup/dialog controls that require capture rather than navigation
   * (P1.3 measurement). A `target=_blank` anchor with a real href is already
   * reachable by enqueueing that href and is not counted here; only
   * `aria-haspopup=dialog|menu` and href-less `_blank` controls are.
   */
  popupTargets: number;
  /**
   * Stable markers for every popup control, including hint-rejected popups
   * that are absent from `controls`. Identity tracking uses these markers so
   * a replacement popup cannot be cancelled by an earlier popup's click.
   */
  popupMarkers: string[];
}

/**
 * Coverage-gap observations are monotonic across re-enumerations. A later
 * snapshot can be smaller (a clicked community button is replaced by a menu
 * trigger) yet reveal a structural/icon control the first snapshot did not
 * contain. Max each gap counter independently of the denominator snapshot, so
 * a new gap can never be discarded for being in a smaller control set.
 */
export function mergeRenderedCoverageGapCounters(
  prior: Pick<RenderedControlEnumeration, 'structuralNavigation' | 'structuralHintRejected' | 'iconLabelRecovered'>,
  next: Pick<RenderedControlEnumeration, 'structuralNavigation' | 'structuralHintRejected' | 'iconLabelRecovered'>,
): Pick<RenderedControlEnumeration, 'structuralNavigation' | 'structuralHintRejected' | 'iconLabelRecovered'> {
  return {
    structuralNavigation: Math.max(prior.structuralNavigation, next.structuralNavigation),
    structuralHintRejected: Math.max(prior.structuralHintRejected, next.structuralHintRejected),
    iconLabelRecovered: Math.max(prior.iconLabelRecovered, next.iconLabelRecovered),
  };
}

export interface RenderedRequestControlTotals {
  enumerated: number;
  hintRejected: number;
  structuralNavigation: number;
  structuralHintRejected: number;
  iconLabelRecovered: number;
  popupCount: number;
  frameCount: number;
  shadowRootCount: number;
  baseHrefPresent: boolean;
}

/**
 * Difference between two attempts of the same request. Crawlee retries a
 * thrown request with fresh page-local counters, so the crawl totals must add
 * only the delta from the latest attempt instead of the whole attempt again.
 */
export function renderedRequestControlTotalsDelta(
  previous: RenderedRequestControlTotals | undefined,
  current: RenderedRequestControlTotals,
): Omit<RenderedRequestControlTotals, 'baseHrefPresent'> {
  return {
    enumerated: current.enumerated - (previous?.enumerated || 0),
    hintRejected: current.hintRejected - (previous?.hintRejected || 0),
    structuralNavigation: current.structuralNavigation - (previous?.structuralNavigation || 0),
    structuralHintRejected: current.structuralHintRejected - (previous?.structuralHintRejected || 0),
    iconLabelRecovered: current.iconLabelRecovered - (previous?.iconLabelRecovered || 0),
    popupCount: current.popupCount - (previous?.popupCount || 0),
    frameCount: current.frameCount - (previous?.frameCount || 0),
    shadowRootCount: current.shadowRootCount - (previous?.shadowRootCount || 0),
  };
}

/**
 * Popup coverage is identity-based, not count-based. A popup that is clicked
 * inline has been examined; a popup that opened a new window has not. Tracking
 * the stable marker of every observed popup, including hint-rejected ones,
 * means a replacement cannot be cancelled out by an earlier popup's click, and
 * re-observing the same popup during scrolling does not inflate the count.
 */
export function trackRenderedPopupCoverage(
  prior: ReadonlySet<string>,
  enumeration: Pick<RenderedControlEnumeration, 'popupMarkers'>,
): Set<string> {
  const observedMarkers = new Set(prior);
  for (const marker of enumeration.popupMarkers) observedMarkers.add(marker);
  return observedMarkers;
}

/**
 * Popups observed by an enumeration but never examined by the click loop.
 * Only a successfully clicked inline disclosure removes a marker; a popup
 * that opened a new window remains unexamined, and hint-rejected popups are
 * always unexamined because they are never clicked.
 */
export function resolveUnexaminedPopupTargets(
  observedMarkers: ReadonlySet<string>,
  examinedMarkers: ReadonlySet<string>,
): number {
  let unexamined = 0;
  for (const marker of observedMarkers) {
    if (!examinedMarkers.has(marker)) unexamined++;
  }
  return unexamined;
}

/**
 * Browser-context enumeration shared by production and the real-DOM fixture.
 * It must stay self-contained: Playwright serializes this function into the
 * page, so it may only reference its arguments and browser globals. It returns
 * the complete matched set (never a prefix slice) so the caller can rotate the
 * full pool by the durable retry offset before applying the evaluation window.
 *
 * P0.2 is measurement-only: `controls` still uses the original innerText +
 * href + aria-label match, so behavior is unchanged. Structural/icon-label
 * counts tell us what P1.1/P1.2 would recover without enabling them yet.
 */
export function enumerateRenderedControlNodes(
  nodes: Element[],
  pattern: string,
): RenderedControlEnumeration {
  const re = new RegExp(pattern, 'i');
  const matched: RenderedControlTarget[] = [];
  let structuralNavigation = 0;
  let structuralHintRejected = 0;
  let iconLabelRecovered = 0;
  let popupTargets = 0;
  const popupIndices: number[] = [];
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    const element = node as HTMLElement;
    const tagName = (element.tagName || '').toLowerCase();
    // HTMLAnchorElement.href is a string; SVGElement.href is an
    // SVGAnimatedString. Reading the attribute keeps both anchor kinds
    // string-safe, and resolving against the document base preserves the
    // absolute-href semantics the click planner expects.
    //
    // Keep this inline: Playwright serializes this function into the page.
    // A named inner function (for example `const hrefOf = ...`) is rewritten
    // by esbuild's keepNames transform into `__name(...)`, which is not
    // defined in the browser context and would fail the whole enumeration.
    const property = (node as HTMLAnchorElement).href;
    let href: string | null = null;
    if (typeof property === 'string' && property) {
      href = property;
    } else {
      const raw = node.getAttribute('href')
        || node.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
        || '';
      if (raw) {
        try {
          href = new URL(raw, node.baseURI || document.baseURI).toString();
        } catch {
          href = raw;
        }
      }
    }
    const ariaLabel = element.getAttribute('aria-label') || '';
    const baseText = `${element.innerText || ''} ${href || ''} ${ariaLabel}`;
    // P1.2 measurement: resolve the labels that the original filter ignores.
    let labelledByText = '';
    const labelledBy = element.getAttribute('aria-labelledby') || '';
    if (labelledBy) {
      // Bounded label recovery: a hostile page can name thousands of
      // references or point at a huge element. Extract at most 16 id tokens
      // without splitting the whole attribute, then walk at most 512 text
      // nodes while collecting at most 200 characters, so neither the id list
      // nor a referenced subtree is materialized in full.
      let scanIndex = 0;
      let idCount = 0;
      let visitedLabelNodes = 0;
      while (scanIndex < labelledBy.length && idCount < 16) {
        while (scanIndex < labelledBy.length && /\s/.test(labelledBy.charAt(scanIndex))) scanIndex++;
        const idStart = scanIndex;
        while (scanIndex < labelledBy.length && !/\s/.test(labelledBy.charAt(scanIndex))) scanIndex++;
        if (scanIndex === idStart) break;
        idCount++;
        if (labelledByText.length >= 200) continue;
        const labelNode = document.getElementById(labelledBy.slice(idStart, scanIndex));
        if (!labelNode) continue;
        const walker = document.createTreeWalker(labelNode, NodeFilter.SHOW_TEXT);
        // Join text nodes inside one referenced element exactly as
        // textContent did; an injected per-node separator would split a word
        // such as `Dis<strong>cord</strong>`. A separator is added once per
        // referenced label so two short labels do not merge into one word.
        let pendingSeparator = labelledByText.length > 0 ? ' ' : '';
        while (visitedLabelNodes < 512 && labelledByText.length < 200) {
          const textNode = walker.nextNode();
          if (!textNode) break;
          visitedLabelNodes++;
          const text = textNode.nodeValue || '';
          const remaining = 200 - labelledByText.length - pendingSeparator.length;
          if (text && remaining > 0) {
            labelledByText += pendingSeparator + (text.length > remaining ? text.slice(0, remaining) : text);
            pendingSeparator = '';
          }
        }
      }
    }
    let childAlt = '';
    const image = element.querySelector('img[alt]');
    if (image) childAlt = image.getAttribute('alt') || '';
    const title = element.getAttribute('title') || '';
    const dataLabel = element.getAttribute('data-label') || '';
    const extendedText = `${baseText} ${title} ${labelledByText} ${childAlt} ${dataLabel}`;
    const baseMatched = re.test(baseText);
    const extendedMatched = re.test(extendedText);
    const role = (element.getAttribute('role') || '').toLowerCase();
    const ariaHaspopup = (element.getAttribute('aria-haspopup') || '').trim().toLowerCase();
    // Only the control's own visible label and aria-label may classify it as
    // navigation. Including the resolved href made ordinary `/support`,
    // `/resources`, or `/more` destinations structural; title and
    // aria-labelledby can describe external content (a section heading, a
    // tooltip) rather than this control, so they stay in `extendedText` for
    // icon-label recovery only.
    const labelText = `${element.innerText || ''} ${ariaLabel}`;
    // HTTP(S) is the only destination the enqueue path can follow. A
    // `javascript:` or other scheme is click-only and must not make a
    // `target=_blank` control look like a normal navigable link.
    const hasNavigableHref = typeof href === 'string' && /^https?:\/\//i.test(href);
    // A control inside a real navigation/menu container is navigation even
    // when its own label is generic (`Products`). The container itself is not
    // in the click selector, so inspect ancestors on the enumerated control.
    const inNavigationContainer = !!element.closest(
      'nav,[role="navigation"],[role="menu"],[role="menubar"]',
    );
    // `aria-expanded` on a normal href-bearing link is an attribute of content
    // navigation, not a disclosure trigger; a href-less link (or a real
    // button/summary) is an interactive surface whose contents stay hidden.
    const disclosure = tagName === 'summary'
      || (element.hasAttribute('aria-expanded') && (tagName !== 'a' || !hasNavigableHref));
    const target = (element.getAttribute('target') || '').trim().toLowerCase();
    // Menu-like labels only. Generic footer/company/about links are not
    // structural navigation and would make nearly every crawl look
    // policy-bounded. Title/aria-labelledby are included only for this
    // menu-shaped test: an icon-only "Main menu" button outside a navigation
    // container is a real coverage gap even though it is not clicked, while
    // generic title text must not classify ordinary controls.
    const menuLikeLabel = /\b(menu|navigation|nav|hamburger)\b/i;
    const structural = tagName === 'nav'
      || role === 'menu'
      || role === 'menubar'
      || role === 'menuitem'
      || role === 'navigation'
      || (ariaHaspopup !== '' && ariaHaspopup !== 'false')
      || disclosure
      || inNavigationContainer
      || menuLikeLabel.test(labelText)
      || menuLikeLabel.test(`${title} ${labelledByText}`);
    const isPopup = (ariaHaspopup !== '' && ariaHaspopup !== 'false')
      || (target === '_blank' && !hasNavigableHref);
    if (structural) {
      structuralNavigation++;
      if (!baseMatched) structuralHintRejected++;
    }
    if (!baseMatched && extendedMatched) iconLabelRecovered++;
    // Only popups that cannot be followed as a normal navigation are a
    // coverage gap. A `target=_blank` anchor with a real href is already
    // reachable through that href; counting it would mark nearly every
    // social link as an unexamined popup.
    if (isPopup) {
      popupTargets++;
      // Hint-rejected popups still need a stable identity for coverage
      // accounting; they are marked below but never enter the click set.
      popupIndices.push(index);
    }
    if (!baseMatched) continue;
    matched.push({
      index,
      text: baseText,
      href,
      tag: (tagName === 'a' ? 'anchor' : tagName === 'button' ? 'button' : 'role') as 'anchor' | 'button' | 'role',
      ...(isPopup ? { popup: true } : {}),
    });
  }
  const usedMarkers = new Set<string>();
  const controls: RenderedControlTarget[] = [];
  const markerByIndex = new Map<number, string>();
  for (let itemIndex = 0; itemIndex < matched.length; itemIndex++) {
    const item = matched[itemIndex];
    const node = nodes[item.index] as HTMLElement;
    const existing = node.getAttribute('data-oc-control');
    let marker = existing || `oc-${Date.now().toString(36)}-${item.index}-${Math.random().toString(36).slice(2, 8)}`;
    let attempt = 0;
    // A page can repeat an existing marker across controls. Reusing it would
    // make every duplicate target resolve to the first element, leaving the
    // others unexamined; assign a unique marker instead.
    while (usedMarkers.has(marker)) {
      attempt += 1;
      marker = `oc-${Date.now().toString(36)}-${item.index}-${attempt}-${Math.random().toString(36).slice(2, 8)}`;
    }
    usedMarkers.add(marker);
    if (existing !== marker) node.setAttribute('data-oc-control', marker);
    markerByIndex.set(item.index, marker);
    controls.push({ ...item, marker });
  }
  const popupMarkers: string[] = [];
  for (let popupIndex = 0; popupIndex < popupIndices.length; popupIndex++) {
    const index = popupIndices[popupIndex];
    const matchedMarker = markerByIndex.get(index);
    if (matchedMarker) {
      popupMarkers.push(matchedMarker);
      continue;
    }
    const node = nodes[index] as HTMLElement;
    const existing = node.getAttribute('data-oc-control');
    let marker = existing || `oc-popup-${Date.now().toString(36)}-${index}-${Math.random().toString(36).slice(2, 8)}`;
    let attempt = 0;
    while (usedMarkers.has(marker)) {
      attempt += 1;
      marker = `oc-popup-${Date.now().toString(36)}-${index}-${attempt}-${Math.random().toString(36).slice(2, 8)}`;
    }
    usedMarkers.add(marker);
    if (existing !== marker) node.setAttribute('data-oc-control', marker);
    popupMarkers.push(marker);
  }
  return {
    controls,
    total: nodes.length,
    hintRejected: Math.max(0, nodes.length - controls.length),
    structuralNavigation,
    structuralHintRejected,
    iconLabelRecovered,
    popupTargets,
    popupMarkers,
  };
}

export interface RenderedPageContextCounts {
  frameCount: number;
  shadowRootCount: number;
  baseHrefPresent: boolean;
  /** Document identity (`performance.timeOrigin`) used only to tell a
   * same-document URL update from a real navigation; never persisted. */
  documentTimeOrigin?: number | null;
}

/**
 * Browser-context page counters for P0.2/P1.3-P1.5. Self-contained because
 * Playwright serializes it into the page. Bounded so a pathological DOM cannot
 * turn telemetry collection into an unbounded scan.
 */
export function collectRenderedPageContext(): RenderedPageContextCounts {
  // Live HTMLCollections avoid materializing every frame element before the
  // cap is applied; a pathological document must not tokenize its whole DOM
  // just to count a bounded handful of embeds.
  let frameCount = 0;
  const frameTags = ['iframe', 'frame', 'object', 'embed'];
  for (let tagIndex = 0; tagIndex < frameTags.length; tagIndex++) {
    frameCount += document.getElementsByTagName(frameTags[tagIndex]).length;
    if (frameCount >= 1000) { frameCount = 1000; break; }
  }
  let shadowRootCount = 0;
  // TreeWalker keeps the scan bounded without materializing every element in
  // a huge document. Only light-DOM hosts are visited; open shadow roots are
  // counted, not traversed (P1.4 owns traversal).
  const root = document.body || document.documentElement;
  if (root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let examined = 0;
    let node = walker.nextNode();
    while (node && examined < 2000 && shadowRootCount < 100) {
      examined++;
      if ((node as HTMLElement).shadowRoot) shadowRootCount++;
      node = walker.nextNode();
    }
  }
  const timeOrigin = typeof performance !== 'undefined' && Number.isFinite(performance.timeOrigin)
    ? performance.timeOrigin
    : null;
  return {
    frameCount,
    shadowRootCount,
    baseHrefPresent: !!document.querySelector('base[href]'),
    documentTimeOrigin: timeOrigin,
  };
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

/** Bounded evaluation window over the complete matched-control set. The window
 * is rotated by the durable retry offset before the per-page click cap, so a
 * retry can reach controls beyond the first 64 instead of re-examining the
 * same prefix forever. */
export const RENDERED_CONTROL_EVALUATION_WINDOW = 64;

export function partitionRenderedClickTargets(
  controls: RenderedControlTarget[],
  pageUrl: string,
  maxClicks: number,
  offset = 0,
  evaluationWindowSize = RENDERED_CONTROL_EVALUATION_WINDOW,
): { toClick: RenderedControlTarget[]; skippedNavigableAnchors: number; evaluationWindow: RenderedControlTarget[] } {
  const cap = Math.max(0, Math.trunc(maxClicks) || 0);
  const windowSize = Math.max(0, Math.trunc(evaluationWindowSize) || 0);
  // Rotate the complete matched pool before applying the evaluation window.
  // Rotating the already-truncated plan would only reorder the same prefix and
  // leave controls 65+ permanently unreachable.
  const rawOffset = Math.trunc(offset) || 0;
  const start = controls.length > 0
    ? ((rawOffset % controls.length) + controls.length) % controls.length
    : 0;
  const rotated = start > 0 ? [...controls.slice(start), ...controls.slice(0, start)] : controls;
  const evaluationWindow = rotated.slice(0, windowSize);
  const eligible: RenderedControlTarget[] = [];
  let skippedNavigableAnchors = 0;
  for (const control of evaluationWindow) {
    if (isSkippableNavigableAnchorClick(control, pageUrl)) {
      skippedNavigableAnchors++;
      continue;
    }
    eligible.push(control);
  }
  return { toClick: eligible.slice(0, cap), skippedNavigableAnchors, evaluationWindow };
}

/**
 * A processed page whose entire evaluation window is navigable anchors has
 * zero click targets but was fully examined. The durable retry offset may
 * advance past it. A zero-click window caused by a deadline, crash, or zero
 * click budget is not certified and must be retried unchanged.
 */
export function isNavigableOnlyControlWindow(
  plan: Pick<ReturnType<typeof partitionRenderedClickTargets>, 'toClick' | 'evaluationWindow' | 'skippedNavigableAnchors'>,
  maxClicksPerPage: number,
): boolean {
  return maxClicksPerPage > 0
    && plan.toClick.length === 0
    && plan.evaluationWindow.length > 0
    && plan.skippedNavigableAnchors === plan.evaluationWindow.length;
}

/**
 * Full-pool positions the durable retry offset should advance after a page.
 * The offset indexes the complete matched-control pool, so advancing by the
 * raw click count can land back on the same clickable control when navigable
 * anchors precede it (4 anchors + 8 buttons: both attempts would click buttons
 * 1-4). Advance just past the last attempted control instead. A fully examined
 * all-navigable window advances by its window length; an uncertified
 * zero-click window (deadline/crash/zero budget) does not advance.
 *
 * A failed click is not examined coverage: when `firstFailedAttempt` is set,
 * progress stops before that control so the next retry can attempt it again.
 * Advancing by clicked+failed would rotate the shared offset past a control
 * whose revealed content was never observed.
 *
 * The one exception is a failure on the very first attempted control: stopping
 * at position zero would freeze every retry on the same window, so a disabled
 * or hidden first control would permanently block every later control. In
 * that case the attempted window counts as progress; the failed control stays
 * an interaction gap and is revisited when the pool rotates back around.
 */
export function renderedClickOffsetAdvance(
  plan: Pick<ReturnType<typeof partitionRenderedClickTargets>, 'toClick' | 'evaluationWindow' | 'skippedNavigableAnchors'>,
  attempts: number,
  maxClicksPerPage: number,
  firstFailedAttempt?: number,
): number {
  const attempted = Math.max(0, Math.trunc(attempts) || 0);
  const failedAt = firstFailedAttempt === undefined
    ? undefined
    : Math.max(0, Math.trunc(firstFailedAttempt) || 0);
  // A failure at the head of the window must not freeze the rotation: no
  // later control would ever be reached. Treat the attempted window as
  // progress and let the failed control return when the pool wraps.
  const examined = failedAt === undefined
    ? attempted
    : failedAt === 0
      ? attempted
      : Math.min(attempted, failedAt);
  if (examined === 0) {
    return isNavigableOnlyControlWindow(plan, maxClicksPerPage) ? plan.evaluationWindow.length : 0;
  }
  const lastAttempted = plan.toClick[Math.min(examined, plan.toClick.length) - 1];
  if (!lastAttempted) return 0;
  const position = plan.evaluationWindow.findIndex(target =>
    target === lastAttempted || (Boolean(target.marker) && target.marker === lastAttempted.marker)
  );
  return position >= 0 ? position + 1 : 0;
}

/**
 * Combine per-page full-pool advances into one safe shared seed advance.
 * Every page in a rendered crawl starts from the same durable per-seed
 * rotation offset, so the crawl may advance only by the smallest progress any
 * page made: advancing by the largest would rotate a smaller (or equal) page
 * pool past controls it never examined. A zero page advance contributes no
 * progress; the caller separately marks an unexamined clickable window as
 * uncertified so the whole seed stays put.
 */
export function combineRenderedControlOffsetAdvances(
  current: number | undefined,
  pageAdvance: number,
): number | undefined {
  const advance = Math.max(0, Math.trunc(pageAdvance) || 0);
  if (advance === 0) return current;
  return current === undefined || current <= 0 ? advance : Math.min(current, advance);
}

/**
 * Click slots still available after reserving the controls already queued but
 * not yet attempted. Freshly revealed controls must not be appended beyond the
 * per-page cap: the loop stops at that cap, so an over-queued control would be
 * neither clicked nor counted as a coverage gap.
 */
export function remainingRenderedClickBudget(
  maxClicks: number,
  clickedThisPage: number,
  pendingQueuedTargets: number,
): number {
  const cap = Math.max(0, Math.trunc(maxClicks) || 0);
  const clicked = Math.max(0, Math.trunc(clickedThisPage) || 0);
  const pending = Math.max(0, Math.trunc(pendingQueuedTargets) || 0);
  return Math.max(0, cap - clicked - pending);
}

/**
 * Plan the controls discovered by re-enumeration after a click. Controls that
 * do not fit the truly remaining budget are returned as skipped coverage
 * obligations, while navigable anchors stay enqueue-handled and are not
 * counted as click skips. This is also used after the final permitted click,
 * when the remaining budget is zero but its disclosures still need accounting.
 */
export function planRevealedRenderedClickTargets(
  controls: RenderedControlTarget[],
  pageUrl: string,
  maxClicks: number,
  clickedThisPage: number,
  pendingQueuedTargets: number,
  offset = 0,
): { toClick: RenderedControlTarget[]; skipped: RenderedControlTarget[]; remainingClickBudget: number } {
  const remainingClickBudget = remainingRenderedClickBudget(maxClicks, clickedThisPage, pendingQueuedTargets);
  const plan = partitionRenderedClickTargets(controls, pageUrl, remainingClickBudget, offset);
  const plannedMarkers = new Set(
    plan.toClick
      .map(target => target.marker)
      .filter((marker): marker is string => Boolean(marker)),
  );
  // Only controls inside this attempt's evaluation window are click-skip
  // obligations. Controls outside the window are overflow already counted by
  // the enumeration certificate; returning them here would double-count them.
  const skipped = plan.evaluationWindow.filter(target => {
    const marker = target.marker;
    return typeof marker === 'string'
      && marker.length > 0
      && !plannedMarkers.has(marker)
      && !isSkippableNavigableAnchorClick(target, pageUrl);
  });
  return { toClick: plan.toClick, skipped, remainingClickBudget };
}

export interface RenderedClickLoopInput {
  targets: RenderedControlTarget[];
  maxClicksPerPage: number;
  deadlineExceeded: () => boolean;
  click: (target: RenderedControlTarget) => Promise<boolean>;
  enumerate: () => Promise<RenderedControlEnumeration>;
  pageUrl: () => string;
  /** Durable per-seed retry rotation, shared with the initial click plan so a
   * retry does not repeatedly select the same DOM-order subset of controls
   * revealed by a previous click. */
  clickOffset?: number;
  /** Markers already accounted as skipped by the initial plan. Mutated so
   * re-enumerations cannot double-count them. */
  countedSkips?: Set<string>;
  onEnumerated?: (enumeration: RenderedControlEnumeration) => void;
}

export interface RenderedClickLoopResult {
  evidenceControlsClicked: number;
  evidenceControlsFailed: number;
  evidenceControlsSkipped: number;
  interactionGap: boolean;
  /** Index (in the click-target queue) of the first control whose click
   * failed. The durable retry offset must stop at that control, never rotate
   * past it, because its revealed content was not examined. */
  firstFailedTargetIndex?: number;
}

/**
 * Execute the bounded click pass and its post-click re-enumerations. Extracted
 * from the request handler so final-click disclosures, queued-slot
 * reservation, retry rotation, and failure accounting are exercised as
 * behavior rather than only through source-text assertions.
 */
export async function runRenderedClickLoop(input: RenderedClickLoopInput): Promise<RenderedClickLoopResult> {
  const clickTargets = [...input.targets];
  const queuedMarkers = new Set(
    clickTargets
      .map(target => target.marker)
      .filter((marker): marker is string => Boolean(marker)),
  );
  const countedSkips = input.countedSkips ?? new Set<string>();
  let clickedThisPage = 0;
  let evidenceControlsClicked = 0;
  let evidenceControlsFailed = 0;
  let evidenceControlsSkipped = 0;
  let interactionGap = false;
  let firstFailedTargetIndex: number | undefined;
  for (let clickIndex = 0; clickIndex < clickTargets.length; clickIndex++) {
    if (clickedThisPage >= input.maxClicksPerPage) {
      // Controls appended by an earlier re-enumeration can remain queued when
      // the click cap is reached. They were never examined, so they are skips,
      // not a clean no-match.
      let cappedSkips = 0;
      for (const target of clickTargets.slice(clickIndex)) {
        const marker = target.marker;
        if (marker && countedSkips.has(marker)) continue;
        if (marker) countedSkips.add(marker);
        cappedSkips++;
      }
      if (cappedSkips > 0) {
        evidenceControlsSkipped += cappedSkips;
        interactionGap = true;
      }
      break;
    }
    if (input.deadlineExceeded()) {
      evidenceControlsSkipped += clickTargets.length - clickIndex;
      interactionGap = true;
      break;
    }
    const control = clickTargets[clickIndex];
    clickedThisPage++;
    if (await input.click(control)) evidenceControlsClicked++;
    else {
      evidenceControlsFailed++;
      interactionGap = true;
      if (firstFailedTargetIndex === undefined) firstFailedTargetIndex = clickIndex;
    }
    // A successful click can reveal new evidence-bearing controls (second
    // interaction). Re-enumerate after every click, including the final
    // allowed one: controls revealed by the last click are still unexamined,
    // and the later link pass cannot click them. Reserve slots for controls
    // already queued but not yet attempted so the refreshed plan can never
    // overrun the cap.
    if (!input.deadlineExceeded()) {
      try {
        const refreshed = await input.enumerate();
        input.onEnumerated?.(refreshed);
        const unqueued = refreshed.controls.filter(target => target.marker && !queuedMarkers.has(target.marker));
        const pendingQueuedTargets = Math.max(0, clickTargets.length - clickIndex - 1);
        const freshPlan = planRevealedRenderedClickTargets(
          unqueued,
          input.pageUrl(),
          input.maxClicksPerPage,
          clickedThisPage,
          pendingQueuedTargets,
          input.clickOffset,
        );
        // Newly revealed controls that do not fit the remaining click budget
        // were never examined. Count only genuinely new skips (initial
        // overflow/slice drops are already counted) and make the interaction
        // gap explicit so the page cannot resolve as a clean no-match.
        let freshDropped = 0;
        for (const target of freshPlan.skipped) {
          if (!target.marker || countedSkips.has(target.marker)) continue;
          countedSkips.add(target.marker);
          freshDropped++;
        }
        if (freshDropped > 0) {
          evidenceControlsSkipped += freshDropped;
          interactionGap = true;
        }
        for (const target of freshPlan.toClick) {
          if (!target.marker || queuedMarkers.has(target.marker)) continue;
          queuedMarkers.add(target.marker);
          clickTargets.push(target);
        }
      } catch {
        // The click may have revealed controls that cannot be enumerated.
        // Fail closed instead of claiming coverage that was never examined.
        interactionGap = true;
      }
    }
  }
  return { evidenceControlsClicked, evidenceControlsFailed, evidenceControlsSkipped, interactionGap, firstFailedTargetIndex };
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
  /**
   * Evidence-bearing interaction gap: a control that could reveal community
   * content failed or was skipped by the click/control budget. An invite can
   * live behind an unexecuted click, so the run is not complete coverage and
   * must stay retryable rather than resolving as a clean absence.
   */
  interactionGap?: boolean;
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
  // Click failures and skipped evidence-bearing controls stay incomplete:
  // interaction-gated content is acquisition evidence, not opportunistic
  // traversal, once a control matches the community-evidence filter.
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
  const interactionIncomplete = input.interactionGap === true;
  const incomplete = !processed || input.timedOut || terminalFailures > 0 || failedWithNoPages || pageBudgetCutoff || interactionIncomplete;
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

  async run<T>(operation: (admittedAtMs: number) => Promise<T>): Promise<T> {
    const release = await this.acquire();
    // Admission is timestamped here so callers can start budget clocks at the
    // moment the gate slot was granted, even if they serialize internally
    // afterwards (see withRenderedQueueLifecycleLock).
    try { return await operation(Date.now()); } finally { release(); }
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

/** Minimal Playwright route shape used by the rendered guard. Keeping this
 * structural makes the lifecycle testable without importing Playwright or
 * requiring a browser launch, while remaining assignment-compatible with
 * Playwright's Route type. */
export interface RenderedRouteLike {
  request(): { url(): string; resourceType(): string };
  abort(errorCode?: string): Promise<void>;
  continue(): Promise<void>;
}

/** Minimal context shape needed by the rendered route guard. */
export interface RenderedRouteContextLike {
  unrouteAll(options?: { behavior?: 'default' | 'wait' | 'ignoreErrors' }): Promise<void>;
}

interface RenderedRouteGuardOptions {
  /** Same public-destination check used by the crawl. A rejection is treated
   * as "not allowed" by the caller and therefore fails closed. */
  isAllowed(rawUrl: string): Promise<boolean>;
  /** Called only when the destination policy rejects a network request. */
  onBlocked(): void;
  /** Optional safe sink for unexpected route failures. It must not throw and
   * is never called for expected shutdown races. */
  onUnexpectedRouteError?(error: unknown): void;
}

export interface RenderedRouteGuard {
  handler(route: RenderedRouteLike): Promise<void>;
  /** Idempotent, best-effort removal of the context route. The `ignoreErrors`
   * behavior tells Playwright to ignore route callbacks that are still in
   * flight when the context is closed; it deliberately does not wait for
   * them, so shutdown cannot hang on a slow DNS preflight. */
  dispose(): Promise<void>;
}

const RENDERED_NON_NETWORK_RESOURCE_TYPES = new Set(['image', 'media', 'font']);

function renderedRouteErrorText(error: unknown, seen = new Set<unknown>()): string {
  if (error && typeof error === 'object') {
    if (seen.has(error)) return '';
    seen.add(error);
    const value = error as { name?: unknown; message?: unknown; cause?: unknown };
    return `${String(value.name || '')} ${String(value.message || '')} ${renderedRouteErrorText(value.cause, seen)}`.toLowerCase();
  }
  return String(error || '').toLowerCase();
}

/**
 * Returns true only for lifecycle races in which Playwright already closed the
 * page/context/browser or completed the route. These are expected during
 * shutdown and must not be reported as routing/security failures. Other route
 * errors still follow the fail-closed path in the guard.
 */
export function isExpectedRenderedRouteShutdownError(error: unknown): boolean {
  const text = renderedRouteErrorText(error);
  return /targetclosed|target (page|context|browser).*closed|(page|context|browser) (has been|is|was) closed|route (is )?already handled|request (is )?already handled|session (has been|is) closed|connection (has been|is) closed/.test(text);
}

function reportUnexpectedRenderedRouteError(
  error: unknown,
  onUnexpectedRouteError: ((error: unknown) => void) | undefined,
): void {
  try {
    onUnexpectedRouteError?.(error);
  } catch {
    // Diagnostics must never break the route callback or reopen the request.
  }
}

async function settleRenderedRoute(
  route: RenderedRouteLike,
  action: 'abort' | 'continue',
  errorCode?: string,
  onUnexpectedRouteError?: (error: unknown) => void,
): Promise<void> {
  try {
    if (action === 'abort') {
      await route.abort(errorCode);
    } else {
      await route.continue();
    }
  } catch (error) {
    if (isExpectedRenderedRouteShutdownError(error)) return;
    reportUnexpectedRenderedRouteError(error, onUnexpectedRouteError);
    // The callback must never reject: Playwright reports a rejected route
    // callback as a process-level unhandled error. If continue failed for an
    // unrelated reason, fail closed instead of allowing the request through.
    if (action !== 'abort') {
      try {
        await route.abort('failed');
      } catch (abortError) {
        if (!isExpectedRenderedRouteShutdownError(abortError)) {
          reportUnexpectedRenderedRouteError(abortError, onUnexpectedRouteError);
        }
        // The route is already unusable; there is no safe action left. Do
        // not rethrow from the callback and take down the crawler process.
      }
    }
  }
}

/**
 * Builds a context-wide route handler that enforces the rendered-tier public
 * destination check and survives context/browser shutdown.
 *
 * The handler is intentionally the only place that settles routes. It fails
 * closed on unexpected errors and treats target-closed/already-handled races
 * as benign. `dispose` is idempotent and safe to call repeatedly from browser
 * close hooks and the crawl finally.
 */
export function createRenderedRouteGuard(
  context: RenderedRouteContextLike,
  options: RenderedRouteGuardOptions,
): RenderedRouteGuard {
  let disposed = false;
  let disposePromise: Promise<void> | undefined;

  const handler = async (route: RenderedRouteLike): Promise<void> => {
    if (disposed) {
      await settleRenderedRoute(route, 'abort', 'failed', options.onUnexpectedRouteError);
      return;
    }
    let request: ReturnType<RenderedRouteLike['request']>;
    try {
      request = route.request();
    } catch (error) {
      // The classifier also matches generic resolver or socket-close text, so
      // it is only used to suppress noisy lookup reports here. Still attempt a
      // fail-closed abort; settleRenderedRoute treats an already-handled or
      // already-closed route as benign. A shutdown-looking error from the
      // destination check below is handled by the outer catch without a
      // classifier short-circuit.
      if (!isExpectedRenderedRouteShutdownError(error)) {
        reportUnexpectedRenderedRouteError(error, options.onUnexpectedRouteError);
      }
      await settleRenderedRoute(route, 'abort', 'failed', options.onUnexpectedRouteError);
      return;
    }
    try {
      if (RENDERED_NON_NETWORK_RESOURCE_TYPES.has(request.resourceType())) {
        await settleRenderedRoute(route, 'abort', undefined, options.onUnexpectedRouteError);
        return;
      }
      if (!(await options.isAllowed(request.url()))) {
        options.onBlocked();
        await settleRenderedRoute(route, 'abort', 'blockedbyclient', options.onUnexpectedRouteError);
        return;
      }
      await settleRenderedRoute(route, 'continue', undefined, options.onUnexpectedRouteError);
    } catch (error) {
      reportUnexpectedRenderedRouteError(error, options.onUnexpectedRouteError);
      // Unknown routing/security failures are never allowed to open the
      // request path or escape as an unhandled rejection. If the browser has
      // already gone away, settleRenderedRoute treats the abort rejection as
      // a benign shutdown race.
      await settleRenderedRoute(route, 'abort', 'failed', options.onUnexpectedRouteError);
    }
  };

  return {
    handler,
    dispose(): Promise<void> {
      if (!disposePromise) {
        disposed = true;
        disposePromise = (async () => {
          try {
            await context.unrouteAll({ behavior: 'ignoreErrors' });
          } catch {
            // Contexts can already be gone when a browser is retired. Cleanup
            // is best-effort and must not alter the crawl result or crash the
            // process; the handler remains fail-closed if the route survives.
          }
        })();
      }
      return disposePromise;
    },
  };
}

/** Dispose every context guard. Repeated calls are safe because each guard
 * memoizes its disposal promise. */
export async function disposeRenderedRouteGuards(guards: Iterable<RenderedRouteGuard>): Promise<void> {
  await Promise.all([...guards].map(guard => guard.dispose()));
}

/**
 * Installs a context/browser close wrapper that removes the route before the
 * target closes. Playwright does not expose a context-close hook, so wrapping
 * the object's close method is the lifecycle point that is guaranteed to run
 * for both browser-pool retirement and normal crawler teardown.
 *
 * The wrapper is installed once per target, preserves close arguments, and
 * runs cleanup even if the original close fails. Cleanup itself is idempotent.
 */
const renderedCloseCleanupTargets = new WeakSet<object>();

export function installRenderedRouteCloseCleanup<T extends { close(...args: any[]): Promise<void> }>(
  target: T,
  dispose: () => Promise<void>,
): void {
  if (renderedCloseCleanupTargets.has(target)) return;
  const originalClose = target.close.bind(target);
  let closePromise: Promise<void> | undefined;
  target.close = async (...args: any[]): Promise<void> => {
    if (!closePromise) {
      closePromise = (async () => {
        try {
          await dispose();
        } finally {
          await originalClose(...args);
        }
      })();
    }
    return closePromise;
  };
  renderedCloseCleanupTargets.add(target);
}

/** Expensive Tier-2 acquisition. Finding one invite no longer terminates the
 * rendered crawl: every invite visible within the bounded page/click budget is
 * retained so ownership can be decided after acquisition. */
export async function crawlRenderedCommunitySurface(seedUrl: string, budget: Partial<BrowserFallbackBudget> = {}): Promise<BrowserFallbackResult> {
  const limits = { ...DEFAULT_BROWSER_FALLBACK_BUDGET, ...budget };
  // The rendered tier is a separate network client (Chromium), not covered by
  // the pinned Node fetch. Never launch a browser for a seed that is already
  // non-public or whose DNS answer is private; fail closed and preserve the
  // reason for the caller. Confirmed non-public seeds are terminal; transient
  // DNS failures stay retryable. Static SSRF_BLOCKED seeds are also barred
  // from escalation before they reach this function.
  const seedDestination = await assessPublicDestination(seedUrl, limits.resolveHost);
  if (!seedDestination.allowed) {
    // A temporary resolver failure is not a confirmed private destination:
    // keep it retryable and do not label it SSRF_BLOCKED. Confirmed
    // non-public answers/addresses remain terminal.
    const dnsTransient = seedDestination.reason === 'DNS_TIMEOUT' || seedDestination.reason === 'DNS_RESOLUTION_FAILED';
    const confirmedNonPublic = seedDestination.reason === 'NON_PUBLIC_ADDRESS'
      || seedDestination.reason === 'NON_PUBLIC_RESOLVED_ADDRESS'
      || seedDestination.reason === 'NON_HTTP_SCHEME';
    return {
      foundInvite: null,
      inspectedPages: 0,
      scrolls: 0,
      clicks: 0,
      complete: false,
      retryable: dnsTransient,
      timedOut: seedDestination.reason === 'DNS_TIMEOUT',
      failureClass: confirmedNonPublic ? 'SSRF_BLOCKED' : undefined,
      detail: `Rendered acquisition blocked before browser launch: seed is not a public destination (${seedDestination.reason})${seedDestination.hostname ? `: ${seedDestination.hostname}` : ''}${dnsTransient ? '; temporary DNS failure, retryable' : ''}.`,
    };
  }
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
  // Interaction coverage certificate state (v3): evidence-bearing controls
  // seen/clicked/failed/skipped across processed pages, and whether the seed
  // required set grew after scroll/click interactions.
  let seedSnapshotUrl = '';
  let requiredSnapshotExpanded = false;
  let evidenceControlsSeen = 0;
  let evidenceControlsClicked = 0;
  let evidenceControlsFailed = 0;
  let evidenceControlsSkipped = 0;
  let evidenceControlsNavigableOnly = false;
  let evidenceControlsClickableWindow = false;
  let evidenceControlsUncertified = false;
  let evidenceControlsOffsetAdvance = 0;
  let interactionGap = false;
  // True when a page could not be measured because no trustworthy document
  // identity was available; the coverage reason must not claim COMPLETE.
  let contextMeasurementAbandoned = false;
  // P0.2 navigation-coverage counters. They are measurement-only: nothing in
  // this crawl reads them back into selection or outcome decisions.
  let controlsEnumeratedTotal = 0;
  let controlsHintRejected = 0;
  let controlsStructuralNavigation = 0;
  let controlsStructuralHintRejected = 0;
  let controlsIconLabelRecovered = 0;
  // Crawlee retries a thrown request with a fresh page and fresh page-local
  // counters. Keep the last attempt's contribution per request so a retry
  // replaces it instead of adding the same request to crawl totals twice.
  const pageControlTotalsByRequest = new Map<string, RenderedRequestControlTotals>();
  // Scroll-cap growth is an observation of one attempt, not of the request
  // forever: a successful retry that scrolls to a stable page must clear a
  // flag left by an earlier capped attempt. The crawl-wide boolean is derived
  // from the latest attempt per request when telemetry is published.
  const pageScrollCapByRequest = new Map<string, boolean>();
  // URLs admitted for enqueue are inspected by their own request, so a click
  // that lands on one must not also count its context here.
  const admittedEnqueueKeys = new Set<string>();
  let popupTargets = 0;
  let frameCount = 0;
  let shadowRootCount = 0;
  let baseHrefPresent = false;
  let scrollCapReachedStillGrowing = false;
  // True while a page with clickable controls has not yet recorded its
  // progress. A throw in that window must leave the seed uncertified: the
  // catch path otherwise loses the per-page guard and the retry offset moves
  // past controls that were never examined.
  let pageClickWindowPending = false;
  // Uncertified click windows are tracked per request. Crawlee retries a
  // thrown attempt with a fresh page, and that retry re-examines the same
  // request from scratch; clearing its mark on entry keeps a recovered retry
  // from blocking the offset forever, while another page's unexamined window
  // still blocks shared progress.
  const uncertifiedRequestKeys = new Set<string>();
  // nextRenderedClickOffsets reads only outcome.telemetry, so the certificate
  // must be published there on every return path (success and catch).
  const publishEvidenceControlCertificate = (budgetExhausted = false): void => {
    // Derive crawl-wide context flags from each request's latest attempt so a
    // successful retry replaces a stale capped/base-href observation instead
    // of inheriting it from a failed attempt.
    baseHrefPresent = [...pageControlTotalsByRequest.values()].some(entry => entry.baseHrefPresent === true);
    scrollCapReachedStillGrowing = [...pageScrollCapByRequest.values()].some(Boolean);
    telemetry.evidenceControlsTotal = evidenceControlsSeen || undefined;
    telemetry.evidenceControlsClicked = evidenceControlsClicked || undefined;
    telemetry.evidenceControlsFailed = evidenceControlsFailed || undefined;
    telemetry.evidenceControlsSkipped = evidenceControlsSkipped || undefined;
    telemetry.evidenceControlsNavigableOnly = (evidenceControlsNavigableOnly && !evidenceControlsClickableWindow) || undefined;
    telemetry.evidenceControlsUncertified = (evidenceControlsUncertified || uncertifiedRequestKeys.size > 0) || undefined;
    telemetry.evidenceControlsOffsetAdvance = evidenceControlsOffsetAdvance || undefined;
    telemetry.controlsEnumeratedTotal = controlsEnumeratedTotal || undefined;
    telemetry.controlsHintRejected = controlsHintRejected || undefined;
    telemetry.controlsStructuralNavigation = controlsStructuralNavigation || undefined;
    telemetry.controlsStructuralHintRejected = controlsStructuralHintRejected || undefined;
    telemetry.controlsIconLabelRecovered = controlsIconLabelRecovered || undefined;
    telemetry.popupTargets = popupTargets || undefined;
    telemetry.frameCount = frameCount || undefined;
    telemetry.shadowRootCount = shadowRootCount || undefined;
    telemetry.baseHrefPresent = baseHrefPresent || undefined;
    telemetry.scrollCapReachedStillGrowing = scrollCapReachedStillGrowing || undefined;
    const dropSnapshot = drops.snapshot();
    const excluded: Partial<Record<NavigationPolicyExclusionReason, number>> = {};
    for (const reason of NAVIGATION_POLICY_EXCLUSION_REASONS) {
      const count = dropSnapshot[reason];
      if (count && count > 0) excluded[reason] = count;
    }
    telemetry.navigationPolicyExcluded = Object.keys(sanitizeNavigationPolicyExcluded(excluded)).length
      ? sanitizeNavigationPolicyExcluded(excluded)
      : undefined;
    telemetry.coverageReason = resolveRenderedCoverageReason({
      pagesInspected: inspectedPages,
      budgetExhausted,
      interactionGap,
      scrollCapReachedStillGrowing,
      contextUnknown: contextMeasurementAbandoned,
      structuralHintRejected: controlsStructuralHintRejected,
      iconLabelRecovered: controlsIconLabelRecovered,
      unresolvedFailedRequests: telemetry.unresolvedFailedRequests,
      frameCount,
      shadowRootCount,
      popupTargets,
      navigationPolicyExcluded: telemetry.navigationPolicyExcluded,
    });
  };
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
    return await renderedFallbackGate.run((gateAdmittedAtMs) => withRenderedQueueLifecycleLock(async () => {
      telemetry.lastLifecycleStage = advanceRenderedLifecycleStage(telemetry.lastLifecycleStage, 'GATE_ACQUIRED');
      // Total-budget clock: starts at gate admission, before the lifecycle
      // lock below, so a crawl admitted by a wider gate (env concurrency 2)
      // consumes budget while waiting behind a serialized predecessor instead
      // of occupying a gate slot with a fresh clock — the pre-lock semantics.
      const startedAt = gateAdmittedAtMs;
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
      let egressProxy: BrowserEgressProxy | undefined;
      const renderedRouteGuards = new Map<object, RenderedRouteGuard>();
      try {
        // Per-invocation isolated queue: never the process-default persisted
        // queue (see openIsolatedRenderedRequestQueue). Dropped in the finally
        // below on every path so named queues cannot accumulate.
        isolated = await openIsolatedRenderedRequestQueue((name) => RequestQueue.open(name));
        // The route checks below are only a preflight. Chromium resolves again
        // when it connects, so all browser traffic goes through a loopback
        // proxy that resolves once, rejects mixed/private answers, and pins
        // the selected address. This closes the connection-time rebinding gap
        // that a Playwright route handler cannot close.
        egressProxy = await startBrowserEgressProxy();
        // Chromium resolves independently of the pinned Node fetch. Check every
        // HTTP(S) navigation/subrequest against the same public-destination
        // policy before it leaves the browser. There is deliberately no
        // crawl-long host cache: a one-time public answer must not authorize a
        // later connection attempt (DNS rebinding). This route check is
        // defense-in-depth; the loopback proxy started above pins the address
        // Chromium actually connects to.
        const renderedRequestAllowed = (raw: string): Promise<boolean> => {
          let parsed: URL;
          try {
            parsed = new URL(raw);
          } catch {
            return Promise.resolve(false);
          }
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            // data:, blob:, about:, and similar are not network destinations.
            return Promise.resolve(true);
          }
          return assessPublicDestination(raw, limits.resolveHost)
            .then(decision => decision.allowed)
            .catch(() => false);
        };
        // A context-wide route also covers popups. Redirects are enforced at
        // the loopback proxy on every new connection, so Chromium's redirect
        // following cannot skip the destination check even though the route
        // layer only sees the initial URL. The proxy is also the DNS-pinning
        // enforcement point; this handler is the earlier URL preflight.
        const launchOptions = browserLaunchOptions();
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
          launchContext: {
            launchOptions: {
              ...launchOptions,
              // `<-loopback>` disables Chromium's implicit loopback proxy
              // bypass, so even a link to 127.0.0.1 must pass the pinning proxy.
              proxy: { server: egressProxy.url, bypass: '<-loopback>' },
            },
          },
          browserPoolOptions: {
            prePageCreateHooks: [(_pageId, _controller, pageOptions) => {
              if (pageOptions) pageOptions.serviceWorkers = 'block';
            }],
          },
          preNavigationHooks: [async ({ page }) => {
            const context = page.context();
            if (!renderedRouteGuards.has(context)) {
              const guard = createRenderedRouteGuard(context, {
                isAllowed: renderedRequestAllowed,
                onBlocked: () => { telemetry.blockedRequests++; },
                onUnexpectedRouteError: error => {
                  const cause = browserCauseSnippet(error, 300);
                  console.warn(`[RenderedRoute] unexpected route failure; request aborted${cause ? `: ${cause}` : ''}`);
                },
              });
              renderedRouteGuards.set(context, guard);
              try {
                await context.route('**/*', guard.handler);
                // Install the close wrapper only after the route exists so a
                // failed install never leaves a stale close disposer behind.
                installRenderedRouteCloseCleanup(context, () => guard.dispose());
              } catch (error) {
                renderedRouteGuards.delete(context);
                await guard.dispose();
                throw error;
              }
            }
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
            // A retry replaces the failed attempt's uncertified mark: this
            // attempt re-examines the page from its first control.
            uncertifiedRequestKeys.delete(request.url);
            // Assigned once the per-page P0.2 counters exist; the catch path
            // calls it to preserve counts from an already-enumerated page.
            let aggregatePageCountersOnError: (() => void) | undefined;
            // Exposed to the handler catch so queued probes are incorporated
            // before counters from an enumerated page are aggregated.
            let flushPageContextProbesOnError: (() => Promise<void>) | undefined;
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
            // Capture the URL that this request is about to inspect before
            // `inspect()` can yield to a navigation. The identity captured
            // with the baseline counts is the primary guard; this URL is the
            // conservative fallback when no identity is available, so it must
            // describe the document the request started from.
            const pageDocumentUrl = page.url();
            await inspect();
            inspectedPages++;
            telemetry.lastLifecycleStage = advanceRenderedLifecycleStage(telemetry.lastLifecycleStage, 'PAGE_PROCESSED');
            // P0.2 context counters: structural presence only, refreshed after
            // scrolling and same-document DOM-changing clicks so frames/shadow
            // roots revealed by interaction are not missed. They are
            // diagnostics for P1.3-P1.5 and never alter selection, clicking,
            // outcome, or retry behavior. A page that navigated away or closed
            // between inspection and a probe must not fail the crawl.
            let pageFrameCount = 0;
            let pageShadowRootCount = 0;
            let pageBaseHrefPresent = false;
            let pageScrollCapThisAttempt = false;
            // Capture the inspected document's identity and its context counts
            // in one evaluation before any counter sample. The identity is
            // what tells a same-document `pushState`/`replaceState` (identity
            // unchanged) from a real navigation (identity changed); taking it
            // up front means a URL update during a probe is never mistaken for
            // a replacement, and a later probe can never redefine the
            // document whose counters we accept.
            let pageDocumentIdentity: number | null | undefined;
            let pageContextAbandoned = false;
            const initialPageContext = await page.evaluate(collectRenderedPageContext).catch(() => null);
            if (initialPageContext) {
              pageDocumentIdentity = initialPageContext.documentTimeOrigin ?? null;
              pageFrameCount = Math.max(0, Math.floor(initialPageContext.frameCount) || 0);
              pageShadowRootCount = Math.max(0, Math.floor(initialPageContext.shadowRootCount) || 0);
              pageBaseHrefPresent = initialPageContext.baseHrefPresent === true;
            } else {
              // Without a baseline identity, a later sample could describe a
              // different document; skip context measurement for this request
              // rather than attribute another document's counters to it. The
              // crawl-level flag keeps the coverage reason from claiming
              // COMPLETE when context was never measured.
              pageContextAbandoned = true;
              contextMeasurementAbandoned = true;
            }
            const recordPageContext = async (): Promise<void> => {
              if (pageContextAbandoned) return;
              try {
                const pageContext = await page.evaluate(collectRenderedPageContext);
                const currentIdentity = pageContext.documentTimeOrigin ?? null;
                const sameUrl = normalizeVisitUrl(page.url()) === normalizeVisitUrl(pageDocumentUrl);
                const sameDocument = pageDocumentIdentity !== null && currentIdentity !== null
                  ? currentIdentity === pageDocumentIdentity
                  : sameUrl;
                // A same-document pushState path/query change and a same-URL
                // reload both belong to this inspection. Only a new document
                // at a different URL is another request's context.
                if (!sameDocument && !sameUrl) {
                  // A click can commit a document that is never enqueued (for
                  // example a hint-matched control whose destination is
                  // hint-free). Its frames, shadow roots, and base href were
                  // inspected but would otherwise never be sampled. Count them
                  // here only when the destination will not be sampled by its
                  // own request and was not already inspected.
                  if (shouldSampleClickDestinationContext({
                    destinationKey: normalizeVisitUrl(page.url()),
                    admittedKeys: admittedEnqueueKeys,
                    visitedKeys: alreadyVisitedSet,
                  })) {
                    pageFrameCount = Math.max(pageFrameCount, Math.max(0, Math.floor(pageContext.frameCount) || 0));
                    pageShadowRootCount = Math.max(pageShadowRootCount, Math.max(0, Math.floor(pageContext.shadowRootCount) || 0));
                    pageBaseHrefPresent = pageBaseHrefPresent || pageContext.baseHrefPresent === true;
                  }
                  return;
                }
                pageFrameCount = Math.max(pageFrameCount, Math.max(0, Math.floor(pageContext.frameCount) || 0));
                pageShadowRootCount = Math.max(pageShadowRootCount, Math.max(0, Math.floor(pageContext.shadowRootCount) || 0));
                pageBaseHrefPresent = pageBaseHrefPresent || pageContext.baseHrefPresent === true;
              } catch { /* context counters never break inspection */ }
            };
            // Per-click probes must never delay the next click. Queue them and
            // flush before page-end aggregation, so measurement cannot consume
            // the shared click budget or change click sequencing.
            const pendingContextProbes: Array<Promise<void>> = [];
            const queuePageContextProbe = (): void => {
              pendingContextProbes.push(recordPageContext());
            };
            const flushPageContextProbes = async (): Promise<void> => {
              const pending = pendingContextProbes.splice(0);
              if (!pending.length) return;
              // Measurement must never extend the request lifecycle: wait at
              // most a short cap and never beyond the remaining crawl budget.
              // Samples still pending at the cap are dropped.
              const remainingMs = limits.totalTimeoutMs - (Date.now() - startedAt);
              const capMs = Math.max(0, Math.min(250, remainingMs));
              if (capMs === 0) return;
              let timer: ReturnType<typeof setTimeout> | undefined;
              try {
                await Promise.race([
                  Promise.allSettled(pending),
                  new Promise<void>(resolve => { timer = setTimeout(resolve, capMs); }),
                ]);
              } finally {
                if (timer) clearTimeout(timer);
              }
            };
            flushPageContextProbesOnError = flushPageContextProbes;
            if (!seedDocumentSeen) {
              seedDocumentSeen = true;
              seedSnapshotUrl = page.url();
              try {
                seedRequiredLinks = discoverRequiredSeedLinks(await page.content(), page.url());
              } catch {
                seedRequiredLinks = [];
              }
            }

            const enumerateControls = async (): Promise<RenderedControlEnumeration> =>
              page.locator(RENDERED_CONTROL_SELECTOR).evaluateAll(enumerateRenderedControlNodes, COMMUNITY_HINTS.source);
            // Per-page P0.2 denominators come from one coherent enumeration
            // snapshot (largest total; first wins ties) so the total and
            // hint-rejected arithmetic always describes the same snapshot.
            // Coverage-gap observations are maxed across every enumeration:
            // a later, smaller snapshot can reveal the structural/icon/popup
            // control that replaced a clicked community button. `pageControlTotal`
            // stays the independently maxed evidence-bearing (hint-matched)
            // count so the existing interaction certificate keeps its exact
            // semantics.
            let pageControlTotal = 0;
            let pageControlsEnumeratedTotal = 0;
            let pageSnapshotRecorded = false;
            let pageHintRejected = 0;
            let pageStructuralNavigation = 0;
            let pageStructuralHintRejected = 0;
            let pageIconLabelRecovered = 0;
            let pagePopupMarkers = new Set<string>();
            let pageControlOverflow = 0;
            const examinedPopupMarkers = new Set<string>();
            const recordControlEnumeration = (enumeration: RenderedControlEnumeration): void => {
              const matchedTotal = enumeration.controls.length;
              pageControlTotal = Math.max(pageControlTotal, matchedTotal);
              if (!pageSnapshotRecorded || enumeration.total > pageControlsEnumeratedTotal) {
                pageSnapshotRecorded = true;
                pageControlsEnumeratedTotal = enumeration.total;
                pageHintRejected = enumeration.hintRejected;
              }
              const gapCounters = mergeRenderedCoverageGapCounters(
                {
                  structuralNavigation: pageStructuralNavigation,
                  structuralHintRejected: pageStructuralHintRejected,
                  iconLabelRecovered: pageIconLabelRecovered,
                },
                enumeration,
              );
              pageStructuralNavigation = gapCounters.structuralNavigation;
              pageStructuralHintRejected = gapCounters.structuralHintRejected;
              pageIconLabelRecovered = gapCounters.iconLabelRecovered;
              pagePopupMarkers = trackRenderedPopupCoverage(pagePopupMarkers, enumeration);
              // Overflow accounting keeps using the matched pool: P0.2 is
              // measurement-only and must not change control-slice behavior.
              const overflow = Math.max(0, matchedTotal - RENDERED_CONTROL_EVALUATION_WINDOW);
              if (overflow > pageControlOverflow) {
                const added = overflow - pageControlOverflow;
                pageControlOverflow = overflow;
                drops.count('control-slice', added);
                evidenceControlsSkipped += added;
                interactionGap = true;
              }
            };
            // Page counters are local until this aggregation. Aggregate once
            // at the normal end of the page and once on the error path below.
            // The error hook is registered before scrolling so a throw during
            // a scroll read still publishes the context counts already
            // measured for this page.
            let pageCountersAggregated = false;
            const aggregatePageControlCounters = (): void => {
              if (pageCountersAggregated) return;
              pageCountersAggregated = true;
              const requestKey = request.url;
              const previous = pageControlTotalsByRequest.get(requestKey);
              // A Crawlee retry can throw during scrolling or before its first
              // enumeration, leaving every control counter at zero. Replacing
              // a fully enumerated earlier attempt with those zeros would
              // subtract its real coverage from the crawl totals, so keep the
              // earlier control observation. Context counters are measured
              // independently of enumeration, so merge those per field.
              if (previous && !pageSnapshotRecorded) {
                const merged = {
                  ...previous,
                  frameCount: Math.max(previous.frameCount || 0, pageFrameCount),
                  shadowRootCount: Math.max(previous.shadowRootCount || 0, pageShadowRootCount),
                  baseHrefPresent: previous.baseHrefPresent || pageBaseHrefPresent,
                };
                pageControlTotalsByRequest.set(requestKey, merged);
                pageScrollCapByRequest.set(
                  requestKey,
                  (pageScrollCapByRequest.get(requestKey) ?? false) || pageScrollCapThisAttempt,
                );
                const contextDelta = renderedRequestControlTotalsDelta(previous, merged);
                frameCount += contextDelta.frameCount;
                shadowRootCount += contextDelta.shadowRootCount;
                baseHrefPresent = baseHrefPresent || merged.baseHrefPresent;
                return;
              }
              // Popups that the click loop actually inspected are not an
              // unexamined context gap. Identity tracking keeps a replacement
              // popup from being cancelled out by an earlier clicked popup,
              // including when the replacement is hint-rejected.
              const current = {
                enumerated: pageControlsEnumeratedTotal,
                hintRejected: pageHintRejected,
                structuralNavigation: pageStructuralNavigation,
                structuralHintRejected: pageStructuralHintRejected,
                iconLabelRecovered: pageIconLabelRecovered,
                popupCount: resolveUnexaminedPopupTargets(pagePopupMarkers, examinedPopupMarkers),
                frameCount: pageFrameCount,
                shadowRootCount: pageShadowRootCount,
                baseHrefPresent: pageBaseHrefPresent,
              };
              pageControlTotalsByRequest.set(requestKey, current);
              pageScrollCapByRequest.set(requestKey, pageScrollCapThisAttempt);
              const delta = renderedRequestControlTotalsDelta(previous, current);
              controlsEnumeratedTotal += delta.enumerated;
              controlsHintRejected += delta.hintRejected;
              controlsStructuralNavigation += delta.structuralNavigation;
              controlsStructuralHintRejected += delta.structuralHintRejected;
              controlsIconLabelRecovered += delta.iconLabelRecovered;
              popupTargets += delta.popupCount;
              frameCount += delta.frameCount;
              shadowRootCount += delta.shadowRootCount;
              baseHrefPresent = baseHrefPresent || current.baseHrefPresent;
            };
            aggregatePageCountersOnError = aggregatePageControlCounters;

            for (let i = 0; i < limits.maxScrollsPerPage; i++) {
              if (Date.now() - startedAt >= limits.totalTimeoutMs) break;
              const before = await page.evaluate(() => document.body?.scrollHeight || 0);
              await page.evaluate(() => window.scrollTo(0, document.body?.scrollHeight || 0));
              await page.waitForTimeout(500); scrolls++; await inspect();
              const after = await page.evaluate(() => document.body?.scrollHeight || 0);
              if (after <= before) break;
              // The document was still growing on the last permitted
              // iteration: the scroll cap, not page stability, ended
              // inspection. P0.2 records the fact; P1.7 decides whether the
              // unexamined remainder makes the run partial.
              if (i === limits.maxScrollsPerPage - 1) pageScrollCapThisAttempt = true;
            }
            // Scrolling can reveal lazy iframes or shadow hosts.
            await recordPageContext();

            const firstEnumeration = await enumerateControls();
            recordControlEnumeration(firstEnumeration);
            const controls = firstEnumeration.controls;
            // Navigable same-host anchors are already discovered through
            // enqueueLinks and Discord-scanned before any click, so the click
            // budget is reserved for controls that only a click can act on
            // (href-less buttons, fragments, JS links, cross-host targets).
            // Slice accounting covers the remainder beyond clicks and skips.
            const clickPlan = partitionRenderedClickTargets(controls, page.url(), limits.maxClicksPerPage, limits.clickOffset);
            // A window made entirely of navigable anchors is fully examined
            // with zero clicks. Record that explicitly so the durable retry
            // offset can advance instead of re-reading the same prefix; a
            // deadline or browser failure before the first click must not
            // advance, because that window was not examined. Track clickable
            // windows separately: a crawl-wide certificate must never let one
            // page's navigable window stand in for another page's unexamined
            // clickable window.
            const clickableInWindow = Math.max(0, clickPlan.evaluationWindow.length - clickPlan.skippedNavigableAnchors);
            if (isNavigableOnlyControlWindow(clickPlan, limits.maxClicksPerPage)) {
              evidenceControlsNavigableOnly = true;
            }
            if (clickableInWindow > 0) {
              evidenceControlsClickableWindow = true;
              pageClickWindowPending = true;
            }
            const countedControlSkips = new Set<string>();
            for (const control of controls) {
              if (control.marker && !clickPlan.toClick.some(target => target.marker === control.marker)
                && !isSkippableNavigableAnchorClick(control, page.url())) {
                countedControlSkips.add(control.marker);
              }
            }
            // Overflow beyond the evaluation window is already counted by
            // recordControlEnumeration. This second count covers only controls
            // inside the window that the click budget could not examine.
            const sliceDropped = Math.max(0, clickPlan.evaluationWindow.length - clickPlan.toClick.length - clickPlan.skippedNavigableAnchors);
            if (sliceDropped > 0) {
              // Every enumerated control matched the community-evidence filter;
              // dropping one for budget means its content was never examined.
              drops.count('control-slice', sliceDropped);
              evidenceControlsSkipped += sliceDropped;
              interactionGap = true;
            }
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
              if (shouldEnqueueRenderedCommunityLink(url)) {
                const admittedKey = normalizeVisitUrl(url);
                if (admittedKey) admittedEnqueueKeys.add(admittedKey);
                return true;
              }
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

            // A popup control that opens a new window has not been examined:
            // the post-click inspect() re-reads the original page only. Track
            // context page creation per click and resolve a popup target only
            // when no new window opened (an in-page disclosure/menu).
            const clickPageContext = (page as unknown as {
              context?: () => {
                on?: (event: string, listener: (candidate: unknown) => void) => void;
                off?: (event: string, listener: (candidate: unknown) => void) => void;
              };
            }).context?.();
            const popupWindowsThisClick = new Set<unknown>();
            const onPopupWindow = (candidate: unknown) => {
              if (candidate && candidate !== page) popupWindowsThisClick.add(candidate);
            };
            clickPageContext?.on?.('page', onPopupWindow);
            let clickLoop: Awaited<ReturnType<typeof runRenderedClickLoop>>;
            try {
              clickLoop = await runRenderedClickLoop({
                targets: clickPlan.toClick,
                maxClicksPerPage: limits.maxClicksPerPage,
                deadlineExceeded: () => Date.now() - startedAt >= limits.totalTimeoutMs,
                click: async control => {
                  popupWindowsThisClick.clear();
                  // Stable marker first: positional nth() indexes are invalidated
                  // when an earlier disclosure changes the selector membership.
                  const locator = control.marker
                    ? page.locator(`[data-oc-control="${control.marker.replace(/"/g, '\\"')}"]`).first()
                    : page.locator(RENDERED_CONTROL_SELECTOR).nth(control.index);
                  const clickOutcome = await attemptRenderedControlClick(createRenderedControlClickDeps({
                    locator: locator as unknown as RenderedClickEndpoint,
                    page: page as unknown as RenderedClickSettler,
                    control,
                    retain,
                    inspect,
                    telemetry,
                    onClicked: () => { clicks++; },
                  }));
                  // Queue a context sample immediately after the click before
                  // the next click can remove or replace the document, but do
                  // not await it: telemetry must not consume the click budget.
                  // The per-page counters are max-monotonic, so a transient
                  // iframe or shadow root still counts.
                  queuePageContextProbe();
                  if (clickOutcome.ok && control.popup && control.marker && popupWindowsThisClick.size === 0) {
                    examinedPopupMarkers.add(control.marker);
                  }
                  return clickOutcome.ok;
                },
                enumerate: enumerateControls,
                pageUrl: () => page.url(),
                clickOffset: limits.clickOffset,
                countedSkips: countedControlSkips,
                onEnumerated: recordControlEnumeration,
              });
            } finally {
              clickPageContext?.off?.('page', onPopupWindow);
            }
            evidenceControlsClicked += clickLoop.evidenceControlsClicked;
            evidenceControlsFailed += clickLoop.evidenceControlsFailed;
            if (clickLoop.evidenceControlsSkipped > 0) {
              drops.count('control-slice', clickLoop.evidenceControlsSkipped);
              evidenceControlsSkipped += clickLoop.evidenceControlsSkipped;
            }
            if (clickLoop.interactionGap) interactionGap = true;
            // Persist pool positions, not raw click count: anchors before the
            // clicked controls must not make the next retry land on the same
            // clickable prefix.
            const offsetAdvance = renderedClickOffsetAdvance(
              clickPlan,
              clickLoop.evidenceControlsClicked + clickLoop.evidenceControlsFailed,
              limits.maxClicksPerPage,
              clickLoop.firstFailedTargetIndex,
            );
            if (offsetAdvance > 0) {
              // Shared per-seed rotation: advance only by the smallest page
              // progress. A page with 64 navigable anchors must not rotate a
              // 4-click child page past controls the child never examined.
              evidenceControlsOffsetAdvance = combineRenderedControlOffsetAdvances(
                evidenceControlsOffsetAdvance,
                offsetAdvance,
              ) ?? 0;
            } else if (clickableInWindow > 0) {
              // Clickable controls were inside the window but no progress was
              // recorded (deadline, zero budget, detached marker). The shared
              // offset must not move based on another page's progress.
              uncertifiedRequestKeys.add(request.url);
            }
            pageClickWindowPending = false;
            evidenceControlsSeen += pageControlTotal;
            // A disclosure click can reveal lazy frames or shadow hosts.
            await flushPageContextProbes();
            await recordPageContext();
            // Page-end aggregation for P0.2. Counts are crawl totals, not
            // per-page maxima, so a multi-page crawl reports the sum of what
            // each processed page exposed.
            aggregatePageControlCounters();

            if (Date.now() - startedAt < limits.totalTimeoutMs) {
              await enqueueLinks({strategy:'same-hostname',transformRequestFunction:req=>(admitEnqueueRequest(req.url)?req:false)});
            }
            // Required-set re-snapshot (coverage certificate): links revealed by
            // scrolling or by the click passes are obligations too. Recompute
            // the seed document's same-host community-hint links after all
            // interactions and merge new ones into the required set. When a
            // click navigated the seed document away, current content is no
            // longer the requested seed page: record the expansion for
            // diagnostics but never invent required obligations from a
            // different document (its links were enqueued/inspected instead).
            if (seedDocumentSeen) {
              try {
                const currentUrl = page.url();
                const sameDocument = normalizeVisitUrl(currentUrl) === normalizeVisitUrl(seedSnapshotUrl);
                if (sameDocument) {
                  const known = new Set(seedRequiredLinks);
                  let added = 0;
                  for (const link of discoverRequiredSeedLinks(await page.content(), currentUrl)) {
                    if (!known.has(link)) { known.add(link); added++; }
                  }
                  if (added > 0) { seedRequiredLinks = [...known]; requiredSnapshotExpanded = true; }
                } else {
                  requiredSnapshotExpanded = true;
                }
              } catch { /* snapshot never breaks inspection */ }
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
              // Preserve P0.2 counts for a page that was already enumerated
              // before a later enqueue/click throw. The aggregation is
              // idempotent per attempt, and the per-request replacement above
              // makes a Crawlee retry overwrite this attempt instead of
              // counting it twice.
              await flushPageContextProbesOnError?.();
              aggregatePageCountersOnError?.();
              // Crawlee retries a thrown handler with a fresh page. If the
              // click window was still pending, that attempt did not examine
              // its controls; the crawl-wide catch may never run when a retry
              // later succeeds, so certify the gap here. The retry clears this
              // per-request mark when it re-enters the handler.
              if (pageClickWindowPending) uncertifiedRequestKeys.add(request.url);
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
        const completion=resolveRenderedCompletionState({inspectedPages,timedOut,telemetry,pageBudgetExhausted,interactionGap});
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
        // Persist the bounded control-coverage certificate alongside the
        // crawler telemetry so production can distinguish 64-overflow from
        // ordinary click-budget slicing. Counts only; never selectors/text.
        // P0.2 adds the coverage-reason certificate; a timeout or page-budget
        // cutoff is a named ceiling and therefore BOUNDED.
        publishEvidenceControlCertificate(timedOut || pageBudgetExhausted);
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
          evidenceControlsTotal: evidenceControlsSeen || undefined,
          evidenceControlsClicked: evidenceControlsClicked || undefined,
          evidenceControlsFailed: evidenceControlsFailed || undefined,
          evidenceControlsSkipped: evidenceControlsSkipped || undefined,
          evidenceControlsNavigableOnly: (evidenceControlsNavigableOnly && !evidenceControlsClickableWindow) || undefined,
          evidenceControlsUncertified: (evidenceControlsUncertified || uncertifiedRequestKeys.size > 0) || undefined,
          evidenceControlsOffsetAdvance: evidenceControlsOffsetAdvance || undefined,
          interactionGap: interactionGap || undefined,
          requiredSnapshotExpanded: requiredSnapshotExpanded || undefined,
          detail:candidates.length
            ? `Rendered fallback retained ${candidates.length} distinct Discord candidate(s) across ${inspectedPages} page(s); ${telemetry.requestsFailed} request(s) failed within the bounded crawl; ${browserFallbackTelemetrySummary(telemetry)}`
            : timedOut?`Rendered acquisition budget expired before coverage completed; ${browserFallbackTelemetrySummary(telemetry)}`:telemetry.unresolvedFailedRequests>0?`Rendered acquisition incomplete: ${telemetry.unresolvedFailedRequests} request(s) terminally failed within the bounded crawl; ${browserFallbackTelemetrySummary(telemetry)}`:noPageProcessed?`Rendered acquisition incomplete: no page was processed (NO_PAGE_PROCESSED); ${browserFallbackTelemetrySummary(telemetry)}`:interactionGap?`Rendered acquisition incomplete: ${evidenceControlsFailed} evidence-bearing control click(s) failed and ${evidenceControlsSkipped} were skipped by the control budget; coverage is not complete; ${browserFallbackTelemetrySummary(telemetry)}`:`Rendered acquisition completed across ${inspectedPages} page(s) without an invite; ${browserFallbackTelemetrySummary(telemetry)}`,
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
        // A throw while a clickable page was still being examined must leave
        // the seed uncertified; otherwise the catch result's raw click count
        // advances the shared offset past that page's unexamined controls.
        if (pageClickWindowPending) evidenceControlsUncertified = true;
        // A thrown crawl is never complete coverage. When pages were
        // processed the reason is BOUNDED (an abort cut the remaining
        // navigation); zero pages resolves to UNKNOWN.
        publishEvidenceControlCertificate(true);
        return {foundInvite:candidates[0]?.nativeInviteCode||null,foundLocation:candidates[0]?.sourceUrl,candidates,inspectedPages,scrolls,clicks,complete:false,retryable:true,timedOut:false,failureClass,telemetry,dropReasons:drops.snapshot(),interactionGap:interactionGap||undefined,evidenceControlsTotal:evidenceControlsSeen||undefined,evidenceControlsClicked:evidenceControlsClicked||undefined,evidenceControlsFailed:evidenceControlsFailed||undefined,evidenceControlsSkipped:evidenceControlsSkipped||undefined,evidenceControlsNavigableOnly:(evidenceControlsNavigableOnly&&!evidenceControlsClickableWindow)||undefined,evidenceControlsUncertified:(evidenceControlsUncertified||uncertifiedRequestKeys.size>0)||undefined,evidenceControlsOffsetAdvance:evidenceControlsOffsetAdvance||undefined,detail:`Rendered acquisition unavailable or failed${causeSnippet?` (cause: ${causeSnippet})`:''}: ${browserFallbackTelemetrySummary(telemetry)}`};
      } finally {
        // The isolated queue must never outlive its crawl: the lifecycle
        // finalizer drops it on success, failure, and unexpected throws alike
        // (best-effort with a bounded warning — see dropIsolatedRenderedQueue)
        // and then reclaims the anonymous process-wide listeners the queue
        // construction added (see the capture above), so the dropped queue and
        // its ~16 MB deduplication cache become collectable. Runs on every
        // path, including open failures and drop failures; it never affects
        // the crawl result. The normal browser-close wrapper normally unwinds
        // the context route already; this is the launch-failure/fallback path.
        await disposeRenderedRouteGuards(renderedRouteGuards.values());
        try {
          await finalizeRenderedQueueLifecycle({
            queue: isolated?.queue,
            name: isolated?.name,
            emitter: queueEventEmitter,
            ledger: queueListenerLedger,
          });
        } finally {
          // The loopback proxy must not outlive the browser session; closing
          // is best-effort and never changes the crawl result.
          await egressProxy?.close().catch(() => undefined);
        }
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
    // P0.2 diagnostic: a gate/browser rejection processed no page, so coverage
    // is unknown rather than complete. P1.7 owns any outcome consequence.
    telemetry.coverageReason = resolveRenderedCoverageReason({ pagesInspected: 0 });
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
