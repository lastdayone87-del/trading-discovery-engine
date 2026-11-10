import * as cheerio from 'cheerio';
import { resolveDocumentBaseUrlFromRoot } from './documentBase';
import { assessCrawlAdmission } from './communitySurfacePolicy';
import { shouldFollowDestination, DISCORD_DESTINATION_HOSTS } from './destinationPolicy';
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
import type { AcquisitionLane } from './acquisitionLaneKeys';
import {
  renderedAdmissionGovernor,
  type RenderedAdmissionDecision,
  type RenderedAdmissionGovernorLike,
} from './renderedAdmissionGovernor';

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
  /**
   * P1.6 (default OFF): allow rendered navigation to enqueue cross-origin
   * destinations that pass the shared destination policy. The pass is bounded
   * crawl-wide by MAX_RENDERED_CROSS_ORIGIN_ENQUEUES; same-origin enqueue
   * behavior is unchanged. Enable only after security review and a canary.
   */
  crossOriginEnqueue?: boolean;
  /** Optional resolver for the rendered-tier public-destination guard. The
   * browser path is defense-in-depth: static SSRF blocks must never escalate,
   * and every navigation/subrequest is also checked here. Tests inject a
   * deterministic resolver; production defaults to system DNS. */
  resolveHost?: DnsResolver;
  /** Acquisition lane for the Phase 2 admission governor. Optional/additive:
   * direct callers default to UNKNOWN at the gate. */
  admissionLane?: AcquisitionLane;
  /**
   * Test-only seam for the full-crawler browser fixtures. Production callers
   * must omit this: the default is the production loopback egress proxy,
   * which pins public DNS and rejects private destinations. Tests inject a
   * fixture proxy that serves synthetic public hostnames from a local origin
   * while the route guard and public-destination resolver above stay active.
   */
  egressProxyFactory?: () => Promise<BrowserEgressProxy>;
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
  controlsStructuralDisclosure?: number;
  controlsStructuralUnrecovered?: number;
  controlsIconLabelRecovered?: number;
  popupTargets?: number;
  /** Popup destinations captured during an allowed same-origin click and
   * either inspected directly or enqueued as a normal bounded page request. */
  popupCaptured?: number;
  /** Popup destinations dropped because the page/time budget could not
   * inspect them. Never silently discarded. */
  popupDestinationsDropped?: number;
  /** Same-origin links revealed by an interaction (not present in the
   * pre-interaction snapshot) that were admitted as bounded navigation. */
  revealedSameOriginAdmitted?: number;
  /** Revealed same-origin navigation candidates left unqueued or unvisited by
   * the bounded page budget. Counted as a bounded gap, not a clean run. */
  revealedSameOriginDropped?: number;
  /** Control elements that cannot be safely clicked: opaque icon-only
   * controls, form submission/reset controls, and download links. Their
   * content cannot be inspected without an unsafe interaction; recorded so
   * they can never be certified as a clean absence. */
  opaqueInteractiveControls?: number;
  frameCount?: number;
  /** Open shadow roots observed in the light DOM. */
  shadowRootCount?: number;
  /** Closed shadow roots observed through the bounded attachShadow probe. */
  closedShadowRootCount?: number;
  /** Declarative closed shadow roots found in a raw main-document response.
   * The HTML parser removes the `<template shadowrootmode>` node before page
   * JavaScript or DOM traversal can see it, so these roots are counted from
   * the response body rather than the live DOM. */
  declarativeClosedShadowRootCount?: number;
  /** Main-document responses that could not be scanned for declarative closed
   * roots (body unavailable or above the bounded scan size). Never a clean
   * absence: coverage stays partial when this is non-zero. */
  declarativeShadowScanGap?: number;
  /** Largest single-collection overflow beyond the bounded per-collector cap
   * (sampled up to 500). The collector still stops at 500; overflow is
   * counted so a crowded page cannot silently hide a later destination or
   * certify complete coverage. */
  candidateCapTruncated?: number;
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
  /**
   * Longest time this seed waited for rendered-gate admission (milliseconds).
   * Capacity evidence only: a gate wait is not an acquisition failure. Sparse:
   * absent when the run was rejected before admission or predates
   * instrumentation.
   */
  gateWaitMs?: number;
  /**
   * UTC timestamp when the gate admitted this rendered seed. Used to attribute
   * each browser crawl to the correct hour when an inspection crosses an hour
   * boundary. Absent for gate refusals/launch failures before admission.
   */
  crawlStartedAt?: string;
  /** UTC timestamp when this rendered seed's crawl ended. */
  crawlFinishedAt?: string;
}

/** True when the rendered result proves navigation actually ran. */
export function renderedCrawlStarted(
  result: Pick<BrowserFallbackResult, 'inspectedPages' | 'telemetry'>,
): boolean {
  const telemetry = result.telemetry;
  return result.inspectedPages > 0
    // A crawl can enter the handler and load a page, then hit the deadline
    // before the counter snapshot increments. The lifecycle stage is the
    // affirmative evidence that navigation ran and the slot was consumed.
    || telemetry?.lastLifecycleStage === 'HANDLER_ENTERED'
    || telemetry?.lastLifecycleStage === 'PAGE_PROCESSED'
    || (telemetry?.requestsStarted || 0) > 0
    || (telemetry?.requestsFinished || 0) > 0
    || (telemetry?.requestsFailed || 0) > 0
    || (telemetry?.navigationTimeouts || 0) > 0
    || (telemetry?.clicksSucceeded || 0) > 0;
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

/**
 * Human-readable result detail for a completed rendered crawl. Extracted so
 * the branch order is testable directly: the most specific stop (retained
 * candidates, timeout, terminal failure, zero pages, interaction gap, coverage
 * reason) always wins, and a non-COMPLETE coverage reason can never fall
 * through to the "completed ... without an invite" wording.
 */
export function resolveRenderedFallbackDetail(input: {
  candidatesFound: number;
  inspectedPages: number;
  timedOut: boolean;
  telemetry: BrowserFallbackTelemetry;
  noPageProcessed: boolean;
  interactionGap: boolean;
  evidenceControlsFailed: number;
  evidenceControlsSkipped: number;
  coverageReason?: RenderedCoverageReason;
}): string {
  const summary = browserFallbackTelemetrySummary(input.telemetry);
  if (input.candidatesFound > 0) {
    // A retained invite does not make the run clean: keep the unexamined
    // navigation surface visible in the same detail line.
    const coverageGap = input.coverageReason !== undefined && input.coverageReason !== 'COMPLETE'
      ? `; navigation coverage ${input.coverageReason}`
      : '';
    return `Rendered fallback retained ${input.candidatesFound} distinct Discord candidate(s) across ${input.inspectedPages} page(s)${coverageGap}; ${input.telemetry.requestsFailed} request(s) failed within the bounded crawl; ${summary}`;
  }
  if (input.timedOut) return `Rendered acquisition budget expired before coverage completed; ${summary}`;
  if (input.telemetry.unresolvedFailedRequests > 0) {
    return `Rendered acquisition incomplete: ${input.telemetry.unresolvedFailedRequests} request(s) terminally failed within the bounded crawl; ${summary}`;
  }
  if (input.noPageProcessed) return `Rendered acquisition incomplete: no page was processed (NO_PAGE_PROCESSED); ${summary}`;
  if (input.interactionGap) {
    return `Rendered acquisition incomplete: ${input.evidenceControlsFailed} evidence-bearing control click(s) failed and ${input.evidenceControlsSkipped} were skipped by the control budget; coverage is not complete; ${summary}`;
  }
  if (input.coverageReason !== undefined && input.coverageReason !== 'COMPLETE') {
    return `Rendered acquisition incomplete: navigation coverage ${input.coverageReason}; ${summary}`;
  }
  return `Rendered acquisition completed across ${input.inspectedPages} page(s) without an invite; ${summary}`;
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
  /** Earliest capacity retry hint when admission was rate-limited. */
  retryAt?: number;
  /**
   * True when the per-seed time budget expired before coverage completed.
   * Threaded separately from failure classes so budget expiration stays
   * semantically distinct from target blocking, zero-page results, and
   * transient/network failures in telemetry and outcome classification.
   */
  timedOut?: boolean;
  /**
   * P1.7 precise retry ownership for a non-COMPLETE coverage reason. True only
   * when a refetch can change the gap (wall-clock timeout, page-budget cutoff,
   * interaction gap, abandoned context sampling). False/absent when the gap is
   * reproducible as-is: a fixed scroll ceiling, deterministic policy/context
   * exclusion, or a permanently failed child that made the reason BOUNDED.
   * Outcome classification uses this instead of the aggregate `retryable`
   * flag, which permanent child failures can also set.
   */
  coverageGapRetryable?: boolean;
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
  /**
   * Number of optional cross-origin destinations actually enqueued by this
   * crawl. Absent when P1.6 is off or nothing was admitted. Outcome
   * classification only withholds retry from a clean required-covered result
   * when this is non-zero, so flag-off behavior is unchanged.
   */
  crossOriginEnqueued?: number;
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

/**
 * P1.6 crawl-wide cap on cross-origin pages enqueued by the rendered tier.
 * Same-host required links keep the remaining page budget; cross-origin
 * destinations are optional link-hub/community evidence, never required
 * obligations. Kept small so one page with many external links cannot consume
 * the whole rendered crawl.
 */
export const MAX_RENDERED_CROSS_ORIGIN_ENQUEUES = 3;

/**
 * Per-page popup inspection bound. The counter is observed popups, not the
 * current queue length: `drainPopups` shifts an item before awaiting it, so a
 * length check would let new events refill the array and exceed the cap.
 */
export const RENDERED_POPUP_LIMIT = 8;

/**
 * Planner default for interaction-revealed same-origin links. Production
 * passes the existing remaining page budget so no new crawl-wide limit is
 * introduced; the default keeps the pure planner unbounded for callers that
 * have already applied their own budget.
 */
export const DEFAULT_REVEALED_SAME_ORIGIN_ENQUEUES = Number.MAX_SAFE_INTEGER;

/** Discord destinations are terminal invite candidates, already extracted by
 * the page scan; enqueueing them would spend navigation budget on a page the
 * crawler does not need to inspect. The host list lives in destinationPolicy so
 * the exclusion and the community-platform classification cannot drift. */
export function isDiscordDestinationUrl(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
    return DISCORD_DESTINATION_HOSTS.some(entry => host === entry || host.endsWith(`.${entry}`));
  } catch {
    return false;
  }
}

/** Hosts whose `/code` and `/invite/code` paths the page scan retains as
 * native invite evidence. Redirect shorteners (`dsc.gg`, `discord.me`,
 * `discord.io`) and directory pages (`disboard.org`) are deliberately absent:
 * the scan keeps them only as unresolved locators, so they still need a
 * navigation surface to resolve the invite. */
const NATIVE_DISCORD_INVITE_HOSTS = new Set(['discord.gg', 'discord.com', 'discordapp.com', 'discord.app']);
const DISCORD_INVITE_CODE_PATH = /^\/[A-Za-z0-9_-]{2,128}\/?$/;
const DISCORD_INVITE_PATH = /^\/invite\/[A-Za-z0-9_-]{2,128}\/?$/;

/**
 * Whether a Discord URL is a native invite the page scan already retained as
 * terminal evidence. Only these may be skipped by the cross-origin pass; a
 * redirect shortener or directory page must pass the destination policy so a
 * JS-added "Visit server" link can still resolve to an invite.
 */
export function isNativeDiscordInviteUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  const match = [...NATIVE_DISCORD_INVITE_HOSTS].find(entry => host === entry || host.endsWith(`.${entry}`));
  if (!match) return false;
  return match === 'discord.gg'
    ? DISCORD_INVITE_CODE_PATH.test(parsed.pathname)
    : DISCORD_INVITE_PATH.test(parsed.pathname);
}

/**
 * A pre-existing sibling page can be either an idle browser-pool page or a
 * real popup that loaded before the request handler attached its listener.
 * HTTP(S) siblings are always real destinations. An `about:blank` sibling is
 * real only when it still has an opener or has been populated by
 * `document.write`; an empty, opener-less page is pool idle state and closing
 * it would manufacture a coverage gap on every ordinary crawl.
 */
export function shouldSkipPreexistingSiblingPage(
  url: string,
  probe: { hasOpener?: boolean; hasContent?: boolean } | null,
): boolean {
  if (/^https?:/i.test(url)) return false;
  if (!probe) return true;
  if (probe.hasOpener === true) return false;
  return probe.hasContent !== true;
}

/** Closed taxonomy for how a popup URL is handled by the bounded drain. */
export type RenderedPopupDestinationKind =
  | 'uninspectable'
  | 'discord'
  | 'cross-origin'
  | 'admission-rejected'
  | 'same-origin';

/**
 * Evidence source for markup read out of a popup document. A committed popup
 * is its own source: crediting its markup to the opener can make a third-party
 * invite look creator-owned on a branded creator site. A blank popup has no
 * URL; its `document.write()` markup was authored by the opener, which is the
 * only available source.
 */
export function popupMarkupEvidenceSourceUrl(
  kind: RenderedPopupDestinationKind,
  popupUrl: string,
  openerUrl: string,
): string {
  return kind === 'uninspectable' ? openerUrl : popupUrl;
}

export function classifyRenderedPopupDestination(
  popupUrl: string,
  pageUrl: string,
): RenderedPopupDestinationKind {
  if (!popupUrl || popupUrl === 'about:blank') return 'uninspectable';
  let parsed: URL;
  try {
    parsed = new URL(popupUrl);
  } catch {
    return 'uninspectable';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'uninspectable';
  // Only a Discord URL that yields an extractable invite is terminal evidence.
  // A generic Discord-host page (homepage, login, channel view) carries no
  // invite in its URL; treating it as captured would hide the invite its
  // document might contain. Let it fall through to the ordinary origin and
  // admission classification so it stays an unexamined destination.
  if (isDiscordDestinationUrl(popupUrl) && extractDiscordCandidates(popupUrl).length > 0) return 'discord';
  // Security/format rejection is more precise than origin: a private or
  // non-public target is never an eligible navigation surface.
  if (!assessCrawlAdmission(popupUrl).eligible) return 'admission-rejected';
  let pageOrigin = '';
  try { pageOrigin = new URL(pageUrl).origin; } catch { pageOrigin = ''; }
  if (parsed.origin !== pageOrigin) return 'cross-origin';
  return 'same-origin';
}

/**
 * Popup URL waits are bounded by both their own 1.5s cap and the crawl
 * deadline. Draining up to eight popups sequentially must never extend the
 * request handler past `totalTimeoutMs`.
 */
export function renderedPopupWaitTimeoutMs(
  remainingCrawlMs: number,
  capMs = 1_500,
): number {
  const cap = Number.isFinite(capMs) ? Math.max(0, Math.floor(capMs)) : 0;
  const remaining = Number.isFinite(remainingCrawlMs) ? Math.max(0, Math.floor(remainingCrawlMs)) : 0;
  return Math.min(cap, remaining);
}

export const COMMUNITY_HINTS = /discord|community|join|chat|member|membership|vip|group|private|trading.?room|links?|social|contact|about|whop|skool|circle|patreon|premium|paid|subscribe|signals?|mentor|access/i;

/**
 * Interactive controls that can reveal content only through interaction:
 * links, buttons, ARIA buttons/tabs/menu items, popup triggers, native
 * disclosures (`summary`), and collapsed accordion triggers. The selector is
 * shared by enumeration and clicking so locator indexes always refer to the
 * same full query.
 */
export const RENDERED_CONTROL_SELECTOR = 'a,button,input[type="submit"],input[type="image"],input[type="reset"],[role="button"],[role="tab"],[role="menuitem"],summary,[aria-expanded="false"],[aria-haspopup]';

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

/** Context observed on a document reached only by a click. */
export interface ClickDestinationContext {
  frameCount: number;
  shadowRootCount: number;
  closedShadowRootCount: number;
  baseHrefPresent: boolean;
}

/**
 * Context seen through a click that committed a new document is attributed
 * only when no request inspected that document as its own page. Admission is
 * deliberately not consulted: `enqueueLinks` can accept a URL that Crawlee
 * then never inspects (max-requests cutoff, later failure), and inspection is
 * the only proof that the destination's context was actually counted
 * elsewhere. A destination can also be clicked before the link pass admits it,
 * so adding its context at click time would double the crawl totals when its
 * own request runs. Observations are keyed by visit identity and reconciled
 * against every document this crawl actually inspected. Pure and unit-tested.
 */
export function reconcileClickDestinationContext(input: {
  observations: ReadonlyMap<string, ClickDestinationContext>;
  inspectedKeys: ReadonlySet<string>;
}): ClickDestinationContext {
  const reconciled: ClickDestinationContext = {
    frameCount: 0,
    shadowRootCount: 0,
    closedShadowRootCount: 0,
    baseHrefPresent: false,
  };
  for (const [key, observed] of input.observations) {
    if (input.inspectedKeys.has(key)) continue;
    reconciled.frameCount += observed.frameCount;
    reconciled.shadowRootCount += observed.shadowRootCount;
    reconciled.closedShadowRootCount += observed.closedShadowRootCount;
    reconciled.baseHrefPresent = reconciled.baseHrefPresent || observed.baseHrefPresent;
  }
  return reconciled;
}

/**
 * Terminal-success identities for one processed request. The request URL is
 * always evidence. The document URL where processing started is evidence even
 * if a same-document history update or a later click replacement changed the
 * URL: that document was inspected. The final document URL is evidence only
 * when the document that finished the handler is the document that was
 * processed: a redirect commits before inspection, so both identities were
 * inspected, while a click-triggered navigation replaces the document after
 * the click loop stops and leaves the replacement's controls unexamined. That
 * URL must be proven by its own successful request instead of being borrowed
 * as shared coverage.
 */
export function renderedTerminalSuccessIdentities(input: {
  requestUrl: string;
  initialDocumentUrl: string;
  inspectedDocumentUrl: string;
  finalDocumentUrl: string;
  documentReplacedByClick: boolean;
}): string[] {
  const processedUrl = input.documentReplacedByClick
    ? input.inspectedDocumentUrl
    : input.finalDocumentUrl;
  const keys = visitIdentityKeys(input.requestUrl, input.initialDocumentUrl);
  for (const key of visitIdentityKeys(input.requestUrl, processedUrl)) {
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
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
  let $: cheerio.CheerioAPI;
  try {
    $ = cheerio.load(String(seedHtml || ''));
  } catch {
    return [];
  }
  const documentBase = resolveDocumentBaseUrlFromRoot($, seedUrl);
  try {
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
      absolute = new URL(raw, documentBase);
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
 * - cross-host http(s) hrefs → skipped while the bounded destination-policy
 *   pass is pursuing them; when pursuit is OFF or its cap is exhausted, an
 *   eligible community/aggregator destination stays clickable (the click is
 *   the only remaining path) and its text+href is retained first.
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
  /**
   * True when activating the control opens a new browsing context
   * (`target=_blank`). Distinct from `popup`, which only marks controls that
   * cannot be followed as a normal navigation. The click planner needs this to
   * know whether a click inspects in place or opens a popup: a cross-origin
   * popup is never navigated to, so clicking one cannot discover its content.
   * `aria-haspopup` is deliberately excluded: it can describe an in-page
   * menu/dialog whose handler reveals content without navigating, so treating
   * it as a new context would skip a real discovery path.
   */
  newContext?: boolean;
  /**
   * Why the control entered the click set. Original hint matches and icon-label
   * recoveries are evidence-bearing increments; generic structural disclosures
   * are best-effort opportunism. Only the former make an unclicked control a
   * retryable interaction gap; an unclicked disclosure stays a diagnostic.
   */
  origin?: 'hint' | 'icon' | 'disclosure';
  /**
   * True when the control had no layout box at enumeration (for example a
   * button inside a closed `<details>`). A hidden control is queued after
   * every visible one in its priority group: clicking it first can time out
   * and consume budget before the disclosure that reveals it has run.
   */
  hidden?: boolean;
  /**
   * Marker of the disclosure that reveals this hidden control. Retry rotation
   * may start in the middle of the pool, so the planner re-attaches a hidden
   * control to its revealer instead of clicking it while its menu is closed.
   * Never serialized to telemetry.
   */
  afterMarker?: string;
}

export interface RenderedControlEnumeration {
  /** Evidence-bearing controls: base hint matches first, then icon-label
   * recoveries, then structural disclosures that can reveal content in place.
   * Each group preserves DOM order. */
  controls: RenderedControlTarget[];
  /** Pre-filter denominator: every node matched by the shared selector. */
  total: number;
  /** Nodes excluded by the original community-hint filter (total - baseMatched). */
  hintRejected: number;
  /** Menu/nav/hamburger/aria-haspopup/role=menuitem/tab/summary controls. */
  structuralNavigation: number;
  /** Structural controls the original hint filter would hide (P0.2 measurement). */
  structuralHintRejected: number;
  /** Structural controls included by P1.1 because they can reveal content in place. */
  structuralDisclosure: number;
  /** Structural navigable anchors still outside the click set because they
   * would replace the document (and are not base hint matches). The enqueue
   * path owns them; when it rejects the URL, the destination was never
   * examined and the crawl cannot resolve as COMPLETE. This is the raw
   * browser-side candidate count; the request handler filters it through the
   * enqueue admission rule before publishing coverage. */
  structuralUnrecovered: number;
  /** Bounded hrefs backing `structuralUnrecovered`, used by the request
   * handler to exclude destinations the enqueue path actually follows. */
  structuralUnrecoveredHrefs: string[];
  /** At least one candidate was observed after the bounded href sample filled. */
  structuralUnrecoveredOverflow: boolean;
  /** Controls recovered only via title/aria-labelledby/alt/data-label/SVG title
   * or hidden text (P1.2). These are included in `controls`. */
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
  /** Button/role controls with no text, label, href, or structural semantics. */
  opaqueInteractiveControls: number;
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
  structuralDisclosure: number;
  structuralUnrecovered: number;
  iconLabelRecovered: number;
  popupCount: number;
  opaqueInteractiveControls: number;
  frameCount: number;
  shadowRootCount: number;
  closedShadowRootCount: number;
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
    structuralDisclosure: current.structuralDisclosure - (previous?.structuralDisclosure || 0),
    structuralUnrecovered: current.structuralUnrecovered - (previous?.structuralUnrecovered || 0),
    iconLabelRecovered: current.iconLabelRecovered - (previous?.iconLabelRecovered || 0),
    popupCount: current.popupCount - (previous?.popupCount || 0),
    opaqueInteractiveControls: current.opaqueInteractiveControls - (previous?.opaqueInteractiveControls || 0),
    frameCount: current.frameCount - (previous?.frameCount || 0),
    shadowRootCount: current.shadowRootCount - (previous?.shadowRootCount || 0),
    closedShadowRootCount: current.closedShadowRootCount - (previous?.closedShadowRootCount || 0),
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
 * P1.1/P1.2 recovery: `controls` includes the original community-hint match,
 * icon-only labels (title/aria-labelledby/child alt/data-label/SVG title/hidden
 * text), and structural disclosure controls (menu/hamburger/tab/summary/
 * aria-haspopup/collapsed aria-expanded) that can reveal content in place.
 * Non-base-matched structural anchors that navigate to a real document stay
 * out of the click set: the enqueue path owns them, and clicking would replace
 * the document instead of expanding it. Base matches keep their original click
 * behavior. All counts are bounded and selector-derived.
 */
export function enumerateRenderedControlNodes(
  nodes: Element[],
  pattern: string,
): RenderedControlEnumeration {
  const re = new RegExp(pattern, 'i');
  const hintMatched: RenderedControlTarget[] = [];
  const recovered: RenderedControlTarget[] = [];
  const disclosures: RenderedControlTarget[] = [];
  let baseMatchedCount = 0;
  let structuralNavigation = 0;
  let structuralHintRejected = 0;
  let structuralDisclosure = 0;
  let structuralUnrecovered = 0;
  const structuralUnrecoveredHrefs: string[] = [];
  let structuralUnrecoveredOverflow = false;
  let iconLabelRecovered = 0;
  let popupTargets = 0;
  const popupIndices: number[] = [];
  // Hidden controls are queued immediately after the disclosure that reveals
  // them, so unrelated visible controls cannot exhaust the click budget first.
  const revealerIndexByIndex = new Map<number, number>();
  const indexByNode = new Map<Element, number>();
  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) indexByNode.set(nodes[nodeIndex], nodeIndex);
  let opaqueInteractiveControls = 0;
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    const element = node as HTMLElement;
    const tagName = (element.tagName || '').toLowerCase();
    // A control is hidden when it has no layout box, when computed
    // `visibility` hides it, or when a closed <details> ancestor hides it.
    // Some engines still report a layout box for closed-details content, so
    // the ancestor check is authoritative. Every closed ancestor matters: an
    // inner summary is still hidden while an outer <details> is closed. The
    // outermost closed details is the disclosure that ultimately reveals the
    // control, so hidden controls can be queued right after it.
    //
    // Keep this inline: Playwright serializes this function into the page.
    let hiddenByClosedDetails = false;
    let revealer: Element | null = null;
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor.tagName.toLowerCase() !== 'details' || ancestor.hasAttribute('open')) continue;
      const summary = ancestor.querySelector(':scope > summary');
      // The summary itself and everything inside it stay rendered while the
      // details is closed; only its siblings are hidden.
      if (summary && summary.contains(element)) continue;
      hiddenByClosedDetails = true;
      // The nearest closed details is the disclosure the crawler must click
      // first; an outer one only reveals this summary, not the content.
      if (revealer === null) revealer = summary;
    }
    const hidden = hiddenByClosedDetails
      || element.getClientRects().length === 0
      || getComputedStyle(element).visibility === 'hidden';
    if (hidden && revealer) {
      const revealerIndex = indexByNode.get(revealer);
      if (revealerIndex !== undefined) revealerIndexByIndex.set(index, revealerIndex);
    }
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
    // Only the excluded submit/image/reset inputs need value/alt for coverage
    // accounting. Adding those labels to every input would turn previously
    // skipped input buttons (e.g. `<input type="button" value="Subscribe">`)
    // into new hint-matched click targets.
    const excludedInputType = tagName === 'input'
      && ['submit', 'image', 'reset'].includes((element as HTMLInputElement).type);
    const inputLabel = excludedInputType
      ? `${(element as HTMLInputElement).value || ''} ${(element as HTMLInputElement).alt || ''}`
      : '';
    const baseText = `${element.innerText || ''} ${href || ''} ${ariaLabel} ${inputLabel}`;
    // P1.2: resolve labels the original filter ignored. A bounded descendant
    // text walk adds visually hidden text (innerText omits it) without
    // materializing a pathological control's entire subtree.
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
    if (image) childAlt = (image.getAttribute('alt') || '').slice(0, 200);
    const title = (element.getAttribute('title') || '').slice(0, 200);
    const dataLabel = (element.getAttribute('data-label') || '').slice(0, 200);
    const dataTooltip = (element.getAttribute('data-tooltip') || '').slice(0, 200);
    const svgTitleNode = element.querySelector('svg title');
    // Bounded title read: `textContent` materializes the entire subtree, and
    // a hostile SVG title can be arbitrarily large. Walk at most 500 text
    // nodes and collect at most 200 characters, as the other label sources do.
    let svgTitle = '';
    if (svgTitleNode) {
      const svgTitleWalker = document.createTreeWalker(svgTitleNode, NodeFilter.SHOW_TEXT);
      let svgTitleText = svgTitleWalker.nextNode();
      let svgTitleNodes = 0;
      while (svgTitleText && svgTitle.length < 200 && svgTitleNodes < 500) {
        svgTitleNodes++;
        const value = svgTitleText.nodeValue || '';
        const remaining = 200 - svgTitle.length;
        if (value && remaining > 0) svgTitle += value.length > remaining ? value.slice(0, remaining) : value;
        svgTitleText = svgTitleWalker.nextNode();
      }
    }
    // Bounded descendant-text walk. Reading `textContent` and slicing after
    // the fact still materializes and normalizes the entire subtree; a
    // pathological menu container could make every enumeration unbounded.
    // Stop at 200 collected characters (or 500 text nodes as a hard guard).
    let hiddenText = '';
    const textWalker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let textNode = textWalker.nextNode();
    let textNodesExamined = 0;
    while (textNode && hiddenText.length < 200 && textNodesExamined < 500) {
      textNodesExamined++;
      const value = textNode.nodeValue || '';
      const remaining = 200 - hiddenText.length;
      // Concatenate adjacent text nodes without an injected separator: a
      // word split by markup (`Dis<strong>cord</strong>`) must stay intact.
      if (value && remaining > 0) hiddenText += value.length > remaining ? value.slice(0, remaining) : value;
      textNode = textWalker.nextNode();
    }
    hiddenText = hiddenText.replace(/\s+/g, ' ').trim().slice(0, 200);
    // Hint matching may use the resolved href (an icon-only anchor can be
    // identified by its destination alone), but structural classification
    // must not: a `/more` or `#support` URL is not a menu label.
    const labelText = `${element.innerText || ''} ${ariaLabel}`;
    const structuralText = `${labelText} ${title} ${labelledByText} ${childAlt} ${dataLabel} ${dataTooltip} ${svgTitle} ${hiddenText}`;
    const extendedText = `${baseText} ${title} ${labelledByText} ${childAlt} ${dataLabel} ${dataTooltip} ${svgTitle} ${hiddenText}`;
    const baseMatched = re.test(baseText);
    const extendedMatched = re.test(extendedText);
    const hintMatchedControl = baseMatched || extendedMatched;
    if (baseMatched) baseMatchedCount++;
    const role = (element.getAttribute('role') || '').toLowerCase();
    const ariaHaspopup = (element.getAttribute('aria-haspopup') || '').trim().toLowerCase();
    // HTTP(S) is the only destination the enqueue path can follow. A
    // `javascript:` or other scheme is click-only and must not make a
    // `target=_blank` control look like a normal navigable link.
    const hasNavigableHref = typeof href === 'string' && /^https?:\/\//i.test(href);
    const target = (element.getAttribute('target') || '').trim().toLowerCase();
    // An already-open <details> needs no click, and clicking its summary
    // would close it and hide the controls the crawler should inspect. The
    // revealed content is already in the DOM and is enumerated normally.
    const openSummary = tagName === 'summary'
      && !!(element.parentElement as HTMLDetailsElement | null)?.open;
    // Explicit menu semantics are evidence that a navigable anchor is a menu
    // item/trigger rather than an ordinary page link. Label-only matches are
    // still treated as disclosures when they cannot navigate (a button), but
    // they do not turn an ordinary "Learn more"/"Resources" anchor into a
    // navigation-coverage gap.
    const explicitStructural = tagName === 'nav'
      || tagName === 'summary'
      || role === 'menu'
      || role === 'menubar'
      || role === 'menuitem'
      || role === 'navigation'
      || role === 'tab'
      || (ariaHaspopup !== '' && ariaHaspopup !== 'false')
      || element.getAttribute('aria-expanded') === 'false';
    // Menu-like labels only. Generic footer/company/about links are not
    // structural navigation and would make nearly every crawl look
    // policy-bounded. The label text excludes the resolved href.
    const menuLikeLabel = /(^|\b)(menu|navigation|nav|hamburger|resources|support|explore|more)(\b|$)/i.test(structuralText);
    // A control inside a real navigation/menu container is navigation even
    // when its own label is generic (`Products`) and it carries no menu role.
    // That is measurement only: a section/TOC link inside <nav> must not
    // consume the click budget ahead of a real menu trigger.
    const inNavigationContainer = !!element.closest(
      'nav, [role="navigation"], [role="menu"], [role="menubar"]',
    );
    const structuralKind = explicitStructural || menuLikeLabel || inNavigationContainer;
    const structural = structuralKind && !openSummary;
    // A structural anchor that resolves to a different document is a page
    // candidate, not an in-place disclosure. Clicking it would replace the
    // document and consume the click budget; the enqueue path owns it. The
    // comparison is against the current document URL, not the effective
    // <base href>: an anchor can resolve exactly to the base URI while still
    // navigating away from the current document.
    let navigatesAway = false;
    if (tagName === 'a' && typeof href === 'string' && href) {
      try {
        const resolved = new URL(href);
        const current = new URL(document.URL);
        resolved.hash = '';
        current.hash = '';
        navigatesAway = (resolved.protocol === 'http:' || resolved.protocol === 'https:')
          && resolved.toString() !== current.toString();
      } catch {
        navigatesAway = true;
      }
    }
    const isDisclosure = structural && !navigatesAway && (explicitStructural || menuLikeLabel);
    // A non-base-matched structural anchor that navigates away is never
    // clicked: replacing the document would strand the remaining menu
    // controls, and the enqueue path owns the destination. It is a coverage
    // gap only when the anchor is explicitly menu-like (role/haspopup/
    // collapsed state) or was recovered by a hint-bearing label. An ordinary
    // "Learn more"/"Resources"/"Support" page link is a navigation candidate
    // the hint policy deliberately did not pursue, not a structural
    // disclosure, so it must not mark nearly every crawl policy-excluded.
    const excludedStructuralNavigation = structural && navigatesAway && !baseMatched;
    const unrecoveredStructuralNavigation = excludedStructuralNavigation
      && (explicitStructural || extendedMatched);
    const isPopup = (ariaHaspopup !== '' && ariaHaspopup !== 'false')
      || (target === '_blank' && !hasNavigableHref);
    if (structuralKind) {
      structuralNavigation++;
      if (!baseMatched) structuralHintRejected++;
    }
    if (isDisclosure) structuralDisclosure++;
    if (unrecoveredStructuralNavigation) {
      structuralUnrecovered++;
      // Bounded: coverage only needs to know that at least one unexamined
      // structural destination exists, and the request handler re-checks a
      // bounded set against enqueue admission. Overflow is recorded so a
      // candidate beyond the sample cannot silently disappear.
      if (typeof href === 'string' && href) {
        if (structuralUnrecoveredHrefs.length < 64) structuralUnrecoveredHrefs.push(href);
        else structuralUnrecoveredOverflow = true;
      }
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
    // An opaque icon-only button has no text, accessible label, href, or
    // structural semantics. It cannot be safely clicked (the icon is opaque),
    // but it also cannot be silently treated as irrelevant: its click handler
    // could reveal an invite. Count it so coverage resolves as context-
    // unreachable rather than a clean no-match. Href-less anchors (including
    // `role=link` icon controls) are included: without an href they are not
    // navigation candidates, so a click is the only way their destination can
    // be revealed.
    const hasAnyHref = typeof href === 'string' && href.length > 0;
    const interactiveControl = tagName === 'button'
      || tagName === 'input'
      || role === 'button'
      || role === 'tab'
      || role === 'menuitem'
      || (role === 'link' && !hasAnyHref)
      || (tagName === 'a' && !hasAnyHref);
    const hasAccessibleEvidence = extendedText.trim().length > 0;
    // Hidden, disabled, and zero-box widgets are not interaction surfaces: a
    // hidden template menu, a disabled carousel arrow, or a bare
    // `<a name="top"></a>` fragment target cannot reveal an invite. Hash/id
    // anchors on legacy and markdown-generated pages have no rendered box, so
    // counting them would turn an ordinary clean page into CONTEXT_UNREACHABLE.
    const style = window.getComputedStyle(element);
    // An empty inline anchor still generates an inline box: its client rect
    // list has one zero-width entry. Require positive area so `<a name="top">`
    // /`<a id="section">` fragment targets are not counted as opaque surfaces
    // that would turn an ordinary clean page into CONTEXT_UNREACHABLE.
    const clientRects = typeof element.getClientRects === 'function'
      ? Array.from(element.getClientRects())
      : [];
    const renderedBox = clientRects.some(rect => rect.width > 0 && rect.height > 0);
    const hiddenControl = hidden
      || !renderedBox
      || (element as HTMLElement).hidden
      || element.getAttribute('aria-hidden') === 'true'
      || style.display === 'none'
      || style.visibility === 'hidden';
    const disabledControl = (element as HTMLButtonElement).disabled === true
      || element.getAttribute('aria-disabled') === 'true'
      || element.matches(':disabled');
    // M2b: a click must never submit/reset a form or trigger a download.
    // These controls can mutate server state or leave the document without
    // revealing inspectable content, so they are counted as unsafe
    // interaction surfaces (never a clean absence) and excluded from clicks.
    // Native form association is authoritative. An explicit `form` attribute
    // that names a missing form detaches the control; do not fall back to an
    // ancestor form in that case. Browser-normalized `.type` is authoritative:
    // invalid/padded button types behave as submit.
    const hasFormAttribute = element.hasAttribute('form');
    const nativeForm = tagName === 'button'
      ? (element as HTMLButtonElement).form
      : tagName === 'input'
        ? (element as HTMLInputElement).form
        : null;
    const associatedForm = nativeForm || (!hasFormAttribute ? element.closest('form') : null);
    const effectiveType = tagName === 'button'
      ? (element as HTMLButtonElement).type
      : tagName === 'input'
        ? (element as HTMLInputElement).type
        : '';
    // Submit/image/reset inputs are a new selector class for coverage; exclude
    // them from clicks unconditionally, even without a form. A form-less input
    // can still carry a state-changing handler. Buttons retain the existing
    // behavior unless they are associated with a form that would submit/reset.
    const inputSubmitLike = tagName === 'input'
      && (effectiveType === 'submit' || effectiveType === 'image' || effectiveType === 'reset');
    const submitsOrResetsForm = inputSubmitLike
      || (!!associatedForm && tagName === 'button' && (effectiveType === 'submit' || effectiveType === 'reset'));
    const downloadsFile = tagName === 'a' && element.hasAttribute('download');
    if (submitsOrResetsForm || downloadsFile) {
      // Preserve both unsafe-action coverage (a control that would otherwise
      // have been clicked) and the existing opaque-control gap (a visible,
      // enabled, unlabeled interactive control that may reveal content).
      const wouldHaveBeenClicked = hintMatchedControl || isDisclosure;
      const wouldHaveBeenOpaque = interactiveControl
        && !openSummary
        && !hasAccessibleEvidence
        && !hintMatchedControl
        && !isDisclosure;
      if (!hiddenControl && !disabledControl && (wouldHaveBeenClicked || wouldHaveBeenOpaque)) {
        opaqueInteractiveControls++;
      }
      continue;
    }
    if (interactiveControl && !hiddenControl && !disabledControl && !hintMatchedControl && !isDisclosure && !openSummary && !hasAccessibleEvidence) {
      opaqueInteractiveControls++;
    }
    if (openSummary) continue;
    // Disabled controls (including fieldset-inherited disabled and
    // aria-disabled) are not interaction surfaces and are never clicked.
    if (disabledControl) continue;
    if (!hintMatchedControl && !isDisclosure) continue;
    // A structural anchor that navigates away is enqueue-owned and never
    // clicked: replacing the document would strand the remaining menu
    // controls. Only the subset that represents a real unexamined structural
    // destination is counted as unrecovered navigation for coverage.
    if (excludedStructuralNavigation) continue;
    const item: RenderedControlTarget = {
      index,
      text: baseText,
      href,
      tag: (tagName === 'a' ? 'anchor' : tagName === 'button' ? 'button' : 'role') as 'anchor' | 'button' | 'role',
      ...(isPopup ? { popup: true } : {}),
      ...(hidden ? { hidden: true } : {}),
      origin: baseMatched ? 'hint' : extendedMatched ? 'icon' : 'disclosure',
      // `aria-haspopup` describes an in-page menu/dialog, not a new browsing
      // context: its handler can reveal the invite in the current document, so
      // it must stay clickable. Only `target=_blank` is known to open a popup
      // whose cross-origin content the click path never inspects.
      newContext: target === '_blank',
    };
    // Original hint matches keep absolute priority, then icon-label
    // recoveries, then generic structural disclosures. Each group preserves
    // DOM order for deterministic rotation; a recovered control can never
    // consume the click budget ahead of an existing base match.
    if (baseMatched) hintMatched.push(item);
    else if (extendedMatched) recovered.push(item);
    else disclosures.push(item);
  }
  const grouped = [...hintMatched, ...recovered, ...disclosures];
  // Controls with no layout box cannot be clicked yet. Queue each hidden
  // control immediately after the disclosure that reveals it (the nearest
  // closed <details> summary, nested disclosures first), so that disclosure
  // runs first without putting unrelated visible controls in front of the
  // content it reveals. A hidden control with no known revealer in this click
  // set goes last. Clicking a control while its menu is still closed would
  // time out, and because its marker is already queued, the now-visible
  // control would never be retried even with spare click budget.
  const hiddenAfter = new Map<number, RenderedControlTarget[]>();
  const trailingHidden: RenderedControlTarget[] = [];
  for (const item of grouped) {
    if (!item.hidden) continue;
    const revealerIndex = revealerIndexByIndex.get(item.index);
    if (revealerIndex === undefined) {
      trailingHidden.push(item);
      continue;
    }
    const pending = hiddenAfter.get(revealerIndex);
    if (pending) pending.push(item);
    else hiddenAfter.set(revealerIndex, [item]);
  }
  const selected: RenderedControlTarget[] = [];
  const roots: RenderedControlTarget[] = [];
  for (const item of grouped) if (!item.hidden) roots.push(item);
  roots.push(...trailingHidden);
  for (const root of roots) {
    selected.push(root);
    // Depth-first: a revealed disclosure's own content follows it, so a
    // nested closed <details> is opened before the control it contains.
    const stack = (hiddenAfter.get(root.index) || []).slice().reverse();
    while (stack.length > 0) {
      const child = stack.pop() as RenderedControlTarget;
      selected.push(child);
      const nested = hiddenAfter.get(child.index);
      if (nested) for (let nestedIndex = nested.length - 1; nestedIndex >= 0; nestedIndex--) stack.push(nested[nestedIndex]);
    }
  }
  const usedMarkers = new Set<string>();
  const controls: RenderedControlTarget[] = [];
  const markerByIndex = new Map<number, string>();
  for (let itemIndex = 0; itemIndex < selected.length; itemIndex++) {
    const item = selected[itemIndex];
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
    // The revealer is always earlier in `selected`, so its marker already
    // exists. A hidden control with no revealer in the click set keeps the
    // enumeration-time trailing position and has no dependency to replay.
    const revealerIndex = item.hidden ? revealerIndexByIndex.get(item.index) : undefined;
    const afterMarker = revealerIndex === undefined ? undefined : markerByIndex.get(revealerIndex);
    controls.push({ ...item, marker, ...(afterMarker ? { afterMarker } : {}) });
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
    hintRejected: Math.max(0, nodes.length - baseMatchedCount),
    structuralNavigation,
    structuralHintRejected,
    structuralDisclosure,
    structuralUnrecovered,
    structuralUnrecoveredHrefs,
    structuralUnrecoveredOverflow,
    iconLabelRecovered,
    popupTargets,
    popupMarkers,
    opaqueInteractiveControls,
  };
}

export interface RenderedPageContextCounts {
  frameCount: number;
  shadowRootCount: number;
  closedShadowRootCount: number;
  baseHrefPresent: boolean;
  /** Document identity (`performance.timeOrigin`) used only to tell a
   * same-document URL update from a real navigation; never persisted. */
  documentTimeOrigin?: number | null;
}

/**
 * Bounded attachShadow probe installed before page scripts run. It counts
 * closed shadow roots only: their contents remain inaccessible by design, so
 * the probe never pretends to traverse them. The count lets coverage report an
 * unexamined context instead of certifying a clean absence.
 *
 * Self-contained: Playwright serializes this function into every document.
 */
export function installClosedShadowRootInstrumentation(): void {
  if (typeof Element === 'undefined') return;
  const probeWindow = window as unknown as {
    __renderedClosedShadowProbeInstalled?: boolean;
    __renderedClosedShadowRootCount?: number;
  };
  if (probeWindow.__renderedClosedShadowProbeInstalled) return;
  probeWindow.__renderedClosedShadowProbeInstalled = true;
  probeWindow.__renderedClosedShadowRootCount = 0;
  const attachShadow = Element.prototype.attachShadow;
  if (typeof attachShadow !== 'function') return;
  Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit): ShadowRoot {
    try {
      if (init && init.mode === 'closed') {
        probeWindow.__renderedClosedShadowRootCount = Math.min(
          1000,
          (probeWindow.__renderedClosedShadowRootCount || 0) + 1,
        );
      }
    } catch {
      // Instrumentation must never break the page it observes.
    }
    return attachShadow.call(this, init);
  };
}

/**
 * Browser-side bound for declarative-shadow response scanning. The crawler
 * already materializes the parsed DOM for extraction; this cap keeps the
 * additional raw-body read from doubling memory for pathological documents.
 * A skipped body is counted as a scan gap, never as a clean absence.
 */
export const DECLARATIVE_SHADOW_SCAN_MAX_BYTES = 8 * 1024 * 1024;

const isMarkupWhitespace = (code: number): boolean =>
  code === 32 || code === 9 || code === 10 || code === 12 || code === 13;

/** HTML raw-text/RCDATA elements whose contents are text, not markup. */
const NON_MARKUP_ELEMENT_NAMES = ['script', 'style', 'textarea', 'title'];

const tagBoundary = (code: number): boolean =>
  code === -1 || isMarkupWhitespace(code) || code === 47 || code === 62;

/** True when `index` points at `<name` followed by an HTML tag boundary. */
function startsTagAt(html: string, index: number, name: string): boolean {
  if (index + 1 + name.length > html.length) return false;
  if (html.charCodeAt(index) !== 60) return false;
  if (html.slice(index + 1, index + 1 + name.length).toLowerCase() !== name) return false;
  return tagBoundary(index + 1 + name.length < html.length ? html.charCodeAt(index + 1 + name.length) : -1);
}

/**
 * Return the index after an ordinary tag's closing `>`, ignoring `>` and `<`
 * characters inside quoted attribute values. Attribute values are the only
 * place where a markup-looking string is not itself an element start; without
 * this skip, `<div data-note="<script>">` would look like raw text and could
 * hide a real declarative root that follows it.
 */
function skipTag(html: string, start: number): number {
  let cursor = start + 1;
  let quote = -1;
  while (cursor < html.length) {
    const code = html.charCodeAt(cursor);
    if (quote !== -1) {
      if (code === quote) quote = -1;
      cursor++;
      continue;
    }
    if (code === 34 || code === 39) {
      quote = code;
      cursor++;
      continue;
    }
    if (code === 62) return cursor + 1;
    cursor++;
  }
  return html.length;
}

/**
 * Return the index after the closing tag of a raw-text element, or the end of
 * the document when it is unterminated. Scanning from `<` to `<` is linear in
 * the skipped region; the tag-name comparison is bounded by the short name.
 */
function skipNonMarkupElement(html: string, start: number): number {
  const tag = NON_MARKUP_ELEMENT_NAMES.find(name => startsTagAt(html, start, name));
  if (!tag) return start;
  // Skip the whole opening tag first, respecting quoted attribute values.
  // Otherwise `<script data-note="</script>">` would look terminated at the
  // quoted string and the rest of the script body would be scanned as markup,
  // which can fabricate a closed root or hide a real one that follows.
  let cursor = skipTag(html, start);
  while (cursor < html.length) {
    const next = html.indexOf('<', cursor);
    if (next === -1) return html.length;
    if (html.charCodeAt(next + 1) === 47
      && html.slice(next + 2, next + 2 + tag.length).toLowerCase() === tag) {
      const end = next + 2 + tag.length;
      const boundary = end < html.length ? html.charCodeAt(end) : -1;
      if (tagBoundary(boundary)) return end;
    }
    cursor = next + 1;
  }
  return html.length;
}

/**
 * Count declarative closed shadow roots in raw HTML. The parser consumes and
 * removes `<template shadowrootmode="closed">` during document construction,
 * so the live DOM cannot reveal these roots. This is deliberately a bounded
 * markup scan, not a DOM traversal; false positives only make coverage more
 * conservative, while the explicit response-scan gap prevents false clean
 * results when a body cannot be scanned.
 *
 * The scan is single-pass: a backtracking regex over crawl-controlled markup
 * can degrade to quadratic time when a `<template` start tag never
 * terminates. Attribute boundaries follow HTML rules, so an attribute
 * immediately after a closing quote (`id="x"shadowrootmode="closed"`) is still
 * recognized, and a `>` inside a quoted value never ends the tag early.
 * Script/style/textarea/title contents and comments are skipped so a
 * `<template` string inside them cannot hide or fabricate a real root.
 */
export function countDeclarativeClosedShadowRoots(html: string): number {
  if (typeof html !== 'string' || !html) return 0;
  let count = 0;
  let i = 0;
  while (i < html.length && count < 1000) {
    const next = html.indexOf('<', i);
    if (next === -1) break;
    i = next;
    // Comments are not markup; a template-looking string inside one is inert.
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      if (end === -1) break;
      i = end + 3;
      continue;
    }
    const afterRawText = skipNonMarkupElement(html, i);
    if (afterRawText !== i) {
      i = afterRawText;
      continue;
    }
    // `<templatex>` is not the template element. Continue after the name so
    // a later real `<template` is still found without rescanning this one.
    if (!startsTagAt(html, i, 'template')) {
      const nextCode = i + 1 < html.length ? html.charCodeAt(i + 1) : -1;
      const tagStart = (nextCode >= 65 && nextCode <= 90)
        || (nextCode >= 97 && nextCode <= 122)
        || nextCode === 47 || nextCode === 33 || nextCode === 63;
      // A `<` inside a quoted attribute is text, not a raw-text element start.
      // Skip genuine tags as a unit so the next candidate is real markup.
      i = tagStart ? skipTag(html, i) : i + 1;
      continue;
    }
    let cursor = i + '<template'.length;
    let closedShadowRoot = false;
    let terminated = false;
    while (cursor < html.length) {
      while (cursor < html.length && isMarkupWhitespace(html.charCodeAt(cursor))) cursor++;
      if (cursor >= html.length) break;
      const code = html.charCodeAt(cursor);
      if (code === 62) { cursor++; terminated = true; break; }
      if (code === 47) { cursor++; continue; }
      const nameStart = cursor;
      while (cursor < html.length) {
        const nameCode = html.charCodeAt(cursor);
        if (isMarkupWhitespace(nameCode) || nameCode === 61 || nameCode === 62 || nameCode === 47
          || nameCode === 34 || nameCode === 39) break;
        cursor++;
      }
      if (cursor === nameStart) { cursor++; continue; }
      const attributeName = html.slice(nameStart, cursor).toLowerCase();
      while (cursor < html.length && isMarkupWhitespace(html.charCodeAt(cursor))) cursor++;
      let valueStart = cursor;
      let valueEnd = cursor;
      if (cursor < html.length && html.charCodeAt(cursor) === 61) {
        cursor++;
        while (cursor < html.length && isMarkupWhitespace(html.charCodeAt(cursor))) cursor++;
        const quote = cursor < html.length ? html.charCodeAt(cursor) : -1;
        if (quote === 34 || quote === 39) {
          cursor++;
          valueStart = cursor;
          while (cursor < html.length && html.charCodeAt(cursor) !== quote) cursor++;
          valueEnd = cursor;
          if (cursor < html.length) cursor++;
        } else {
          valueStart = cursor;
          while (cursor < html.length) {
            const valueCode = html.charCodeAt(cursor);
            if (isMarkupWhitespace(valueCode) || valueCode === 62) break;
            cursor++;
          }
          valueEnd = cursor;
        }
      }
      if (attributeName === 'shadowrootmode' || attributeName === 'shadowroot') {
        let value = html.slice(valueStart, valueEnd).toLowerCase();
        if (value.endsWith('/')) value = value.slice(0, -1);
        if (value === 'closed') closedShadowRoot = true;
      }
    }
    if (!terminated) break;
    if (closedShadowRoot) count++;
    i = cursor;
  }
  return count;
}

interface DeclarativeShadowPageScan {
  documents: number;
  closedRoots: number;
  gaps: number;
  /** Every in-flight main-document body read in this generation. A JS
   * redirect can emit more than one; awaiting only the latest would silently
   * drop the other body's closed roots. */
  pending: Set<Promise<void>>;
  generation: number;
  observed: boolean;
}

const DECLARATIVE_SHADOW_SCAN_PAGES = new WeakMap<object, DeclarativeShadowPageScan>();

interface RenderedShadowScanResponseLike {
  url(): string;
  status(): number;
  headers(): Record<string, string>;
  request(): { resourceType(): string; frame(): unknown };
  text(): Promise<string>;
}

interface RenderedShadowScanPageLike {
  on(event: 'response', listener: (response: RenderedShadowScanResponseLike) => void): void;
}

/**
 * Install a per-page main-document response scan before navigation. Called
 * from preNavigationHooks so the response event is observed even though the
 * request handler starts only after the document has loaded. The listener is
 * installed once per page; beginRenderedDeclarativeShadowScan resets the
 * generation for each navigation so a reused page cannot double count.
 */
export function beginRenderedDeclarativeShadowScan(page: RenderedShadowScanPageLike): void {
  let scan = DECLARATIVE_SHADOW_SCAN_PAGES.get(page as object);
  if (!scan) {
    scan = { documents: 0, closedRoots: 0, gaps: 0, pending: new Set(), generation: 0, observed: false };
    DECLARATIVE_SHADOW_SCAN_PAGES.set(page as object, scan);
    const mainFrame = () => {
      try { return (page as unknown as { mainFrame(): unknown }).mainFrame(); } catch { return null; }
    };
    page.on('response', response => {
      try {
        const request = response.request();
        if (request.resourceType() !== 'document') return;
        if (request.frame() !== mainFrame()) return;
        if (!/^https?:/i.test(response.url())) return;
        const status = response.status();
        // Redirect/empty responses carry no document body to scan; the final
        // committed document is the one that matters.
        if ((status >= 300 && status < 400) || status === 204 || status === 205) return;
        scan!.observed = true;
        const headers = response.headers();
        const declaredLength = Number(headers['content-length']);
        // A declared length above the cap is the only pre-read rejection. A
        // chunked response has no content-length, and a compressed response's
        // declared length is its compressed size; treating those as gaps made
        // ordinary gzip/br/chunked pages permanently BOUNDED and retryable.
        // Read them and enforce the same cap on the decoded text below.
        if (declaredLength < 0 || declaredLength > DECLARATIVE_SHADOW_SCAN_MAX_BYTES) {
          scan!.gaps++;
          return;
        }
        const generation = scan!.generation;
        const pendingSet = scan!.pending;
        const bodyRead = response.text().then(html => {
          if (scan!.generation !== generation) return;
          // Defend against a server that under-declares its body. The read has
          // already allocated by this point, but the count must not claim a
          // complete scan of a body beyond the configured bound.
          if (Buffer.byteLength(html, 'utf8') > DECLARATIVE_SHADOW_SCAN_MAX_BYTES) {
            scan!.gaps++;
            return;
          }
          scan!.documents++;
          scan!.closedRoots += countDeclarativeClosedShadowRoots(html);
        }).catch(() => {
          if (scan!.generation === generation) scan!.gaps++;
        }).finally(() => {
          // Remove only this body read. A later response in the same
          // generation keeps its own promise pending; clearing the whole
          // pending state here would let readRenderedDeclarativeShadowScan
          // return without awaiting it.
          pendingSet.delete(bodyRead);
        });
        pendingSet.add(bodyRead);
      } catch {
        scan!.gaps++;
      }
    });
  }
  scan.generation++;
  scan.documents = 0;
  scan.closedRoots = 0;
  scan.gaps = 0;
  // Old generation promises delete from their captured set only; a new
  // navigation starts with a clean in-flight set.
  scan.pending = new Set();
  scan.observed = false;
}

/**
 * Read the current navigation's declarative-shadow scan. Waiting is bounded:
 * a response body that is still unavailable after the timeout is a scan gap,
 * not an assumed empty document.
 */
export async function readRenderedDeclarativeShadowScan(
  page: object,
  timeoutMs = 1_000,
): Promise<{ documents: number; closedRoots: number; gaps: number }> {
  const scan = DECLARATIVE_SHADOW_SCAN_PAGES.get(page);
  if (!scan) return { documents: 0, closedRoots: 0, gaps: 1 };
  if (scan.pending.size > 0) {
    await Promise.race([
      Promise.all([...scan.pending]),
      new Promise<void>(resolve => setTimeout(resolve, Math.max(0, timeoutMs))),
    ]);
  }
  const gaps = scan.gaps
    + (scan.observed ? 0 : 1)
    + (scan.pending.size > 0 ? 1 : 0);
  return { documents: scan.documents, closedRoots: scan.closedRoots, gaps };
}

export interface RenderedOpenShadowSnapshot {
  /** Bounded visible/text content from open shadow roots. */
  text: string;
  /** Bounded absolute hrefs from anchors inside open shadow roots. */
  hrefs: string[];
  /** Number of open roots traversed. */
  roots: number;
  /** True when a root, node, href, or character bound stopped traversal. */
  truncated: boolean;
}

/**
 * Bounded open-shadow traversal for invite discovery. Playwright selectors
 * already pierce open roots for clicking, but `page.content()` does not
 * serialize them, so a Discord invite placed only inside an open root was
 * previously missed. This walker visits a bounded number of roots/nodes and
 * returns text plus anchor hrefs; closed roots stay inaccessible by design.
 *
 * Self-contained: Playwright serializes this function into the page.
 */
export function collectRenderedOpenShadowContent(): RenderedOpenShadowSnapshot {
  const maxRoots = 64;
  const maxNodes = 4_000;
  const maxChars = 200_000;
  const maxHrefs = 256;
  const maxDepth = 4;
  // Light-DOM host discovery bound. It is deliberately far above ordinary
  // page sizes: a lower bound made every page with a few thousand elements a
  // permanent interaction gap even when it had no shadow DOM at all.
  const maxLightElements = 50_000;
  const textParts: string[] = [];
  const hrefs: string[] = [];
  let chars = 0;
  let nodes = 0;
  let roots = 0;
  let hostsSeen = 0;
  let truncated = false;
  const queue: Array<{ root: ShadowRoot; depth: number }> = [];
  const root = document.body || document.documentElement;
  if (!root) return { text: '', hrefs, roots, truncated };
  const lightWalker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let lightNode = lightWalker.nextNode();
  let lightExamined = 0;
  while (lightNode && lightExamined < maxLightElements) {
    lightExamined++;
    const shadow = (lightNode as HTMLElement).shadowRoot;
    if (shadow) {
      hostsSeen++;
      if (queue.length < maxRoots) queue.push({ root: shadow, depth: 1 });
      else truncated = true;
    }
    lightNode = lightWalker.nextNode();
  }
  // Host discovery stopped before the end of the document, so a host (and its
  // invite) may exist beyond the bound. This remains a coverage gap even when
  // no host was seen yet: the first host can appear after the bound. Large
  // ordinary pages therefore stay partial rather than being certified clean.
  if (lightNode) truncated = true;
  while (queue.length && nodes < maxNodes && chars < maxChars) {
    const entry = queue.shift()!;
    roots++;
    const walker = document.createTreeWalker(entry.root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && nodes < maxNodes && chars < maxChars) {
      nodes++;
      if (node.nodeType === Node.TEXT_NODE) {
        const value = (node.nodeValue || '').replace(/\s+/g, ' ').trim();
        if (value) {
          const slice = value.slice(0, Math.max(0, maxChars - chars));
          if (slice) {
            textParts.push(slice);
            chars += slice.length + 1;
          }
          if (slice.length < value.length) truncated = true;
        }
      } else {
        const element = node as Element;
        const nested = (element as HTMLElement).shadowRoot;
        if (nested) {
          if (entry.depth < maxDepth && queue.length + roots < maxRoots) {
            queue.push({ root: nested, depth: entry.depth + 1 });
          } else {
            truncated = true;
          }
        }
        const rawHref = element.getAttribute('href')
          || element.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
          || '';
        if (rawHref) {
          if (hrefs.length >= maxHrefs) {
            truncated = true;
          } else {
            try {
              hrefs.push(new URL(rawHref, element.baseURI || document.baseURI).toString());
            } catch {
              hrefs.push(rawHref);
            }
          }
        }
      }
      node = walker.nextNode();
    }
    if (node) truncated = true;
  }
  if (queue.length) truncated = true;
  return { text: textParts.join(' ').slice(0, maxChars), hrefs, roots, truncated };
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
  const probeWindow = window as unknown as { __renderedClosedShadowRootCount?: unknown };
  const closedShadowRootCount = Math.max(0, Math.min(1000, Math.floor(Number(probeWindow.__renderedClosedShadowRootCount) || 0)));
  return {
    frameCount,
    shadowRootCount,
    closedShadowRootCount,
    baseHrefPresent: !!document.querySelector('base[href]'),
    documentTimeOrigin: timeOrigin,
  };
}

/**
 * Per-document maxima. Interactions can reveal contexts incrementally, and a
 * later snapshot may be smaller than an earlier one (the closed-root probe is
 * cumulative, but frame/shadow counts are live), so never overwrite a larger
 * observation with a smaller one.
 */
export function mergeRenderedPageContextCounts(
  prior: RenderedPageContextCounts | undefined,
  next: Partial<RenderedPageContextCounts> | null | undefined,
): RenderedPageContextCounts {
  const count = (value: unknown): number => Math.max(0, Math.floor(Number(value)) || 0);
  return {
    frameCount: Math.max(prior?.frameCount || 0, count(next?.frameCount)),
    shadowRootCount: Math.max(prior?.shadowRootCount || 0, count(next?.shadowRootCount)),
    closedShadowRootCount: Math.max(prior?.closedShadowRootCount || 0, count(next?.closedShadowRootCount)),
    baseHrefPresent: (prior?.baseHrefPresent || false) || next?.baseHrefPresent === true,
  };
}

/**
 * Crawl counters sum per-document maxima, so a click that navigates to another
 * document contributes its contexts instead of replacing the original page's.
 */
export function sumRenderedPageContextCounts(
  values: Iterable<RenderedPageContextCounts>,
): RenderedPageContextCounts {
  const total: RenderedPageContextCounts = {
    frameCount: 0,
    shadowRootCount: 0,
    closedShadowRootCount: 0,
    baseHrefPresent: false,
  };
  const count = (value: unknown): number => Math.max(0, Math.floor(Number(value)) || 0);
  for (const value of values) {
    total.frameCount += count(value.frameCount);
    total.shadowRootCount += count(value.shadowRootCount);
    total.closedShadowRootCount += count(value.closedShadowRootCount);
    total.baseHrefPresent = total.baseHrefPresent || value.baseHrefPresent === true;
  }
  return total;
}

export interface RenderedAnchorClickSkipOptions {
  /** True while the bounded cross-origin pass will pursue eligible
   * destinations. Cross-host anchors are then enqueue-owned, not clicked. */
  crossOriginPursued?: boolean;
  /**
   * Normalized destinations already enqueued by the cross-origin/popup/reveal
   * passes. A re-enumeration must not turn an already-queued hub into a click:
   * the click would navigate to a page the crawl already owns and spend the
   * remaining control budget on a duplicate fetch. A callback lets callers
   * expose live queues that grow while the click loop runs.
   */
  queuedDestinations?: ReadonlySet<string> | ((normalizedUrl: string) => boolean);
}

export function isSkippableNavigableAnchorClick(
  target: Pick<RenderedControlTarget, 'href'> & { text?: string; newContext?: boolean },
  pageUrl: string,
  options: RenderedAnchorClickSkipOptions = {},
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
  // A destination already enqueued (cross-origin hub, popup, or revealed
  // same-origin link) is owned by that pass. Clicking it would navigate to a
  // page the crawl already fetches, duplicating work and spending the control
  // budget on a destination whose content is already covered.
  const visitKey = normalizeVisitUrl(absolute.toString());
  if (visitKey) {
    const queued = options.queuedDestinations;
    if (typeof queued === 'function' ? queued(visitKey) : queued?.has(visitKey)) return true;
  }
  if (absolute.origin !== page.origin) {
    // A direct invite URL is terminal evidence already retained from its
    // text+href; opening it adds no discovery and spends the page budget.
    if (isDiscordDestinationUrl(absolute.toString())) return true;
    // When the bounded cross-origin pass will pursue eligible destinations,
    // that pass owns them; a click would navigate the document twice (once
    // for the click, once for the enqueued page). Callers that omit the option
    // keep the legacy skip (the pass is assumed to own cross-host targets).
    if (options.crossOriginPursued !== false) return true;
    // Pursuit is OFF or the crawl-wide cap is exhausted. Clicking an eligible
    // community/aggregator destination is then the only remaining discovery
    // path (for example linktr.ee/beacons hubs), so keep it in the click set.
    // Unrelated formats, security rejections, and vendor links stay skipped.
    if (target.newContext) {
      // A cross-origin destination that opens a new browsing context is
      // captured as a popup and policy-dropped without inspecting its
      // content. Clicking it would spend the click budget and issue a request
      // whose response is discarded, so it is never a discovery path. The
      // enqueue budget/policy accounting owns the destination instead.
      return true;
    }
    return !shouldEnqueueRenderedCrossOriginLink({
      url: absolute.toString(),
      currentUrl: page.toString(),
      anchorText: target.text || '',
    });
  }
  // Same admission predicate as the enqueue path: a same-origin anchor that
  // the enqueue rule would reject must still be clicked, otherwise it is
  // neither clicked nor enqueued and discovery could be lost.
  return shouldEnqueueRenderedCommunityLink(absolute.toString());
}

/**
 * Retain the live text+href of every anchor excluded from clicking. Page
 * content snapshots can predate a JS-inserted invite, and a skipped anchor is
 * never passed through attemptRenderedControlClick, so this is the only place
 * that late DOM state reaches candidate extraction. Returns the number of
 * anchors retained (bounded by the caller's enumerated control set).
 */
export function retainSkippableAnchorEvidence(
  controls: readonly Pick<RenderedControlTarget, 'text' | 'href'>[],
  pageUrl: string,
  retain: (text: string, pageUrl: string) => void,
  options: RenderedAnchorClickSkipOptions = {},
): number {
  let retained = 0;
  for (const control of controls) {
    if (!isSkippableNavigableAnchorClick(control, pageUrl, options)) continue;
    retain(`${control.text} ${control.href || ''}`, pageUrl);
    retained++;
  }
  return retained;
}

/**
 * Whether the current page is still the seed document whose required links
 * were snapshotted. A same-document history/query update keeps the document
 * and any links revealed after the update, while a real navigation commits a
 * new document whose links are enqueue-owned and must not become required
 * obligations of the seed. Document identity wins when both reads succeed;
 * normalized URL comparison is the fail-closed fallback.
 */
export function isSameSeedDocument(
  seedIdentity: unknown,
  currentIdentity: unknown,
  seedUrl: string,
  currentUrl: string,
): boolean {
  if (seedIdentity !== null && seedIdentity !== undefined
    && currentIdentity !== null && currentIdentity !== undefined) {
    return seedIdentity === currentIdentity;
  }
  return normalizeVisitUrl(currentUrl) === normalizeVisitUrl(seedUrl);
}

/**
 * True when a structural href resolves to a different hostname. The rendered
 * enqueue path uses Crawlee's `same-hostname` strategy, which follows HTTP and
 * HTTPS (and any port) on the same hostname, so origin comparison would
 * mislabel an admissible scheme/port switch as cross-origin.
 */
export function isCrossHostnameStructuralNavigation(href: string, pageUrl: string): boolean {
  const raw = (href || '').trim();
  if (!raw) return false;
  let page: URL;
  let absolute: URL;
  try {
    page = new URL(pageUrl);
    absolute = new URL(raw, pageUrl);
  } catch {
    return false;
  }
  if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') return false;
  return absolute.hostname.toLowerCase() !== page.hostname.toLowerCase();
}

/**
 * P1.6: decide whether an enqueue candidate is a cross-origin destination the
 * shared destination policy admits. Same-origin candidates are handled by the
 * existing same-host hint pass and are deliberately rejected here. Discord
 * destinations are invite candidates, not navigation surfaces, so they stay
 * out of the rendered page budget. Admission failures and weak/generic labels
 * never open a new host.
 */
export function shouldEnqueueRenderedCrossOriginLink(input: {
  url: string;
  currentUrl: string;
  anchorText?: string;
}): boolean {
  let current: URL;
  let target: URL;
  try {
    current = new URL(input.currentUrl);
    target = new URL(input.url);
  } catch {
    return false;
  }
  if (target.origin === current.origin) return false;
  if (isNativeDiscordInviteUrl(target.toString())) return false;
  return shouldFollowDestination({
    url: target.toString(),
    currentUrl: current.toString(),
    anchorText: input.anchorText || '',
  }).eligible;
}

/**
 * Count collector overflow that is worth reporting as a coverage gap. A
 * collection that stopped at its bound only hides navigation when an omitted
 * link is a direct Discord invite or a destination the community/destination
 * policy would pursue. Counting every omitted http(s) anchor made pages with
 * hundreds of affiliate/social/vendor links permanently `BOUNDED`.
 */
export function countPursuableRenderedOverflow(
  candidates: readonly RenderedCrossOriginCandidate[],
  currentUrl: string,
): number {
  return pursuableRenderedOverflowUrls(candidates, currentUrl).size;
}

/**
 * URL-deduplicated subset of an overflow sample that policy would pursue.
 * Callers merge pre-click and post-click samples before publishing, so a
 * destination present in both snapshots is counted once even when a click did
 * not replace the document. Each candidate is classified against the document
 * that actually contained it (`sourceUrl`), preserving the pre-click origin
 * after a click navigates elsewhere.
 */
export function pursuableRenderedOverflowUrls(
  candidates: readonly RenderedCrossOriginCandidate[],
  currentUrl: string,
): Set<string> {
  const urls = new Set<string>();
  for (const candidate of candidates) {
    const url = String(candidate.url || '').trim();
    if (!url) continue;
    const key = normalizeVisitUrl(url) || url;
    if (urls.has(key)) continue;
    if (isDiscordDestinationUrl(url)
      && extractDiscordCandidates(url).some(entry => entry.nativeInviteCode)) {
      urls.add(key);
      continue;
    }
    if (shouldEnqueueRenderedCrossOriginLink({
      url,
      currentUrl: candidate.sourceUrl || currentUrl,
      anchorText: candidate.text || '',
    })) {
      urls.add(key);
    }
  }
  return urls;
}

export interface RenderedCrossOriginCandidate {
  url: string;
  text: string;
  /**
   * Page URL where the anchor was observed. The pre-click snapshot keeps the
   * original document origin even when a later click navigates away; without
   * it, the post-click URL would wrongly classify the earlier snapshot's
   * candidates as same-origin.
   */
  sourceUrl?: string;
}

/**
 * A destination can appear in a bounded overflow sample with a strong community
 * label and later in a snapshot's visible candidate window with a weaker label
 * (or none). Recovering it as visible must not discard the evidence that made
 * it pursuable: fold the earlier labels into the visible candidate, then remove
 * the URL from the overflow gap. Otherwise a weak first anchor can hide the
 * community destination and let an unexamined page resolve clean.
 */
export function recoverRenderedOverflowCandidate(
  candidate: RenderedCrossOriginCandidate,
  labelsByKey: ReadonlyMap<string, readonly string[]>,
  overflowEligible: Set<string>,
): void {
  const key = normalizeVisitUrl(candidate.url) || String(candidate.url || '').trim();
  if (!key) return;
  const labels = labelsByKey.get(key);
  if (labels?.length) {
    const texts = [String(candidate.text || '').trim(), ...labels].filter(Boolean);
    candidate.text = [...new Set(texts)].join(' ');
  }
  overflowEligible.delete(key);
}

/**
 * Bounded collector result. `truncated` counts eligible destinations beyond
 * the collector limit (up to a bounded 500-candidate overflow sample, so a
 * pathological page cannot make the diagnostic itself expensive). Callers
 * must publish any overflow as a coverage gap because those URLs were
 * discovered but never evaluated or enqueued.
 */
export interface RenderedCandidateCollection {
  candidates: RenderedCrossOriginCandidate[];
  /**
   * Overflow sample (bounded to 500). Callers apply the destination policy to
   * this sample so unrelated outbound links beyond the collector limit do not
   * turn an otherwise clean page into a coverage gap.
   */
  overflowCandidates: RenderedCrossOriginCandidate[];
  truncated: number;
  /**
   * True when the bounded overflow sample was filled. Anchors after the sample
   * were never classified, so even an all-irrelevant sample cannot prove that
   * no eligible community destination remains.
   */
  overflowSampleFilled?: boolean;
}

export interface RenderedLinkBaseline {
  links: Set<string>;
  /**
   * True when the collection stopped at its bound. A saturated baseline
   * cannot distinguish static overflow from interaction-revealed links, so
   * the revealed-link pass must not treat that overflow as new work.
   */
  saturated: boolean;
}

/** Build the per-document link baseline used to detect interaction-revealed
 * same-origin destinations. */
export function buildRenderedLinkBaseline(collection: RenderedCandidateCollection): RenderedLinkBaseline {
  const links = new Set<string>();
  for (const candidate of collection.candidates) {
    const key = normalizeVisitUrl(candidate.url);
    if (key) links.add(key);
  }
  return { links, saturated: collection.truncated > 0 };
}

/**
 * A saturated baseline cannot tell static overflow from links an interaction
 * revealed. When an interaction actually occurred on that document, one
 * coverage gap is warranted (once per document): otherwise a menu-revealed
 * generic destination could be certified absent. A document with no
 * interaction stays clean, so a page with 500+ static links does not become
 * permanently `BOUNDED`.
 */
export function shouldRecordSaturatedBaselineGap(
  baseline: RenderedLinkBaseline,
  interactionOccurred: boolean,
  recordedDocuments: ReadonlySet<string>,
  documentKey: string,
): boolean {
  return baseline.saturated && interactionOccurred && !recordedDocuments.has(documentKey);
}

export interface RenderedCrossOriginEnqueuePlan {
  admitted: string[];
  alreadyVisited: number;
  duplicate: number;
  budget: number;
  /** Destinations rejected by the rendered cross-origin enqueue rule,
   * including same-origin links observed from a pre-click snapshot. */
  disallowed: number;
  /**
   * Outbound destinations the community-evidence policy rejected. They are
   * not eligible community destinations, so they are diagnostic only and must
   * never turn an otherwise complete run into a policy exclusion.
   */
  irrelevant: number;
  /**
   * Destinations that passed community evidence but failed the shared crawl
   * admission boundary (format/security). Also diagnostic only: they are not
   * unexamined navigation surfaces.
   */
  admissionRejected: number;
  /** Discord destinations are terminal invite candidates, not unexamined
   * navigation; they are retained from href/text and never counted as a
   * policy exclusion. */
  discordDestinations: number;
}

/**
 * Browser-context collection for the P1.6 cross-origin pass. Self-contained:
 * Playwright serializes this function into the page. Same-origin and
 * non-HTTP(S) anchors are discarded before the candidate bound, so a page full
 * of internal navigation cannot crowd out a later cross-origin community link.
 * Visible text is carried because Crawlee's enqueueLinks exposes only hrefs.
 */
export function collectRenderedCrossOriginCandidates(
  nodes: Element[],
  currentUrl: string,
  limit = 500,
): RenderedCandidateCollection {
  const candidates: RenderedCrossOriginCandidate[] = [];
  const overflowCandidates: RenderedCrossOriginCandidate[] = [];
  let truncated = 0;
  // Bounded overflow sample. Kept inside the browser-context function because
  // Playwright serializes its source; a module-level constant would not exist
  // in the page. The collector still keeps only the first `limit` candidates.
  const overflowSampleMax = 500;
  let overflowSampleFilled = false;
  let currentOrigin = '';
  try {
    currentOrigin = new URL(currentUrl).origin;
  } catch {
    return { candidates, overflowCandidates, truncated, overflowSampleFilled };
  }
  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
    const node = nodes[nodeIndex];
    const anchor = node as HTMLAnchorElement;
    // SVG anchors expose `href` as an `SVGAnimatedString`, so read the string
    // attribute first and resolve it against the document base URL. Falling
    // straight through to `anchor.href` would throw for SVG and silently drop
    // a real community link.
    const attrHref = typeof anchor.getAttribute === 'function' ? (anchor.getAttribute('href') || '') : '';
    const rawHref = attrHref || (typeof anchor.href === 'string' ? anchor.href : '');
    // `document.baseURI` resolves relative SVG/base-href anchors in the page.
    // Direct unit calls have no DOM, so fall back to the crawl URL; in a
    // browser this branch is never taken.
    const baseUrl = typeof document !== 'undefined' && document.baseURI ? document.baseURI : currentUrl;
    let target: URL;
    try {
      target = new URL(rawHref, baseUrl);
    } catch {
      continue;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') continue;
    if (target.origin === currentOrigin) continue;
    if (candidates.length >= limit) {
      if (truncated < overflowSampleMax) {
        truncated++;
        overflowCandidates.push({
          url: target.toString(),
          text: (anchor.textContent || '').trim().slice(0, 200),
          sourceUrl: currentUrl,
        });
        if (truncated >= overflowSampleMax) {
          // The sample is full. Only a page ending here is fully classified;
          // otherwise later anchors were never examined.
          overflowSampleFilled = nodeIndex < nodes.length - 1;
          if (overflowSampleFilled) break;
        }
        continue;
      }
      // The sample filled on an earlier anchor; this anchor (and any after
      // it) was never classified.
      overflowSampleFilled = true;
      break;
    }
    candidates.push({
      url: target.toString(),
      text: (anchor.textContent || '').trim().slice(0, 200),
      sourceUrl: currentUrl,
    });
  }
  return { candidates, overflowCandidates, truncated, overflowSampleFilled };
}

/**
 * P1.6 planner: pair each discovered URL with its visible anchor text before
 * the destination policy runs. Crawlee's enqueueLinks only carries hrefs, so
 * a transformRequestFunction cannot see the label that the policy needs for
 * generic-path community links. Bounded input, one pass, no mutation of the
 * caller's visited/queued sets. The caller publishes the counts through the
 * existing closed drop reasons.
 */
export function planRenderedCrossOriginEnqueues(input: {
  candidates: readonly RenderedCrossOriginCandidate[];
  currentUrl: string;
  alreadyVisited: ReadonlySet<string>;
  queued: ReadonlySet<string>;
  maxEnqueues?: number;
}): RenderedCrossOriginEnqueuePlan {
  const remaining = Math.max(0, Math.min(
    input.maxEnqueues === undefined ? MAX_RENDERED_CROSS_ORIGIN_ENQUEUES : input.maxEnqueues,
    MAX_RENDERED_CROSS_ORIGIN_ENQUEUES,
  ));
  const plan: RenderedCrossOriginEnqueuePlan = {
    admitted: [],
    alreadyVisited: 0,
    duplicate: 0,
    budget: 0,
    disallowed: 0,
    irrelevant: 0,
    admissionRejected: 0,
    discordDestinations: 0,
  };
  const planned = new Set<string>();
  // The pre-click and post-click snapshots overlap: merge them by URL before
  // accounting so an anchor present in both is not counted twice in drop
  // telemetry (canary monitoring reads these counters). All labels for a URL
  // are kept and evaluated together: a weak first anchor ("About") must not
  // hide a later community label ("Club") for the same destination. The first
  // occurrence wins for ordering and therefore preserves the pre-click
  // discovery origin.
  const grouped = new Map<string, { url: string; labels: string[]; sourceUrl?: string }>();
  const order: string[] = [];
  for (const candidate of input.candidates) {
    const url = String(candidate.url || '').trim();
    if (!url) {
      plan.irrelevant++;
      continue;
    }
    const visitKey = normalizeVisitUrl(url) || url;
    const existing = grouped.get(visitKey);
    if (existing) {
      const label = String(candidate.text || '').trim();
      if (label) existing.labels.push(label);
      continue;
    }
    grouped.set(visitKey, {
      url,
      labels: String(candidate.text || '').trim() ? [String(candidate.text || '').trim()] : [],
      sourceUrl: candidate.sourceUrl,
    });
    order.push(visitKey);
  }
  for (const visitKey of order) {
    const candidate = grouped.get(visitKey)!;
    const url = candidate.url;
    if (input.alreadyVisited.has(visitKey)) {
      plan.alreadyVisited++;
      continue;
    }
    if (input.queued.has(visitKey) || planned.has(visitKey)) {
      plan.duplicate++;
      continue;
    }
    // A Discord destination is terminal invite evidence only when it actually
    // carries an extractable invite code. Generic `discord.com`/`discord.gg`
    // pages (a user profile, the marketing home, a support article) are
    // ordinary destinations and stay on the normal policy path.
    if (isDiscordDestinationUrl(url)
      && extractDiscordCandidates(url).some(candidate => candidate.nativeInviteCode)) {
      plan.discordDestinations++;
      continue;
    }
    // Native invite URLs are terminal evidence retained by the page scan, not
    // navigation surfaces. Skip only those before accounting: redirect
    // shorteners and directory pages carry no native code, so they must pass
    // the destination policy to be resolved through a click/enqueue.
    if (isNativeDiscordInviteUrl(url)) continue;
    // Same-origin links are owned by the existing same-host hint pass and the
    // interaction-revealed pass; this planner must not admit them. Classify
    // against the document that produced the anchor: a click that navigated
    // away must not retroactively make the pre-click snapshot look internal.
    try {
      if (new URL(url).origin === new URL(String(candidate.sourceUrl || input.currentUrl)).origin) {
        plan.disallowed++;
        continue;
      }
    } catch {
      plan.admissionRejected++;
      continue;
    }
    // Policy first: only an eligible community destination consumes or
    // reports the bounded hub cap. Weak/generic outbound links are policy
    // rejections, not budget exclusions, so they must not crowd out a later
    // eligible destination.
    const decision = shouldFollowDestination({
      url,
      currentUrl: input.currentUrl,
      anchorText: candidate.labels.join(' '),
    });
    if (!decision.eligible) {
      // Keep unrelated links and admission/security rejections out of the
      // coverage exclusion counter: neither is an eligible community
      // destination left unvisited by the pursuit policy.
      if (decision.reason === 'admission-rejected') plan.admissionRejected++;
      else plan.irrelevant++;
      continue;
    }
    if (plan.admitted.length >= remaining) {
      plan.budget++;
      continue;
    }
    if (!shouldEnqueueRenderedCrossOriginLink({
      url,
      // Each candidate keeps the origin of the document that produced it. A
      // click that navigates to another page must not retroactively make the
      // pre-click snapshot's cross-origin links look same-origin.
      currentUrl: String(candidate.sourceUrl || input.currentUrl),
      anchorText: candidate.labels.join(' '),
    })) {
      plan.disallowed++;
      continue;
    }
    planned.add(visitKey);
    plan.admitted.push(url);
  }
  return plan;
}

/**
 * Browser-context collection for interaction-revealed same-origin navigation.
 * Self-contained because Playwright serializes it into the page. Only HTTP(S)
 * anchors that resolve to a different document on the current origin are
 * returned; fragment-only anchors are in-page disclosures, not navigation.
 */
export function collectRenderedSameOriginCandidates(
  nodes: Element[],
  currentUrl: string,
  limit = 500,
): RenderedCandidateCollection {
  const candidates: RenderedCrossOriginCandidate[] = [];
  const overflowCandidates: RenderedCrossOriginCandidate[] = [];
  let truncated = 0;
  // Self-contained overflow bound; see the cross-origin collector.
  const overflowSampleMax = 500;
  let overflowSampleFilled = false;
  let currentOrigin = '';
  let currentIdentity = '';
  try {
    const current = new URL(currentUrl);
    currentOrigin = current.origin;
    current.hash = '';
    currentIdentity = current.toString();
  } catch {
    return { candidates, overflowCandidates, truncated, overflowSampleFilled };
  }
  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
    const node = nodes[nodeIndex];
    const anchor = node as HTMLAnchorElement;
    let target: URL;
    try {
      target = new URL(anchor.href || '');
    } catch {
      continue;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') continue;
    if (target.origin !== currentOrigin) continue;
    target.hash = '';
    if (target.toString() === currentIdentity) continue;
    if (candidates.length >= limit) {
      if (truncated < overflowSampleMax) {
        truncated++;
        overflowCandidates.push({
          url: target.toString(),
          text: (anchor.textContent || '').trim().slice(0, 200),
        });
        if (truncated >= overflowSampleMax) {
          // The sample is full. Only a page ending here is fully classified;
          // otherwise later anchors were never examined.
          overflowSampleFilled = nodeIndex < nodes.length - 1;
          if (overflowSampleFilled) break;
        }
        continue;
      }
      // The sample filled on an earlier anchor; this anchor (and any after
      // it) was never classified.
      overflowSampleFilled = true;
      break;
    }
    candidates.push({
      url: target.toString(),
      text: (anchor.textContent || '').trim().slice(0, 200),
    });
  }
  return { candidates, overflowCandidates, truncated, overflowSampleFilled };
}

export interface RenderedRevealedSameOriginPlan {
  admitted: string[];
  alreadyVisited: number;
  duplicate: number;
  hintHandled: number;
  admissionRejected: number;
  budget: number;
}

/**
 * Planner for same-origin links that were absent from the page's
 * pre-interaction snapshot. Interactive disclosure is the evidence that makes
 * a generic path (for example `/resources`) worth one bounded page request;
 * static footer/about links are never admitted by this path. Hint-bearing
 * links remain owned by the existing same-host enqueue pass.
 */
export function planRevealedSameOriginEnqueues(input: {
  candidates: readonly RenderedCrossOriginCandidate[];
  currentUrl: string;
  initialLinks: ReadonlySet<string>;
  alreadyVisited: ReadonlySet<string>;
  queued: ReadonlySet<string>;
  maxEnqueues?: number;
  /**
   * The pre-interaction baseline stopped at its bounded collection limit, so
   * the collector cannot tell static overflow apart from interaction-revealed
   * links. Admitting the overflow would spend the page budget on static
   * navigation and mark large pages permanently `BOUNDED`; the same-host hint
   * pass still owns hint-bearing destinations. Return no admissions.
   */
  baselineSaturated?: boolean;
  /**
   * The caller skipped the same-host hint pass (an optional third-party page
   * bounded by the cross-origin cap), so hint-bearing links are not owned
   * elsewhere. Admit them through this same capped pass instead of dropping
   * them as `hintHandled`.
   */
  hintPassSkipped?: boolean;
}): RenderedRevealedSameOriginPlan {
  const plan: RenderedRevealedSameOriginPlan = {
    admitted: [],
    alreadyVisited: 0,
    duplicate: 0,
    hintHandled: 0,
    admissionRejected: 0,
    budget: 0,
  };
  if (input.baselineSaturated === true) return plan;
  const remaining = Math.max(0, Math.trunc(
    input.maxEnqueues === undefined ? DEFAULT_REVEALED_SAME_ORIGIN_ENQUEUES : input.maxEnqueues,
  ) || 0);
  let current: URL;
  try {
    current = new URL(input.currentUrl);
  } catch {
    return plan;
  }
  const planned = new Set<string>();
  for (const candidate of input.candidates) {
    const url = String(candidate.url || '').trim();
    if (!url) continue;
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      continue;
    }
    if ((target.protocol !== 'http:' && target.protocol !== 'https:') || target.origin !== current.origin) continue;
    const visitKey = normalizeVisitUrl(url) || url;
    if (input.initialLinks.has(visitKey)) continue;
    if (input.alreadyVisited.has(visitKey)) {
      plan.alreadyVisited++;
      continue;
    }
    if (input.queued.has(visitKey) || planned.has(visitKey)) {
      plan.duplicate++;
      continue;
    }
    if (!assessCrawlAdmission(url).eligible) {
      plan.admissionRejected++;
      continue;
    }
    // The same-host hint pass already owns these URLs unless the caller
    // skipped it (optional third-party page); then this bounded pass is the
    // only path that can admit them.
    if (!input.hintPassSkipped && shouldEnqueueRenderedCommunityLink(url)) {
      plan.hintHandled++;
      continue;
    }
    if (plan.admitted.length >= remaining) {
      plan.budget++;
      continue;
    }
    planned.add(visitKey);
    plan.admitted.push(url);
  }
  return plan;
}

/**
 * P1.6 enqueue pass. Extracted from the request handler so the crawl-wide cap,
 * duplicate handling across pages/passes, visible-label plumbing, and the
 * actual `enqueue` call are exercised without a cross-origin network fixture.
 * The caller owns the queued set: it must contain every URL already enqueued
 * by earlier passes, which is what makes the cap crawl-wide.
 */
export async function enqueueRenderedCrossOriginPass(input: {
  collect: () => Promise<RenderedCrossOriginCandidate[]>;
  currentUrl: string;
  alreadyVisited: ReadonlySet<string>;
  queued: Set<string>;
  maxEnqueues?: number;
  enqueue: (urls: string[]) => Promise<void>;
  countDrop: (
    reason: 'already-visited' | 'destination-budget' | 'cross-origin-disallowed' | 'hint-rejected' | 'admission-rejected',
    count: number,
  ) => void;
}): Promise<void> {
  let candidates: RenderedCrossOriginCandidate[] = [];
  try {
    candidates = await input.collect();
  } catch {
    // A control may have replaced or detached the document between the click
    // loop and this pass. Enqueueing nothing is safe; the post-click same-host
    // pass has already run.
    return;
  }
  const plan = planRenderedCrossOriginEnqueues({
    candidates,
    currentUrl: input.currentUrl,
    alreadyVisited: input.alreadyVisited,
    queued: input.queued,
    maxEnqueues: input.maxEnqueues,
  });
  if (plan.alreadyVisited) input.countDrop('already-visited', plan.alreadyVisited);
  // Unrelated/vendor links and format/security rejections are not unexamined
  // community navigation. Count them diagnostically so an ordinary page with a
  // privacy link can still resolve as a clean absence.
  if (plan.irrelevant) input.countDrop('hint-rejected', plan.irrelevant);
  if (plan.admissionRejected) input.countDrop('admission-rejected', plan.admissionRejected);
  if (plan.budget) input.countDrop('destination-budget', plan.budget);
  if (plan.disallowed) input.countDrop('cross-origin-disallowed', plan.disallowed);
  if (!plan.admitted.length) return;
  // Commit the cap identities only after the submission succeeds. A failed
  // enqueue throws out of the request handler; Crawlee then retries the page
  // with this same crawl-wide set. Recording the URLs before the await would
  // make the retry classify them as duplicates and never resubmit them. A
  // partial submission is safe to replay: Crawlee's request queue dedupes
  // already-queued unique keys.
  await input.enqueue(plan.admitted);
  for (const url of plan.admitted) {
    input.queued.add(normalizeVisitUrl(url) || url);
  }
}

/**
 * Identities the cross-origin planner must not re-enqueue: externally supplied
 * already-visited URLs plus every request/final-page identity this crawl has
 * terminally inspected. Without the final identity, a queued shortcut that
 * redirects to a destination later linked directly would spend a second page
 * slot inspecting the same page.
 */
export function renderedCrossOriginVisitedIdentities(
  alreadyVisited: ReadonlySet<string>,
  terminalSuccessUrls: Iterable<string>,
): ReadonlySet<string> {
  const inspected = [...terminalSuccessUrls];
  if (!inspected.length) return alreadyVisited;
  return new Set([...alreadyVisited, ...inspected]);
}

export function isUnrecoveredStructuralNavigation(
  href: string,
  pageUrl: string,
  alreadyVisited: ReadonlySet<string>,
): boolean {
  const raw = (href || '').trim();
  if (!raw) return false;
  let absolute: URL;
  try {
    absolute = new URL(raw, pageUrl);
  } catch {
    return false;
  }
  if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') return false;
  // Cross-origin destinations are recorded in the rendered policy ledger by
  // the handler (`cross-origin-disallowed`); they are not enqueue-owned.
  if (isCrossHostnameStructuralNavigation(raw, pageUrl)) return false;
  const visitKey = normalizeVisitUrl(absolute.toString());
  if (visitKey && alreadyVisited.has(visitKey)) return false;
  if (!assessCrawlAdmission(absolute.toString()).eligible) return false;
  if (shouldEnqueueRenderedCommunityLink(absolute.toString())) return false;
  return true;
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
  options: RenderedAnchorClickSkipOptions = {},
): { toClick: RenderedControlTarget[]; skippedNavigableAnchors: number; evaluationWindow: RenderedControlTarget[]; rotationReplay: number } {
  const cap = Math.max(0, Math.trunc(maxClicks) || 0);
  const windowSize = Math.max(0, Math.trunc(evaluationWindowSize) || 0);
  // Rotate the complete matched pool before applying the evaluation window.
  // Rotating the already-truncated plan would only reorder the same prefix and
  // leave controls 65+ permanently unreachable. A rotation boundary that lands
  // on a hidden control replays only its revealer chain first.
  const { ordered, replay } = planRenderedClickRotation(controls, offset);
  const evaluationWindow = ordered.slice(0, windowSize);
  const eligible: RenderedControlTarget[] = [];
  let skippedNavigableAnchors = 0;
  for (const control of evaluationWindow) {
    if (isSkippableNavigableAnchorClick(control, pageUrl, options)) {
      skippedNavigableAnchors++;
      continue;
    }
    eligible.push(control);
  }
  return {
    toClick: eligible.slice(0, cap),
    skippedNavigableAnchors,
    evaluationWindow,
    rotationReplay: replay,
  };
}

/**
 * Controls outside the bounded evaluation window for this page, using the
 * same rotation as `partitionRenderedClickTargets`. These are the controls that
 * were not examined, so their origins decide whether the overflow is a real
 * coverage gap or only opportunistic disclosures.
 */
export function renderedControlOverflowTargets(
  controls: RenderedControlTarget[],
  pageUrl: string,
  offset = 0,
  evaluationWindowSize = RENDERED_CONTROL_EVALUATION_WINDOW,
): RenderedControlTarget[] {
  const windowSize = Math.max(0, Math.trunc(evaluationWindowSize) || 0);
  if (controls.length <= windowSize) return [];
  const { ordered } = planRenderedClickRotation(controls, offset);
  // Mirror the click planner: a navigable anchor the enqueue path owns is not
  // a click obligation, so it is not an unexamined control when it falls
  // outside the evaluation window. Only the remaining targets are overflow.
  return ordered
    .slice(windowSize)
    .filter(target => !isSkippableNavigableAnchorClick(target, pageUrl));
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
  plan: Pick<ReturnType<typeof partitionRenderedClickTargets>, 'toClick' | 'evaluationWindow' | 'skippedNavigableAnchors' | 'rotationReplay'>,
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
  // The plan may replay a disclosure before the saved offset. The returned
  // value is added to that offset, so progress counts only controls after the
  // replay prefix; replayed controls never advance the rotation.
  const replay = Math.max(0, Math.trunc(plan.rotationReplay) || 0);
  if (examined === 0) {
    return isNavigableOnlyControlWindow(plan, maxClicksPerPage)
      ? Math.max(0, plan.evaluationWindow.length - replay)
      : 0;
  }
  const lastAttempted = plan.toClick[Math.min(examined, plan.toClick.length) - 1];
  if (!lastAttempted) return 0;
  const position = plan.evaluationWindow.findIndex(target =>
    target === lastAttempted || (Boolean(target.marker) && target.marker === lastAttempted.marker)
  );
  return position >= replay ? position - replay + 1 : 0;
}

/**
 * Build the control order for one attempt from a durable rotation offset.
 * The saved position is where the previous attempt stopped, so a hidden
 * control there needs the disclosure that reveals it replayed first. Only
 * that revealer chain is prepended (outermost first for nested disclosures);
 * the attempt then resumes at the saved position, skipping the hidden children
 * between the revealer and it because the attempt that advanced the offset
 * already examined them. Replaying those children instead would starve later
 * ones whenever they fill the click cap.
 *
 * `replay` is the length of that prefix: progress is measured from the saved
 * position, not from the replayed controls.
 */
function planRenderedClickRotation(
  controls: RenderedControlTarget[],
  offset: number,
): { ordered: RenderedControlTarget[]; replay: number } {
  const length = controls.length;
  if (length === 0) return { ordered: [], replay: 0 };
  const start = ((Math.trunc(offset) || 0) % length + length) % length;
  const chain: number[] = [];
  let cursor = start;
  for (let step = 0; step < length; step++) {
    const control = controls[cursor];
    if (!control || !control.hidden || !control.afterMarker) break;
    const revealer = controls.findIndex(candidate => candidate.marker === control.afterMarker);
    if (revealer < 0 || revealer === cursor || chain.indexOf(revealer) !== -1) break;
    chain.push(revealer);
    cursor = revealer;
  }
  const prefixIndices = chain.slice().reverse();
  const prefixSet = new Set(prefixIndices);
  const ordered: RenderedControlTarget[] = [];
  for (let prefixIndex = 0; prefixIndex < prefixIndices.length; prefixIndex++) {
    ordered.push(controls[prefixIndices[prefixIndex]]);
  }
  for (let step = 0; step < length; step++) {
    const index = (start + step) % length;
    if (prefixSet.has(index)) continue;
    ordered.push(controls[index]);
  }
  return { ordered, replay: prefixIndices.length };
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
 * Only an unexamined hint/icon control is evidence-bearing enough to make the
 * page incomplete. Generic structural disclosures are opportunistic: they are
 * clicked when budget allows, but an over-budget disclosure does not turn a
 * common menu/FAQ page into a retryable acquisition gap. Targets without an
 * origin are legacy evidence controls and stay conservative.
 */
export function renderedControlSkipsNeedInteractionGap(
  targets: Array<Pick<RenderedControlTarget, 'origin'>>,
): boolean {
  return targets.some(target => target.origin !== 'disclosure');
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
  options: RenderedAnchorClickSkipOptions = {},
): { toClick: RenderedControlTarget[]; skipped: RenderedControlTarget[]; remainingClickBudget: number } {
  const remainingClickBudget = remainingRenderedClickBudget(maxClicks, clickedThisPage, pendingQueuedTargets);
  const plan = partitionRenderedClickTargets(controls, pageUrl, remainingClickBudget, offset, undefined, options);
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
      && !isSkippableNavigableAnchorClick(target, pageUrl, options);
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
  /**
   * Stable identity for the current document, used to distinguish a real
   * navigation from a same-document history/query update (`pushState`,
   * `replaceState`). Production passes `performance.timeOrigin`, which
   * survives same-document URL changes and changes after a new document
   * commits. When omitted, URL comparison is used (legacy behavior).
   */
  documentIdentity?: () => Promise<unknown>;
  /** Durable per-seed retry rotation, shared with the initial click plan so a
   * retry does not repeatedly select the same DOM-order subset of controls
   * revealed by a previous click. */
  clickOffset?: number;
  /** True while the bounded cross-origin pass will pursue eligible
   * destinations. Cross-host anchors are then enqueue-owned, not clicked. */
  crossOriginPursued?: boolean;
  /** Live view of destinations already enqueued by the cross-origin/popup/
   * reveal passes. Re-enumeration must not click a destination the crawl
   * already owns. */
  queuedDestinations?: RenderedAnchorClickSkipOptions['queuedDestinations'];
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
  /** A click committed a new document and stopped the loop. The replacement
   * page was never enumerated or clicked, so it is not terminal-success
   * evidence for required coverage. */
  documentReplaced: boolean;
  /** The last URL of the document the loop actually processed. Same-document
   * history updates advance it; a click that commits a new document leaves it
   * at the last URL of the replaced document. */
  processedDocumentUrl: string;
  /** The document URL when the loop started, before any same-document update.
   * It was still the inspected document when a later history update or click
   * replacement changed `processedDocumentUrl`. */
  initialDocumentUrl: string;
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
  let documentReplaced = false;
  const initialDocumentUrl = input.pageUrl();
  let processedDocumentUrl = initialDocumentUrl;
  let firstFailedTargetIndex: number | undefined;
  for (let clickIndex = 0; clickIndex < clickTargets.length; clickIndex++) {
    if (clickedThisPage >= input.maxClicksPerPage) {
      // Controls appended by an earlier re-enumeration can remain queued when
      // the click cap is reached. They were never examined, so they are skips,
      // not a clean no-match.
      let cappedSkips = 0;
      const cappedTargets: RenderedControlTarget[] = [];
      for (const target of clickTargets.slice(clickIndex)) {
        const marker = target.marker;
        if (marker && countedSkips.has(marker)) continue;
        if (marker) countedSkips.add(marker);
        cappedSkips++;
        cappedTargets.push(target);
      }
      if (cappedSkips > 0) {
        evidenceControlsSkipped += cappedSkips;
        if (renderedControlSkipsNeedInteractionGap(cappedTargets)) interactionGap = true;
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
    const urlBeforeClick = input.pageUrl();
    const identityBeforeClick = input.documentIdentity
      ? await input.documentIdentity().catch(() => null)
      : undefined;
    if (await input.click(control)) evidenceControlsClicked++;
    else {
      evidenceControlsFailed++;
      // A failed generic disclosure is opportunistic: a hidden mobile menu
      // timing out does not itself mean a community destination went
      // unexamined. Failed hint/icon controls are evidence-bearing and keep
      // the page retryable.
      if (renderedControlSkipsNeedInteractionGap([control])) interactionGap = true;
      if (firstFailedTargetIndex === undefined) firstFailedTargetIndex = clickIndex;
    }
    // A menu handler or javascript: link can replace the document even when
    // the control had no navigable href at enumeration time. Remaining queued
    // targets belong to the old DOM; they cannot be examined, and the new
    // document must not be re-enumerated as if it were the original page.
    // A same-document history/query update (`pushState`) keeps the document
    // and its controls, so it must continue to re-enumeration instead of
    // abandoning live controls.
    const urlAfterClick = input.pageUrl();
    const beforeKey = normalizeVisitUrl(urlBeforeClick) ?? urlBeforeClick;
    const afterKey = normalizeVisitUrl(urlAfterClick) ?? urlAfterClick;
    const urlChanged = beforeKey !== afterKey;
    let replacedThisClick = urlChanged;
    if (input.documentIdentity) {
      const identityAfterClick = await input.documentIdentity().catch(() => null);
      if (identityBeforeClick !== null && identityBeforeClick !== undefined
        && identityAfterClick !== null && identityAfterClick !== undefined) {
        replacedThisClick = identityBeforeClick !== identityAfterClick;
      } else {
        // An unreadable identity cannot establish document continuity. A
        // same-URL reload would look exactly like a same-document update, so
        // fail closed: stop the old plan instead of clicking stale controls
        // on a replacement document.
        replacedThisClick = true;
      }
    }
    if (replacedThisClick) {
      documentReplaced = true;
      const remainingTargets = clickTargets.slice(clickIndex + 1);
      if (remainingTargets.length > 0) {
        evidenceControlsSkipped += remainingTargets.length;
        // A replaced document strands the remaining queued targets. Only an
        // unexamined hint/icon control is evidence-bearing; disclosure-only
        // leftovers stay opportunistic instead of making the page retryable.
        if (renderedControlSkipsNeedInteractionGap(remainingTargets)) interactionGap = true;
      }
      break;
    }
    // Same-document history updates keep the processed document, so its latest
    // URL stays valid terminal-success evidence. The assignment sits after the
    // replacement branch so a committed navigation cannot overwrite it.
    processedDocumentUrl = urlAfterClick;
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
          {
            crossOriginPursued: input.crossOriginPursued,
            queuedDestinations: input.queuedDestinations,
          },
        );
        // Newly revealed controls that do not fit the remaining click budget
        // were never examined. Count only genuinely new skips (initial
        // overflow/slice drops are already counted) and make the interaction
        // gap explicit so the page cannot resolve as a clean no-match.
        let freshDropped = 0;
        const freshDroppedTargets: RenderedControlTarget[] = [];
        for (const target of freshPlan.skipped) {
          if (!target.marker || countedSkips.has(target.marker)) continue;
          countedSkips.add(target.marker);
          freshDropped++;
          freshDroppedTargets.push(target);
        }
        if (freshDropped > 0) {
          evidenceControlsSkipped += freshDropped;
          if (renderedControlSkipsNeedInteractionGap(freshDroppedTargets)) interactionGap = true;
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
  return { evidenceControlsClicked, evidenceControlsFailed, evidenceControlsSkipped, interactionGap, documentReplaced, processedDocumentUrl, initialDocumentUrl, firstFailedTargetIndex };
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
  /**
   * Required same-host work still outstanding at stop (unvisited or terminal
   * required failures). Crawlee's `maxRequestsPerCrawl` refuses to enqueue
   * overflow URLs, so the post-run queue can report zero pending even though
   * eligible obligations were dropped. The required set is the ground truth:
   * outstanding required work always overrides a successful final response.
   */
  requiredWorkRemaining?: boolean;
  /**
   * P1.7 coverage truthfulness: a non-COMPLETE navigation-coverage reason is
   * never a clean absence. Only causes a refetch can change own retry
   * (timeout, page budget, interaction, abandoned context sampling); a fixed
   * scroll ceiling and deterministic policy/context gaps are visible partials
   * without retry.
   */
  coverageReason?: RenderedCoverageReason;
  coverageRetryable?: boolean;
}): { complete: boolean; queueComplete: boolean; retryable: boolean; failureClass: 'NO_PAGE_PROCESSED' | undefined } {
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
  // Required-but-unvisited work is an outstanding acquisition obligation even
  // when the queue reports empty: Crawlee refuses overflow enqueues at the
  // request cap, so a zero pending count is not proof that nothing remained.
  const requiredIncomplete = input.requiredWorkRemaining === true;
  const baseIncomplete = !processed || input.timedOut || terminalFailures > 0 || failedWithNoPages || pageBudgetCutoff || interactionIncomplete || requiredIncomplete;
  // A non-COMPLETE coverage reason means a navigation surface was observed
  // but not examined. It can never certify a clean absence, even when the
  // required same-host set happened to be covered. Deterministic policy or
  // context gaps stay visible without owning retry; budget/interaction/scroll
  // gaps are retryable.
  const coverageIncomplete = input.coverageReason !== undefined && input.coverageReason !== 'COMPLETE';
  const incomplete = baseIncomplete || coverageIncomplete;
  const retryable = baseIncomplete || (coverageIncomplete && input.coverageRetryable !== false);
  // `queueComplete` keeps the pre-coverage traversal verdict available so the
  // terminal stop attribution ("ran out of enqueueable links") does not
  // disappear merely because a policy/context surface was unexamined.
  return { complete: !incomplete, queueComplete: !baseIncomplete, retryable, failureClass: !processed ? 'NO_PAGE_PROCESSED' : undefined };
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

interface RenderedGateWaiter {
  lane: AcquisitionLane;
  grant: () => void;
}

export class RenderedFallbackGate {
  private active = 0;
  private readonly waiters: RenderedGateWaiter[] = [];
  private lastDeniedLogAtMs = 0;

  constructor(
    readonly concurrency: number,
    readonly maxPending: number,
    private readonly admissionGovernor: RenderedAdmissionGovernorLike = renderedAdmissionGovernor,
  ) {}

  private pendingLanes(): Set<AcquisitionLane> {
    return new Set(this.waiters.map(waiter => waiter.lane));
  }

  private discoveryQueueReserve(): number {
    return Math.max(1, Math.ceil(this.maxPending * 0.35));
  }

  private acquire(lane: AcquisitionLane): Promise<() => void> {
    if (this.active >= this.concurrency) {
      // Discovery may use a small extra queue reserve so a full non-discovery
      // queue cannot hide discovery demand from the floor governor.
      const pendingLimit = lane === 'DISCOVERY'
        ? this.maxPending + this.discoveryQueueReserve()
        : this.maxPending;
      if (this.waiters.length >= pendingLimit) return Promise.reject(new Error('RENDERED_FALLBACK_SATURATED'));
    }
    return new Promise(resolve => {
      const grant = () => {
        this.active++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active--;
          this.grantNextWaiter();
        });
      };
      if (this.active < this.concurrency) grant(); else this.waiters.push({ lane, grant });
    });
  }

  private grantNextWaiter(): void {
    if (this.waiters.length === 0) return;
    const pending = this.pendingLanes();
    let index = 0;
    // When the discovery floor is short and discovery work is queued, admit
    // the discovery waiter before non-discovery waiters. The governor still
    // performs the final rate/floor check after the slot is granted.
    if (this.admissionGovernor.shouldReserveDiscovery(pending)) {
      const discoveryIndex = this.waiters.findIndex(waiter => waiter.lane === 'DISCOVERY');
      if (discoveryIndex >= 0) index = discoveryIndex;
    }
    const [next] = this.waiters.splice(index, 1);
    next?.grant();
  }

  private logDenied(decision: RenderedAdmissionDecision): void {
    const now = Date.now();
    if (now - this.lastDeniedLogAtMs < 60_000) return;
    this.lastDeniedLogAtMs = now;
    console.warn(JSON.stringify({
      event: 'rendered_admission_denied',
      lane: decision.lane,
      reason: decision.reason,
      admissionsInWindow: decision.admissionsInWindow,
      discoveryAdmissionsInWindow: decision.discoveryAdmissionsInWindow,
      limit: decision.limit,
      emergency: decision.emergency,
      retryAt: decision.retryAtMs ? new Date(decision.retryAtMs).toISOString() : null,
      timestamp: new Date(now).toISOString(),
    }));
  }

  async run<T>(
    operation: (admittedAtMs: number) => Promise<T>,
    lane: AcquisitionLane = 'UNKNOWN',
    options: { isWorkStarted?: (result: T) => boolean } = {},
  ): Promise<T> {
    const queuedDemand = this.active >= this.concurrency;
    const release = await this.acquire(lane);
    const decision = this.admissionGovernor.admit(lane, this.pendingLanes(), queuedDemand);
    if (!decision.admitted) {
      this.logDenied(decision);
      release();
      // Existing capacity class: the retry policy treats this as attempt-free
      // and the inspector records CAPACITY_DEFERRED rather than a failure.
      throw Object.assign(new Error('RENDERED_FALLBACK_SATURATED'), {
        retryAt: decision.retryAtMs ?? undefined,
        admissionReason: decision.reason ?? undefined,
      });
    }
    // Admission is timestamped here so callers can start budget clocks at the
    // moment the gate slot was granted, even if they serialize internally
    // afterwards (see withRenderedQueueLifecycleLock).
    try {
      const result = await operation(Date.now());
      // A proxy/browser startup failure can return a zero-work result. Refund
      // that reservation so a failed start cannot consume an hour of capacity.
      if (decision.admissionId !== null && options.isWorkStarted && !options.isWorkStarted(result)) {
        this.admissionGovernor.refund(decision.admissionId);
      }
      return result;
    } catch (error) {
      // A rejected operation may also be a pre-work startup failure. Attach the
      // admission id so the caller can refund only when telemetry proves no
      // navigation ran; a post-work rejection stays counted.
      if (decision.admissionId !== null && error && typeof error === 'object') {
        Object.assign(error, { admissionId: decision.admissionId });
      }
      throw error;
    } finally { release(); }
  }

  snapshot(): { active: number; pending: number; concurrency: number; maxPending: number } {
    return { active: this.active, pending: this.waiters.length, concurrency: this.concurrency, maxPending: this.maxPending };
  }

  admissionSnapshot(): ReturnType<RenderedAdmissionGovernorLike['snapshot']> {
    return this.admissionGovernor.snapshot();
  }

  refund(admissionId: number): boolean {
    return this.admissionGovernor.refund(admissionId);
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
  let seedSnapshotIdentity: unknown = null;
  // The seed request may be retried with a fresh page/document. The identity
  // and URL are refreshed for each seed attempt, while child pages never
  // replace them. Required links accumulate across attempts: a destination
  // seen on a failed attempt stays an obligation instead of disappearing.
  const seedRequestKey = normalizeVisitUrl(seedUrl);
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
  let controlsStructuralDisclosure = 0;
  let controlsStructuralUnrecovered = 0;
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
  // Context seen through a click that committed a new document, keyed by
  // destination identity. It is reconciled at publish time against every
  // document this crawl actually inspected: the link pass runs after the click
  // loop, so a clicked destination can still be admitted and inspected as its
  // own request, and counting it here as well would double the crawl totals.
  const clickDestinationContextByKey = new Map<string, ClickDestinationContext>();
  const inspectedDocumentKeys = new Set<string>();
  let popupTargets = 0;
  let popupTargetsResolved = 0;
  let popupCaptured = 0;
  let popupDestinationsDropped = 0;
  let revealedSameOriginAdmitted = 0;
  let revealedSameOriginDropped = 0;
  let opaqueInteractiveControls = 0;
  let frameCount = 0;
  let shadowRootCount = 0;
  let closedShadowRootCount = 0;
  let declarativeClosedShadowRootCount = 0;
  let declarativeShadowScanGap = 0;
  let candidateCapTruncated = 0;
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
  const publishEvidenceControlCertificate = (budgetExhausted = false, requiredOutstanding = 0): RenderedCoverageReason => {
    // Derive crawl-wide context flags from each request's latest attempt so a
    // successful retry replaces a stale capped/base-href observation instead
    // of inheriting it from a failed attempt.
    baseHrefPresent = [...pageControlTotalsByRequest.values()].some(entry => entry.baseHrefPresent === true);
    scrollCapReachedStillGrowing = [...pageScrollCapByRequest.values()].some(Boolean);
    // A clicked destination that its own request later inspects is already in
    // the totals; only the remaining click-only observations are added.
    const clickDestinationContext = reconcileClickDestinationContext({
      observations: clickDestinationContextByKey,
      inspectedKeys: inspectedDocumentKeys,
    });
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
    telemetry.controlsStructuralDisclosure = controlsStructuralDisclosure || undefined;
    telemetry.controlsStructuralUnrecovered = controlsStructuralUnrecovered || undefined;
    telemetry.controlsIconLabelRecovered = controlsIconLabelRecovered || undefined;
    telemetry.popupTargets = popupTargets || undefined;
    telemetry.popupCaptured = popupCaptured || undefined;
    telemetry.popupDestinationsDropped = popupDestinationsDropped || undefined;
    telemetry.revealedSameOriginAdmitted = revealedSameOriginAdmitted || undefined;
    telemetry.revealedSameOriginDropped = revealedSameOriginDropped || undefined;
    telemetry.opaqueInteractiveControls = opaqueInteractiveControls || undefined;
    telemetry.frameCount = (frameCount + clickDestinationContext.frameCount) || undefined;
    telemetry.shadowRootCount = (shadowRootCount + clickDestinationContext.shadowRootCount) || undefined;
    telemetry.closedShadowRootCount = (closedShadowRootCount + clickDestinationContext.closedShadowRootCount) || undefined;
    telemetry.declarativeClosedShadowRootCount = declarativeClosedShadowRootCount || undefined;
    telemetry.declarativeShadowScanGap = declarativeShadowScanGap || undefined;
    telemetry.candidateCapTruncated = candidateCapTruncated || undefined;
    telemetry.baseHrefPresent = (baseHrefPresent || clickDestinationContext.baseHrefPresent) || undefined;
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
      requiredUnvisited: requiredOutstanding,
      popupDestinationsDropped,
      revealedSameOriginDropped,
      // The coverage reason must see the same context the telemetry publishes:
      // a document reached only by a click still has unexamined frames and
      // shadow roots, so it cannot be reported as fully covered.
      frameCount: frameCount + clickDestinationContext.frameCount,
      shadowRootCount: shadowRootCount + clickDestinationContext.shadowRootCount,
      closedShadowRootCount: closedShadowRootCount + clickDestinationContext.closedShadowRootCount,
      declarativeClosedShadowRootCount,
      declarativeShadowScanGap,
      candidateCapTruncated,
      // A popup control that was actually clicked is resolved: either its
      // popup destination was captured or its in-place disclosure was
      // inspected. Only unresolved popup triggers remain context gaps.
      popupTargets: Math.max(0, popupTargets - popupTargetsResolved),
      opaqueInteractiveControls,
      navigationPolicyExcluded: telemetry.navigationPolicyExcluded,
      unrecoveredNavigation: controlsStructuralUnrecovered > 0,
    });
    return telemetry.coverageReason;
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
  // Pages read during this crawl are used only for navigation deduplication
  // (a structural link back to them is not an unexamined destination). They
  // become successful coverage evidence only after the full handler succeeds.
  const structuralVisitedKeys = new Set(alreadyVisitedSet);
  // P1.6 cross-origin enqueue identities, bounded crawl-wide. Stored
  // separately from alreadyVisitedSet: an enqueued destination is not yet
  // inspected, so it must not satisfy required coverage.
  const crossOriginQueued = new Set<string>();
  // Count of optional cross-origin requests actually submitted. Used only to
  // scope the clean-negative retry suppression to runs where P1.6 admitted
  // work, so flag-off retry/cache behavior is unchanged.
  let crossOriginEnqueued = 0;
  // Popup destinations captured during an allowed click. Keyed by normalized
  // request URL; values retain the URL for post-run resolution accounting.
  const popupQueued = new Map<string, string>();
  // Interaction-revealed same-origin destinations admitted this crawl. Kept
  // separate from hint-owned same-host enqueues so the reveal planner cannot
  // re-admit a link another page already queued.
  const revealedQueued = new Set<string>();
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
    const gateRequestedAtMs = Date.now();
    return await renderedFallbackGate.run<BrowserFallbackResult>((gateAdmittedAtMs) => withRenderedQueueLifecycleLock(async () => {
      // Admission wait is capacity evidence, measured before the lifecycle
      // lock so serialized crawls correctly show gate pressure. It is never
      // an acquisition failure or a reason to consume retry ownership.
      telemetry.gateWaitMs = Math.max(0, gateAdmittedAtMs - gateRequestedAtMs);
      telemetry.lastLifecycleStage = advanceRenderedLifecycleStage(telemetry.lastLifecycleStage, 'GATE_ACQUIRED');
      // Total-budget clock: starts at gate admission, before the lifecycle
      // lock below, so a crawl admitted by a wider gate (env concurrency 2)
      // consumes budget while waiting behind a serialized predecessor instead
      // of occupying a gate slot with a fresh clock — the pre-lock semantics.
      const startedAt = gateAdmittedAtMs;
      telemetry.crawlStartedAt = new Date(startedAt).toISOString();
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
        egressProxy = await (limits.egressProxyFactory || startBrowserEgressProxy)();
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
            // Closed shadow roots are invisible to light-DOM traversal by
            // design. A bounded attachShadow probe records their existence
            // before page scripts run; it never attempts to traverse them, so
            // coverage can report an unexamined context instead of certifying
            // a clean absence.
            await page.addInitScript(installClosedShadowRootInstrumentation);
            // Declarative closed roots are consumed and removed by the HTML
            // parser, so neither page JavaScript nor the attachShadow wrapper
            // can see them. Scan the raw main-document response before
            // navigation; the scan is bounded and a gap is reported rather
            // than assumed empty.
            beginRenderedDeclarativeShadowScan(page as unknown as RenderedShadowScanPageLike);
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
            // A P1.6 cross-origin request is optional third-party evidence.
            // Its own same-host hint passes are skipped: otherwise an admitted
            // link hub or platform page could enqueue an uncapped number of
            // its own hint links, consuming maxPages beyond the crawl-wide
            // cross-origin cap. Its bounded cross-origin pass still runs.
            const crossOriginRequest = (request.userData as { crossOrigin?: unknown } | undefined)?.crossOrigin === true;
            // A retry replaces the failed attempt's uncertified mark: this
            // attempt re-examines the page from its first control.
            uncertifiedRequestKeys.delete(request.url);
            // Assigned once the per-page P0.2 counters exist; the catch path
            // calls it to preserve counts from an already-enumerated page.
            let aggregatePageCountersOnError: (() => void) | undefined;
            // Exposed to the handler catch so queued probes are incorporated
            // before counters from an enumerated page are aggregated.
            let flushPageContextProbesOnError: (() => Promise<void>) | undefined;
            // Popups opened by an allowed click are captured rather than
            // leaked or silently ignored. Bounded to 8 per page so a popup
            // storm cannot grow the handler unbounded; overflow popups are
            // closed and counted as dropped. The listener is attached to the
            // browser context, not the page: COOP-severed auth popups can be
            // missing from the opener page's `popup` event even though they
            // are still real destinations in this bounded crawl.
            const pendingPopups: Array<{
              popup: {
                url(): string;
                close(): Promise<void>;
                content?(): Promise<string>;
                waitForURL?(
                  url: (target: URL) => boolean,
                  options?: { timeout?: number },
                ): Promise<unknown>;
              };
              /** Opener URL captured when the popup was observed, before any
               * same-click navigation can replace `page.url()`. */
              openerUrl: string;
            }> = [];
            let popupsObserved = 0;
            const onPopup = (popup: {
              url(): string;
              close(): Promise<void>;
              content?(): Promise<string>;
              waitForURL?(url: (target: URL) => boolean, options?: { timeout?: number }): Promise<unknown>;
            }) => {
              // Count observations, not queued items: draining shifts an item
              // before awaiting it, so a length check can be refilled by new
              // events and inspect more than the per-page cap.
              if (popupsObserved >= RENDERED_POPUP_LIMIT) {
                popupDestinationsDropped++;
                void popup.close().catch(() => undefined);
                return;
              }
              popupsObserved++;
              let openerUrl = '';
              try { openerUrl = page.url(); } catch { openerUrl = request.url; }
              pendingPopups.push({ popup, openerUrl });
            };
            const popupContext = (page as unknown as { context?: () => {
              on?: (event: string, listener: (candidate: typeof page) => void) => void;
              off?: (event: string, listener: (candidate: typeof page) => void) => void;
              pages?: () => Array<typeof page>;
            } }).context?.();
            const seenPopupPages = new Set<object>();
            const preexistingSiblingPages = new Set<object>();
            for (const existing of popupContext?.pages?.() || []) {
              if (existing && existing !== page) preexistingSiblingPages.add(existing);
            }
            const onContextPage = (candidate: typeof page) => {
              if (!candidate || candidate === page || seenPopupPages.has(candidate)) return;
              seenPopupPages.add(candidate);
              onPopup(candidate as unknown as Parameters<typeof onPopup>[0]);
            };
            popupContext?.on?.('page', onContextPage);
            // A load-time window.open may commit before the request handler
            // starts, so the event can be missed. Pick up already-open sibling
            // pages, but distinguish a real popup from an idle browser-pool
            // `about:blank` page: closing pool idle state as a "dropped popup"
            // would make every ordinary crawl look bounded, while skipping a
            // real load-time popup would let a clean result hide its contents.
            const captureSiblingPages = async (): Promise<void> => {
              for (const existing of popupContext?.pages?.() || []) {
                if (!existing || existing === page || seenPopupPages.has(existing)) continue;
                if (preexistingSiblingPages.has(existing)) {
                  let existingUrl = '';
                  try { existingUrl = existing.url(); } catch { /* treat as idle */ }
                  if (!/^https?:/i.test(existingUrl)) {
                    let probe: { hasOpener?: boolean; hasContent?: boolean } | null = null;
                    try {
                      probe = await existing.evaluate(() => {
                        const popupWindow = window as unknown as { opener?: unknown };
                        const body = document.body;
                        const hasContent = !!body && (body.childElementCount > 0
                          || (body.textContent || '').trim().length > 0);
                        return { hasOpener: !!popupWindow.opener, hasContent };
                      });
                    } catch { probe = null; }
                    if (shouldSkipPreexistingSiblingPage(existingUrl, probe)) continue;
                  }
                }
                onContextPage(existing);
              }
            };
            await captureSiblingPages();
            const stopPopupCapture = () => popupContext?.off?.('page', onContextPage);
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
                  // `page.content()` does not serialize shadow trees. Feed a
                  // bounded open-root snapshot through the same candidate
                  // extractor so an invite placed only inside an open root is
                  // discovered; closed roots remain uninspected and are
                  // reported by the separate closed-root counters.
                  try {
                    const shadowSnapshot = await page.evaluate(collectRenderedOpenShadowContent);
                    if (shadowSnapshot && typeof shadowSnapshot.text === 'string' && shadowSnapshot.text) {
                      retain(shadowSnapshot.text, url);
                    }
                    if (shadowSnapshot && Array.isArray(shadowSnapshot.hrefs) && shadowSnapshot.hrefs.length) {
                      retain(shadowSnapshot.hrefs.join(' '), url);
                    }
                    // A bounded open-root walk that stopped early may hide a
                    // host (and its invite) beyond the bound. Mark the run
                    // incomplete instead of claiming a clean absence.
                    if (shadowSnapshot && shadowSnapshot.truncated) interactionGap = true;
                  } catch { /* coverage still reports open roots as context-unreachable */ }
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
            // Record the document this request actually inspected (the request
            // URL plus any redirect target) so a click that merely lands on it
            // later is not attributed twice.
            const inspectedIdentities = visitIdentityKeys(request.url, page.url());
            for (const identity of inspectedIdentities) {
              inspectedDocumentKeys.add(identity);
            }
            // A redirect makes the request URL and the final landing URL the
            // same inspected destination. Record both for structural
            // deduplication: a menu link back to the original request URL is
            // not an unexamined destination (it redirects to this document).
            for (const identity of inspectedIdentities) {
              structuralVisitedKeys.add(identity);
            }
            telemetry.lastLifecycleStage = advanceRenderedLifecycleStage(telemetry.lastLifecycleStage, 'PAGE_PROCESSED');
            // P0.2 context counters: structural presence only, refreshed after
            // scrolling and same-document DOM-changing clicks so frames/shadow
            // roots revealed by interaction are not missed. They are
            // diagnostics for P1.3-P1.5 and never alter selection, clicking,
            // outcome, or retry behavior. A page that navigated away or closed
            // between inspection and a probe must not fail the crawl.
            let pageFrameCount = 0;
            let pageShadowRootCount = 0;
            let pageClosedShadowRootCount = 0;
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
              pageClosedShadowRootCount = Math.max(0, Math.floor(initialPageContext.closedShadowRootCount) || 0);
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
            const recordClickDestinationContext = (destinationUrl: string, observation: ClickDestinationContext): void => {
              const key = normalizeVisitUrl(destinationUrl);
              if (!key) return;
              const previous = clickDestinationContextByKey.get(key);
              clickDestinationContextByKey.set(key, {
                frameCount: Math.max(previous?.frameCount ?? 0, Math.max(0, Math.floor(observation.frameCount) || 0)),
                shadowRootCount: Math.max(previous?.shadowRootCount ?? 0, Math.max(0, Math.floor(observation.shadowRootCount) || 0)),
                closedShadowRootCount: Math.max(
                  previous?.closedShadowRootCount ?? 0,
                  Math.max(0, Math.floor(observation.closedShadowRootCount) || 0),
                ),
                baseHrefPresent: previous?.baseHrefPresent === true || observation.baseHrefPresent === true,
              });
            };
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
                  // hint-free), and an enqueued destination may still never be
                  // inspected (max-requests cutoff, later failure). Record the
                  // context by destination unconditionally; publish-time
                  // reconciliation drops it only when a request actually
                  // inspected that document and counted the same context.
                  recordClickDestinationContext(page.url(), {
                    frameCount: pageContext.frameCount,
                    shadowRootCount: pageContext.shadowRootCount,
                    closedShadowRootCount: pageContext.closedShadowRootCount,
                    baseHrefPresent: pageContext.baseHrefPresent === true,
                  });
                  return;
                }
                pageFrameCount = Math.max(pageFrameCount, Math.max(0, Math.floor(pageContext.frameCount) || 0));
                pageShadowRootCount = Math.max(pageShadowRootCount, Math.max(0, Math.floor(pageContext.shadowRootCount) || 0));
                pageClosedShadowRootCount = Math.max(
                  pageClosedShadowRootCount,
                  Math.max(0, Math.floor(pageContext.closedShadowRootCount) || 0),
                );
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
            // Declarative closed roots never reach the live DOM, so their
            // count comes from the bounded raw-response scan installed before
            // navigation. Re-read after interactions because a click can
            // navigate to a document whose response the same listener sees;
            // only the delta is added, so the initial document is never
            // double-counted. A body that could not be bounded is a gap that
            // keeps coverage partial rather than a silent empty result.
            let lastDeclarativeClosedRoots = 0;
            let lastDeclarativeGaps = 0;
            const recordDeclarativeShadowScan = async (): Promise<void> => {
              try {
                const declarativeScan = await readRenderedDeclarativeShadowScan(page);
                declarativeClosedShadowRootCount += Math.max(
                  0,
                  Math.max(0, Math.floor(declarativeScan.closedRoots) || 0) - lastDeclarativeClosedRoots,
                );
                declarativeShadowScanGap += Math.max(
                  0,
                  Math.max(0, Math.floor(declarativeScan.gaps) || 0) - lastDeclarativeGaps,
                );
                lastDeclarativeClosedRoots = Math.max(
                  lastDeclarativeClosedRoots,
                  Math.max(0, Math.floor(declarativeScan.closedRoots) || 0),
                );
                lastDeclarativeGaps = Math.max(
                  lastDeclarativeGaps,
                  Math.max(0, Math.floor(declarativeScan.gaps) || 0),
                );
              } catch { declarativeShadowScanGap++; }
            };
            await recordDeclarativeShadowScan();
            if (seedRequestKey && normalizeVisitUrl(request.url) === seedRequestKey) {
              seedDocumentSeen = true;
              seedSnapshotUrl = page.url();
              // Capture document identity alongside the URL. A menu can
              // update the query in place (pushState); the URL then differs
              // even though the seed document, and links revealed after the
              // update, still belong to the same required set. Refresh both
              // per seed attempt: a Crawlee retry gets a fresh document whose
              // new timeOrigin must not be compared with the failed attempt's
              // identity.
              seedSnapshotIdentity = await page.evaluate(() => performance.timeOrigin).catch(() => null);
              try {
                const known = new Set(seedRequiredLinks);
                for (const link of discoverRequiredSeedLinks(await page.content(), page.url())) known.add(link);
                seedRequiredLinks = [...known];
              } catch {
                // Keep links discovered on an earlier attempt.
              }
            }
            // Post-scroll same-origin anchor baseline, keyed by document
            // identity. Captured after the scroll loop so links loaded by
            // infinite scroll are static relative to the inspected page, not
            // "revealed by interaction"; otherwise generic scroll-loaded
            // links consume the page budget and make the site permanently
            // BOUNDED. A click that navigates to a new document gets its own
            // baseline, so its static links are not mistaken for revealed
            // links either.
            const linkBaselines = new Map<string, RenderedLinkBaseline>();
            const documentBaselineKey = (identity: unknown, url: string): string =>
              identity !== null && identity !== undefined
                ? String(identity)
                : (normalizeVisitUrl(url) || url);
            let initialLinksCaptured = false;
            let revealedScanFailed = false;
            // A saturated baseline cannot tell static overflow from links a
            // menu/panel revealed. Report the ambiguity once per document when
            // an interaction occurred, instead of certifying a clean absence.
            const saturatedBaselineGapDocuments = new Set<string>();
            const captureBaseline = async (): Promise<void> => {
              try {
                const identity = await page.evaluate(() => performance.timeOrigin).catch(() => null);
                const baselineKey = documentBaselineKey(identity, page.url());
                const initialCollection = await page.$$eval(
                  'a[href]',
                  collectRenderedSameOriginCandidates,
                  page.url(),
                );
                // This snapshot is only a comparison baseline for "revealed
                // by interaction". Its overflow bound does not drop a
                // destination from pursuit: the hint pass owns hint-bearing
                // links, and a saturated baseline cannot distinguish static
                // overflow from interaction-revealed links, so it must never
                // admit (or count) the overflow as new work.
                linkBaselines.set(baselineKey, buildRenderedLinkBaseline(initialCollection));
                initialLinksCaptured = true;
              } catch { /* fail closed below if interactions occurred */ }
            };
            // Capture destinations inserted by one interaction before a later
            // interaction replaces the panel that contained them. Runs after
            // every click and once more after the loop for click-revealed
            // links. Each document's baseline records every candidate already
            // considered, so repeated passes neither re-admit nor re-count it.
            const captureRevealedSameOrigin = async (interactionOccurred: boolean): Promise<void> => {
              if (!initialLinksCaptured || Date.now() - startedAt >= limits.totalTimeoutMs) return;
              let currentUrl = '';
              let baselineKey = '';
              let revealedCollection: RenderedCandidateCollection;
              try {
                currentUrl = page.url();
                const identity = await page.evaluate(() => performance.timeOrigin).catch(() => null);
                baselineKey = documentBaselineKey(identity, currentUrl);
                revealedCollection = await page.$$eval(
                  'a[href]',
                  collectRenderedSameOriginCandidates,
                  currentUrl,
                );
              } catch {
                revealedScanFailed = true;
                return;
              }
              let baseline = linkBaselines.get(baselineKey);
              if (!baseline) {
                // First observation of a document reached by a click. Its
                // current links are static relative to that document and must
                // not consume the remaining page budget.
                linkBaselines.set(baselineKey, buildRenderedLinkBaseline(revealedCollection));
                return;
              }
              if (baseline.saturated) {
                // The baseline stopped at its bound, so static overflow and
                // interaction-revealed links cannot be distinguished.
                // Admitting the overflow would spend the page budget on
                // static navigation; hint-bearing links are still owned by
                // the same-host hint pass. But an interaction did happen: a
                // generic destination it revealed (for example `/resources`)
                // is genuinely unexchanged and the overflow bound cannot rule
                // it out, so coverage must stay partial (once per document).
                if (shouldRecordSaturatedBaselineGap(
                  baseline,
                  interactionOccurred,
                  saturatedBaselineGapDocuments,
                  baselineKey,
                )) {
                  saturatedBaselineGapDocuments.add(baselineKey);
                  revealedSameOriginDropped++;
                }
                return;
              }
              if (revealedCollection.truncated > 0) {
                candidateCapTruncated = Math.max(candidateCapTruncated, revealedCollection.truncated);
              }
              // Hint-bearing links revealed by this interaction must get the
              // request slots before generic revealed links; otherwise the
              // budget can be consumed by generic destinations that will not
              // be retried. Optional third-party pages skip this pass: their
              // same-host fan-out is not required coverage and must not take
              // page budget beyond the crawl-wide optional-branch cap.
              if (!crossOriginRequest) await enqueueSameHostHints();
              // Reuse the existing page budget and subtract requests already
              // queued but not yet inspected: Crawlee refuses requests past
              // maxRequestsPerCrawl, so counting the whole nominal budget
              // would over-admit generic links and then mark the overflow as
              // a coverage gap. On an optional third-party page the same
              // crawl-wide cap that bounds the cross-origin pass also bounds
              // revealed destinations, so a hub cannot extend the optional
              // branch past its reserved page budget.
              const pendingQueued = await renderedPendingRequestCount();
              const remainingPageBudget = Math.max(0, limits.maxPages - inspectedPages - pendingQueued);
              const remainingOptionalCap = crossOriginRequest
                ? Math.max(0, MAX_RENDERED_CROSS_ORIGIN_ENQUEUES - crossOriginQueued.size)
                : remainingPageBudget;
              const revealedPlan = planRevealedSameOriginEnqueues({
                candidates: revealedCollection.candidates,
                currentUrl,
                initialLinks: baseline.links,
                alreadyVisited: alreadyVisitedSet,
                queued: revealedQueued,
                maxEnqueues: Math.min(remainingPageBudget, remainingOptionalCap),
                baselineSaturated: baseline.saturated,
                hintPassSkipped: crossOriginRequest,
              });
              // Mark every candidate as considered even when it was rejected:
              // a later pass must not re-count the same budget loss.
              for (const candidate of revealedCollection.candidates) {
                const key = normalizeVisitUrl(candidate.url);
                if (key) baseline.links.add(key);
              }
              if (revealedPlan.alreadyVisited) drops.count('already-visited', revealedPlan.alreadyVisited);
              if (revealedPlan.admissionRejected) drops.count('admission-rejected', revealedPlan.admissionRejected);
              if (crossOriginRequest) {
                // The hint pass was skipped above, and any reveal beyond the
                // optional cap is deterministic optional work, not retryable
                // page-budget loss. Both are destination-budget exclusions.
                const optionalDropped = revealedPlan.hintHandled + revealedPlan.budget;
                if (optionalDropped > 0) drops.count('destination-budget', optionalDropped);
              } else if (revealedPlan.budget > 0) {
                revealedSameOriginDropped += revealedPlan.budget;
              }
              if (!revealedPlan.admitted.length) return;
              for (const url of revealedPlan.admitted) {
                const key = normalizeVisitUrl(url) || url;
                revealedQueued.add(key);
              }
              revealedSameOriginAdmitted += revealedPlan.admitted.length;
              try {
                await enqueueLinks({
                  urls: revealedPlan.admitted,
                  strategy: 'all',
                  ...(crossOriginRequest ? { userData: { crossOrigin: true } } : {}),
                });
                if (crossOriginRequest) {
                  for (const url of revealedPlan.admitted) {
                    crossOriginQueued.add(normalizeVisitUrl(url) || url);
                  }
                  crossOriginEnqueued += revealedPlan.admitted.length;
                }
              } catch {
                // Keys are already recorded; post-run resolution accounts for
                // every destination that was never inspected.
              }
            };

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
            let pageStructuralDisclosure = 0;
            let pageStructuralUnrecovered = 0;
            let pageIconLabelRecovered = 0;
            let pageOpaqueInteractiveControls = 0;
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
              pageStructuralDisclosure = Math.max(pageStructuralDisclosure, enumeration.structuralDisclosure);
              // Raw browser-side candidates become coverage gaps only when the
              // enqueue path will not follow the destination. An admitted
              // same-origin community link is inspected separately; a
              // cross-origin anchor cannot be followed by the same-hostname
              // enqueue path, so it is recorded in the rendered policy ledger
              // instead of silently resolving as COMPLETE.
              let unrecoveredRejected = 0;
              for (const href of enumeration.structuralUnrecoveredHrefs) {
                if (isCrossHostnameStructuralNavigation(href, page.url())) {
                  // Count each excluded destination once per crawl, matching
                  // the static inspector. A shared header/footer link would
                  // otherwise inflate the ledger on every page and retry.
                  const key = normalizeVisitUrl(href) || href.trim();
                  if (key) drops.countUnique('cross-origin-disallowed', key);
                  continue;
                }
                if (isUnrecoveredStructuralNavigation(href, page.url(), structuralVisitedKeys)) {
                  unrecoveredRejected++;
                }
              }
              // The href sample is bounded, so a candidate beyond it was never
              // checked against admission. Fail closed instead of letting the
              // sample size decide that the crawl is complete.
              if (enumeration.structuralUnrecoveredOverflow) unrecoveredRejected = Math.max(1, unrecoveredRejected);
              pageStructuralUnrecovered = Math.max(pageStructuralUnrecovered, unrecoveredRejected);
              pageIconLabelRecovered = gapCounters.iconLabelRecovered;
              // Re-enumeration after a disclosure sees the same opaque control
              // again; max per page avoids double counting while still
              // noticing controls revealed later in the click loop.
              pageOpaqueInteractiveControls = Math.max(
                pageOpaqueInteractiveControls,
                enumeration.opaqueInteractiveControls,
              );
              pagePopupMarkers = trackRenderedPopupCoverage(pagePopupMarkers, enumeration);
              // Overflow accounting uses the expanded click set. The
              // unexamined overflow is origin-gated: an unclicked generic
              // disclosure stays opportunistic, while an unexamined hint/icon
              // control makes the page retryable.
              const overflowTargets = renderedControlOverflowTargets(
                enumeration.controls,
                page.url(),
                limits.clickOffset,
              );
              const overflow = overflowTargets.length;
              if (overflow > pageControlOverflow) {
                const added = overflow - pageControlOverflow;
                pageControlOverflow = overflow;
                drops.count('control-slice', added);
                evidenceControlsSkipped += added;
              }
              // Evaluate origins on every enumeration: a later DOM change can
              // rotate a hint/icon control into the unexamined window even when
              // the overflow count itself did not grow.
              if (renderedControlSkipsNeedInteractionGap(overflowTargets)) interactionGap = true;
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
                  closedShadowRootCount: Math.max(previous.closedShadowRootCount || 0, pageClosedShadowRootCount),
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
                closedShadowRootCount += contextDelta.closedShadowRootCount;
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
                structuralDisclosure: pageStructuralDisclosure,
                structuralUnrecovered: pageStructuralUnrecovered,
                iconLabelRecovered: pageIconLabelRecovered,
                popupCount: resolveUnexaminedPopupTargets(pagePopupMarkers, examinedPopupMarkers),
                opaqueInteractiveControls: pageOpaqueInteractiveControls,
                frameCount: pageFrameCount,
                shadowRootCount: pageShadowRootCount,
                closedShadowRootCount: pageClosedShadowRootCount,
                baseHrefPresent: pageBaseHrefPresent,
              };
              pageControlTotalsByRequest.set(requestKey, current);
              pageScrollCapByRequest.set(requestKey, pageScrollCapThisAttempt);
              const delta = renderedRequestControlTotalsDelta(previous, current);
              controlsEnumeratedTotal += delta.enumerated;
              controlsHintRejected += delta.hintRejected;
              controlsStructuralNavigation += delta.structuralNavigation;
              controlsStructuralHintRejected += delta.structuralHintRejected;
              controlsStructuralDisclosure += delta.structuralDisclosure;
              controlsStructuralUnrecovered += delta.structuralUnrecovered;
              controlsIconLabelRecovered += delta.iconLabelRecovered;
              popupTargets += delta.popupCount;
              opaqueInteractiveControls += delta.opaqueInteractiveControls;
              frameCount += delta.frameCount;
              shadowRootCount += delta.shadowRootCount;
              closedShadowRootCount += delta.closedShadowRootCount;
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
            // Baseline after scrolling: scroll-loaded links are static
            // relative to this inspection and must not be treated as
            // interaction-revealed work.
            await captureBaseline();

            const firstEnumeration = await enumerateControls();
            recordControlEnumeration(firstEnumeration);
            const controls = firstEnumeration.controls;
            // Cross-host anchors are enqueue-owned only while the bounded
            // cross-origin pass will still pursue an eligible destination. Once
            // pursuit is OFF or the crawl-wide cap is exhausted, an eligible
            // aggregator/community link is reachable only by clicking it, so it
            // must stay in the click set. `crossOriginQueued` grows as the pass
            // admits destinations, so this is evaluated per plan, not cached.
            // Per-request plan of cap-owned destinations whose actual enqueue
            // is deferred until after interactions. Kept separate from the
            // crawl-wide queue so optional work cannot take a queue position
            // ahead of JS-revealed required same-host links.
            const crossOriginReserved = new Set<string>();
            const crossOriginPursuitActive = (): boolean =>
              limits.crossOriginEnqueue === true
              && crossOriginQueued.size + crossOriginReserved.size < MAX_RENDERED_CROSS_ORIGIN_ENQUEUES;
            // A destination already enqueued by another pass is never clicked.
            // The sets are live: `enqueueCrossOrigin`/`drainPopups` fill them
            // before and during the click loop, and re-enumeration would
            // otherwise turn a queued hub into a duplicate navigation. The
            // reservation set covers cap-owned destinations discovered before
            // interactions: actual submission is deferred until the post-click
            // same-host pass, but the click plan must already treat them as
            // enqueue-owned so they are not navigated twice.
            const isQueuedDestination = (visitKey: string): boolean =>
              crossOriginQueued.has(visitKey)
              || crossOriginReserved.has(visitKey)
              || revealedQueued.has(visitKey)
              || popupQueued.has(visitKey);
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
            // Same-host hint pass. Used before any revealed-link admission so
            // hint-bearing destinations get the remaining request slots ahead
            // of generic interaction-revealed links (Crawlee refuses requests
            // past `maxRequestsPerCrawl`).
            const enqueueSameHostHints = async (): Promise<void> => {
              if (Date.now() - startedAt >= limits.totalTimeoutMs) return;
              await enqueueLinks({
                strategy: 'same-hostname',
                transformRequestFunction: req => (admitEnqueueRequest(req.url) ? req : false),
              });
            };
            // Eligible requests already queued but not yet inspected. The
            // remaining page budget is `maxPages - inspectedPages - pending`;
            // counting the whole nominal budget over-admits and then reports
            // the overflow as a coverage gap.
            const renderedPendingRequestCount = async (): Promise<number> => {
              try {
                const info = await (isolated.queue as unknown as {
                  getInfo?: () => Promise<{ pendingRequestCount?: unknown }>;
                }).getInfo?.();
                const pending = (info as { pendingRequestCount?: unknown } | null | undefined)?.pendingRequestCount;
                if (typeof pending === 'number' && Number.isFinite(pending)) {
                  return Math.max(0, Math.floor(pending));
                }
              } catch { /* unreadable queue info: assume nothing pending */ }
              return 0;
            };
            // Capture the original page's discoverable anchors BEFORE executing
            // controls that may navigate away: a button/cross-host click can
            // replace the document, and the post-click enqueue below would
            // then scan the new page instead. The post-click enqueue is kept
            // (JS-revealed links), so both DOM states contribute; queue
            // dedupe makes repeats free. Hint-rejected double counts across
            // the two passes are bounded diagnostic noise (≤1 extra pass).
            // Collection runs even when pursuit is OFF: a discovered eligible
            // destination that policy did not pursue is a coverage gap, never
            // a silent discard.
            const collectCrossOriginCandidates = async (): Promise<RenderedCrossOriginCandidate[]> => {
              if (Date.now() - startedAt >= limits.totalTimeoutMs) return [];
              try {
                const currentUrl = page.url();
                // Crawlee's enqueueLinks exposes only hrefs to its transform
                // hook. Collect bounded href+visible-text pairs, filtering
                // same-origin/non-HTTP(S) anchors before the bound so internal
                // navigation cannot hide a cross-origin community link.
                const collection = await page.$$eval(
                  'a[href]',
                  collectRenderedCrossOriginCandidates,
                  currentUrl,
                );
                // Merge overflow evidence from every snapshot (pre-click,
                // reservation, post-click) into one URL-deduplicated set. A
                // click that replaces the document must not erase the original
                // page's unclassified destinations, and a destination seen in
                // both snapshots must not be counted twice.
                for (const url of pursuableRenderedOverflowUrls(collection.overflowCandidates, currentUrl)) {
                  crossOriginOverflowEligible.add(url);
                }
                // A later snapshot can promote an earlier overflow destination
                // into its visible candidate window (an interaction removed
                // anchors ahead of it). Carry every label sampled for that URL
                // forward before classifying it: the visible anchor may be
                // weak ("About") while the overflow sample carries the
                // community label that made the destination pursuable.
                for (const candidate of collection.overflowCandidates) {
                  const key = normalizeVisitUrl(candidate.url) || String(candidate.url || '').trim();
                  if (!key) continue;
                  const labels = crossOriginOverflowLabels.get(key) || [];
                  const text = String(candidate.text || '').trim();
                  if (text && !labels.includes(text)) labels.push(text);
                  crossOriginOverflowLabels.set(key, labels);
                }
                for (const candidate of collection.candidates) {
                  recoverRenderedOverflowCandidate(
                    candidate,
                    crossOriginOverflowLabels,
                    crossOriginOverflowEligible,
                  );
                }
                if (collection.overflowSampleFilled === true) crossOriginOverflowSampleFilled = true;
                return collection.candidates;
              } catch {
                // A control may have replaced or detached the document
                // between the click loop and this pass. Enqueueing nothing is
                // safe; the post-click same-host pass has already run.
                return [];
              }
            };
            let preClickCrossOriginCandidates: RenderedCrossOriginCandidate[] = [];
            const crossOriginOverflowEligible = new Set<string>();
            const crossOriginOverflowLabels = new Map<string, string[]>();
            let crossOriginOverflowSampleFilled = false;
            /**
             * Publish collector overflow once per page, after every snapshot
             * has been merged. Pursuit OFF treats eligible overflow as a
             * deliberate policy exclusion; pursuit ON treats it as a bounded
             * collector gap. An exhausted overflow sample is a gap in both
             * modes because later anchors were never classified.
             */
            const publishCrossOriginOverflow = (): void => {
              // Queued or already-inspected destinations are covered work, not
              // truncation. This removes an overflow URL that a later snapshot
              // admitted, as well as destinations another page already
              // inspected, before the remaining gap is published.
              for (const key of crossOriginQueued) crossOriginOverflowEligible.delete(key);
              for (const url of [...alreadyVisitedSet, ...terminalSuccessUrls]) {
                const key = normalizeVisitUrl(url);
                if (key) crossOriginOverflowEligible.delete(key);
              }
              const overflowEligible = crossOriginOverflowEligible.size;
              if (!limits.crossOriginEnqueue) {
                if (overflowEligible > 0) {
                  drops.count('cross-origin-disallowed', overflowEligible);
                } else if (crossOriginOverflowSampleFilled) {
                  candidateCapTruncated = Math.max(candidateCapTruncated, 1);
                }
                return;
              }
              if (overflowEligible > 0) {
                candidateCapTruncated = Math.max(candidateCapTruncated, overflowEligible);
              } else if (crossOriginOverflowSampleFilled) {
                candidateCapTruncated = Math.max(candidateCapTruncated, 1);
              }
            };
            /**
             * `submit=false` reserves the cap-owned destinations for the click
             * plan without enqueueing them. `submit=true` performs the single
             * actual submission after interactions, so optional work never
             * takes queue positions ahead of post-click same-host links.
             */
            const enqueueCrossOrigin = async (submit = true): Promise<void> => {
              if (Date.now() - startedAt >= limits.totalTimeoutMs) return;
              // The default-OFF path only needs the post-click accounting pass;
              // there is nothing to reserve because nothing may be enqueued.
              if (!limits.crossOriginEnqueue && !submit) return;
              // Post-click candidates are collected against the current document
              // and merged with the pre-click snapshot, so a click that replaced
              // the document loses neither set. Overflow from both snapshots was
              // merged by the collector and is published once, here.
              const latestCandidates = await collectCrossOriginCandidates();
              const candidates = [...preClickCrossOriginCandidates, ...latestCandidates];
              if (!limits.crossOriginEnqueue) {
                // Opt-in pursuit is OFF: every eligible destination (including
                // those beyond the cap) is a deliberate policy exclusion. This
                // keeps the run partial instead of certifying a clean absence.
                // This is the only pass that runs with pursuit OFF (the
                // pre-click reservation returns above), so it publishes
                // overflow exactly once.
                publishCrossOriginOverflow();
                const plan = planRenderedCrossOriginEnqueues({
                  candidates,
                  currentUrl: page.url(),
                  alreadyVisited: renderedCrossOriginVisitedIdentities(alreadyVisitedSet, terminalSuccessUrls),
                  queued: crossOriginQueued,
                  maxEnqueues: 0,
                });
                if (plan.irrelevant) drops.count('hint-rejected', plan.irrelevant);
                if (plan.admissionRejected) drops.count('admission-rejected', plan.admissionRejected);
                const eligibleNotPursued = plan.admitted.length + plan.budget;
                if (eligibleNotPursued > 0) drops.count('cross-origin-disallowed', eligibleNotPursued);
                return;
              }
              if (!submit) {
                // Reserve the destinations this page would enqueue. The click
                // plan can then distinguish cap-owned hubs from over-cap hubs
                // that must stay clickable. Nothing is submitted here, so the
                // reservation cannot consume a queue slot ahead of required
                // same-host work revealed later in the click loop.
                const plan = planRenderedCrossOriginEnqueues({
                  candidates,
                  currentUrl: page.url(),
                  alreadyVisited: renderedCrossOriginVisitedIdentities(alreadyVisitedSet, terminalSuccessUrls),
                  queued: crossOriginQueued,
                  maxEnqueues: MAX_RENDERED_CROSS_ORIGIN_ENQUEUES - crossOriginQueued.size - crossOriginReserved.size,
                });
                for (const url of plan.admitted) {
                  const key = normalizeVisitUrl(url) || url;
                  if (!crossOriginQueued.has(key)) crossOriginReserved.add(key);
                }
                return;
              }
              // Every snapshot has now been collected and merged, so this is
              // the single publish point for overflow evidence.
              publishCrossOriginOverflow();
              await enqueueRenderedCrossOriginPass({
                collect: async () => candidates,
                currentUrl: page.url(),
                alreadyVisited: renderedCrossOriginVisitedIdentities(alreadyVisitedSet, terminalSuccessUrls),
                queued: crossOriginQueued,
                maxEnqueues: MAX_RENDERED_CROSS_ORIGIN_ENQUEUES - crossOriginQueued.size,
                enqueue: async urls => {
                  // Tag optional third-party pages so their handler skips the
                  // uncapped same-host hint passes (the crawl-wide cap bounds
                  // the whole optional branch, not just the first hop).
                  await enqueueLinks({ urls, strategy: 'all', userData: { crossOrigin: true } });
                  crossOriginEnqueued += urls.length;
                },
                countDrop: (reason, count) => drops.count(reason, count),
              });
              crossOriginReserved.clear();
            };
            // Popups opened by a click are drained immediately after the
            // click settles. Same-origin destinations are admitted as bounded
            // page requests; cross-origin destinations are policy exclusions
            // and are never navigated to. Every popup is closed so it cannot
            // outlive the request or consume an unbudgeted page.
            const drainPopups = async (): Promise<void> => {
              // Catch a popup whose context page event was delivered after
              // the click settled (notably COOP-severed popups).
              await captureSiblingPages();
              while (pendingPopups.length) {
                const { popup, openerUrl } = pendingPopups.shift()!;
                let popupUrl = '';
                try {
                  // Wait for the popup to commit an HTTP(S) document. A popup
                  // can be observed at `about:blank` before its navigation
                  // starts; reading too early would turn a real destination
                  // into a false "unclassifiable" drop. The wait is bounded by
                  // both the popup cap and the remaining crawl budget so a
                  // queue of pending popups cannot outlive the request.
                  const popupWaitMs = renderedPopupWaitTimeoutMs(limits.totalTimeoutMs - (Date.now() - startedAt));
                  if (popupWaitMs > 0) {
                    await popup.waitForURL?.(
                      target => target.protocol === 'http:' || target.protocol === 'https:',
                      { timeout: popupWaitMs },
                    ).catch(() => undefined);
                  }
                  popupUrl = popup.url();
                } catch { /* about:blank or already closed */ }
                // Classify against the opener URL captured when the popup was
                // observed: the same click may have navigated the opener away,
                // and `page.url()` now names a different origin.
                const kind = classifyRenderedPopupDestination(popupUrl, openerUrl);
                // A blank popup can still hold document.write() markup with an
                // invite. A generic Discord-host page is not terminal evidence
                // either: its URL has no invite, so inspect its document for
                // invite markup before treating the destination as unexamined.
                // An allowed same-origin popup may likewise contain markup the
                // opener wrote after load that a fresh request cannot
                // reproduce, so snapshot it before closing instead of relying
                // on the queued re-open alone. In every case the popup remains
                // an unexamined navigation surface, but its contents are no
                // longer silently lost.
                const genericDiscordPopup = kind !== 'discord' && isDiscordDestinationUrl(popupUrl);
                let popupContent = '';
                if ((kind === 'uninspectable' || kind === 'same-origin' || genericDiscordPopup) && popup.content) {
                  try { popupContent = await popup.content(); } catch { /* best effort */ }
                }
                await popup.close().catch(() => undefined);
                if (popupContent) {
                  retain(
                    popupContent,
                    popupMarkupEvidenceSourceUrl(kind, popupUrl, openerUrl),
                  );
                }
                if (kind === 'uninspectable') {
                  // A popup that never committed a navigable URL cannot be
                  // classified. It is still an unexamined interaction surface.
                  popupDestinationsDropped++;
                  continue;
                }
                if (kind === 'discord') {
                  // The popup opened a direct Discord invite. The URL is
                  // terminal evidence; never discard it as a policy exclusion
                  // or consume a bounded page request to re-open it.
                  retain(popupUrl, openerUrl);
                  popupCaptured++;
                  continue;
                }
                const key = normalizeVisitUrl(popupUrl) || popupUrl;
                if (alreadyVisitedSet.has(key) || popupQueued.has(key) || crossOriginQueued.has(key) || revealedQueued.has(key)) continue;
                if (kind === 'cross-origin') {
                  // The popup opened, but its cross-origin content was never
                  // inspected. Record the policy exclusion; never navigate to
                  // it here.
                  drops.count('cross-origin-disallowed');
                  continue;
                }
                if (kind === 'admission-rejected') {
                  drops.count('admission-rejected');
                  continue;
                }
                if (Date.now() - startedAt >= limits.totalTimeoutMs) {
                  popupDestinationsDropped++;
                  continue;
                }
                if (crossOriginRequest && crossOriginQueued.size >= MAX_RENDERED_CROSS_ORIGIN_ENQUEUES) {
                  // A popup opened by an optional third-party page is part of
                  // the same capped branch. It is deterministic optional work,
                  // not retryable page-budget loss.
                  drops.count('destination-budget');
                  continue;
                }
                popupQueued.set(key, popupUrl);
                popupCaptured++;
                try {
                  await enqueueLinks({
                    urls: [popupUrl],
                    strategy: 'all',
                    ...(crossOriginRequest ? { userData: { crossOrigin: true } } : {}),
                  });
                  if (crossOriginRequest) {
                    crossOriginQueued.add(key);
                    crossOriginEnqueued++;
                  }
                } catch {
                  popupQueued.delete(key);
                  popupCaptured = Math.max(0, popupCaptured - 1);
                  popupDestinationsDropped++;
                }
              }
            };
            // Capture the original document's anchors before a click can
            // replace it. The post-click pass merges this snapshot, so a click
            // to another document loses neither set.
            preClickCrossOriginCandidates = await collectCrossOriginCandidates();
            if (!crossOriginRequest && Date.now() - startedAt < limits.totalTimeoutMs) {
              await enqueueSameHostHints();
            }
            // P1.6: opt-in, bounded cross-origin pass. The pre-click call only
            // reserves cap-owned destinations for the click plan; the single
            // actual submission runs after interactions so JS-revealed
            // required same-host links are queued first.
            await enqueueCrossOrigin(false);

            // A navigable anchor is excluded from clicks because either the
            // enqueue policy owns it (same-origin hint match) or it is
            // cross-origin and must never navigate the document. Its live
            // text+href can postdate the last page.content() snapshot, so
            // retain it here before the click planner drops it; otherwise a
            // JS-inserted direct Discord/invite href would be lost entirely.
            retainSkippableAnchorEvidence(controls, page.url(), retain, {
              crossOriginPursued: crossOriginPursuitActive(),
              queuedDestinations: isQueuedDestination,
            });
            // Navigable same-host anchors are already discovered through
            // enqueueLinks and Discord-scanned before any click, so the click
            // budget is reserved for controls that only a click can act on
            // (href-less buttons, fragments, JS links, cross-host targets).
            // Slice accounting covers the remainder beyond clicks and skips.
            const clickPlan = partitionRenderedClickTargets(
              controls,
              page.url(),
              limits.maxClicksPerPage,
              limits.clickOffset,
              undefined,
              {
                crossOriginPursued: crossOriginPursuitActive(),
                queuedDestinations: isQueuedDestination,
              },
            );
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
                && !isSkippableNavigableAnchorClick(control, page.url(), {
                  crossOriginPursued: crossOriginPursuitActive(),
                  queuedDestinations: isQueuedDestination,
                })) {
                countedControlSkips.add(control.marker);
              }
            }
            // Overflow beyond the evaluation window is already counted by
            // recordControlEnumeration. This second count covers only controls
            // inside the window that the click budget could not examine.
            const sliceSkippedTargets = clickPlan.evaluationWindow.filter(target =>
              !clickPlan.toClick.some(planned => planned.marker === target.marker)
              && !isSkippableNavigableAnchorClick(target, page.url()));
            const sliceDropped = sliceSkippedTargets.length;
            if (sliceDropped > 0) {
              // Every enumerated control matched the community-evidence filter;
              // dropping one for budget means its content was never examined.
              // Generic disclosures are opportunistic, so only hint/icon skips
              // make the page retryable.
              drops.count('control-slice', sliceDropped);
              evidenceControlsSkipped += sliceDropped;
              if (renderedControlSkipsNeedInteractionGap(sliceSkippedTargets)) interactionGap = true;
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
                  await drainPopups();
                  // Preserve a newly revealed destination before the next click
                  // replaces the panel that contains it. This is the only pass
                  // that reports a saturated-baseline gap: it runs on the
                  // document where the interaction actually happened, while the
                  // post-loop pass may be looking at a click-navigated document.
                  await captureRevealedSameOrigin(true);
                  return clickOutcome.ok;
                },
                enumerate: enumerateControls,
                pageUrl: () => page.url(),
                // Same-document history updates keep performance.timeOrigin;
                // a real navigation commits a new document and changes it.
                documentIdentity: () => page.evaluate(() => performance.timeOrigin),
                clickOffset: limits.clickOffset,
                crossOriginPursued: crossOriginPursuitActive(),
                queuedDestinations: isQueuedDestination,
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
            // Safety net for a popup whose window.open fired after the last
            // per-click drain (for example a short-delayed handler).
            if (pendingPopups.length) await drainPopups();
            // Interaction can create closed roots or navigate to a document
            // whose declarative root the response listener has now observed.
            await recordPageContext();
            await recordDeclarativeShadowScan();
            // Interaction-revealed same-origin admission. Links that did not
            // exist in the current document's pre-interaction baseline and
            // carry no community hint (for example a JS-inserted `/resources`
            // path) are still legitimate navigation: the page deliberately
            // revealed them. Per-click passes already captured panels that a
            // later click replaced; this final pass catches scroll-revealed
            // links and the last click's additions. Per-click passes already
            // recorded any saturated-baseline gap on the interacted document;
            // this final pass must not attribute that interaction to a
            // click-navigated document.
            await captureRevealedSameOrigin(false);
            if (revealedScanFailed) {
              // An interaction surface existed but could not be enumerated;
              // a revealed destination may exist. Never certify clean.
              revealedSameOriginDropped++;
            } else if (!initialLinksCaptured && clickLoop.evidenceControlsClicked > 0) {
              // No trustworthy pre-interaction baseline: any link the clicks
              // revealed cannot be distinguished from static navigation.
              revealedSameOriginDropped++;
            }
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

            if (!crossOriginRequest && Date.now() - startedAt < limits.totalTimeoutMs) {
              await enqueueSameHostHints();
            }
            await enqueueCrossOrigin();
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
                const currentIdentity = await page.evaluate(() => performance.timeOrigin).catch(() => null);
                const sameDocument = isSameSeedDocument(
                  seedSnapshotIdentity,
                  currentIdentity,
                  seedSnapshotUrl,
                  currentUrl,
                );
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
            // Final drain: no popup may outlive the request or be silently
            // discarded when the interaction handlers finish.
            await drainPopups();
            stopPopupCapture();
            // Success is recorded only after the request's full page-processing
            // lifecycle completes (load, scroll traversal, control enumeration,
            // link enqueueing). A later terminal failure propagates before this
            // mark, so an earlier success can never erase it; a later full
            // success resolves an earlier failure (retry recovery). Click
            // handling owns no marks: clicks never affect terminal accounting.
            markRenderedRequestSucceeded(requestTracker, request.url);
            // A click-committed replacement document was never enumerated or
            // clicked. Borrow only the document the loop actually processed;
            // its replacement must prove itself through its own request.
            for (const identity of renderedTerminalSuccessIdentities({
              requestUrl: request.url,
              initialDocumentUrl: clickLoop.initialDocumentUrl,
              inspectedDocumentUrl: clickLoop.processedDocumentUrl,
              finalDocumentUrl: page.url(),
              documentReplacedByClick: clickLoop.documentReplaced,
            })) {
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
              stopPopupCapture();
              for (const { popup } of pendingPopups.splice(0)) {
                await popup.close().catch(() => undefined);
              }
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
        const queueBudgetExhausted = pendingEligibleRequests === null
          ? reachedPageBudget
          : pendingEligibleRequests > 0 && reachedPageBudget;
        const timedOut=Date.now()-startedAt>=limits.totalTimeoutMs;
        telemetry.unresolvedFailedRequests=renderedUnresolvedFailureCount(requestTracker);
        // Terminal stop attribution: a complete crawl below the page budget
        // with nothing still queued ended for lack of enqueueable links;
        // eligible requests still queued mean the request budget cut coverage.
        // v2 required-set classification (pure helper): the seed document plus
        // its directly discovered same-host community-hint links, partitioned
        // by terminal state. Shared-covered members count as visited: the
        // already-visited exclusion set carries terminal-success rendered
        // evidence by contract, so it can never manufacture a false
        // REQUIRED_UNVISITED gap. Depth-2+ remainder is opportunistic by
        // definition and never appears here. Classification runs BEFORE
        // completion so required obligations can override both the queue's
        // zero-pending report and a successful final response.
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
          // Only terminal-success evidence may satisfy the required set:
          // caller-supplied visited keys plus this run's successful request and
          // final-page identities. A page that was merely read before its
          // request failed stays unvisited.
          const sharedCoveredKeys = new Set<string>(alreadyVisitedSet);
          for (const identity of terminalSuccessUrls) {
            const key = normalizeVisitUrl(identity);
            if (key) sharedCoveredKeys.add(key);
          }
          const classified = classifyRequiredCoverage({
            requiredKeys,
            succeededKeys,
            failedClassesByKey: failedByKey,
            sharedCoveredKeys,
          });
          requiredUnvisited.push(...classified.unvisited);
          requiredTransientFailures.push(...classified.transientFailures);
          requiredPermanentFailures.push(...classified.permanentFailures);
        }
        // Popup destinations captured during the crawl are resolved only when
        // their page was actually inspected. A popup left unvisited by the
        // page cap or a queue rejection is a bounded gap, never a clean run.
        for (const url of popupQueued.values()) {
          const key = normalizeVisitUrl(url);
          if (!key || !succeededKeys.has(key)) popupDestinationsDropped++;
        }
        // Same accounting for interaction-revealed same-origin links: an
        // admitted destination that Crawlee's request cap refused or the
        // crawl never reached is outstanding bounded work.
        for (const url of revealedQueued) {
          const key = normalizeVisitUrl(url);
          if (!key || !succeededKeys.has(key)) revealedSameOriginDropped++;
        }
        // Crawlee refuses to enqueue URLs past maxRequestsPerCrawl, so the
        // post-run queue can legitimately report zero pending while required
        // destinations were never visited. Outstanding required work at the
        // page cap is therefore a page-budget cutoff, not a clean stop.
        const requiredGapCount = requiredUnvisited.length
          + requiredTransientFailures.length
          + requiredPermanentFailures.length;
        // Only unvisited/transient required work can be recovered by another
        // attempt. A permanent required failure stays incomplete but must not
        // be dressed up as a bounded/retryable budget gap.
        const retryableRequiredGapCount = requiredUnvisited.length
          + requiredTransientFailures.length;
        const requiredWorkRemaining = requiredGapCount > 0;
        const pageBudgetExhausted = queueBudgetExhausted
          || (retryableRequiredGapCount > 0 && reachedPageBudget);
        // P1.7: publish the coverage certificate before completion so a
        // non-COMPLETE navigation surface can never resolve as a clean
        // absence. Budget/interaction/scroll gaps stay retryable; deterministic
        // policy/context gaps are visible partials without retry ownership.
        if (pageBudgetExhausted) drops.count('page-budget');
        const coverageReason = publishEvidenceControlCertificate(
          timedOut || pageBudgetExhausted,
          retryableRequiredGapCount,
        );
        const coverageGapRetryable = interactionGap || timedOut || pageBudgetExhausted
          || scrollCapReachedStillGrowing || contextMeasurementAbandoned
          || retryableRequiredGapCount > 0;
        const coverageRetryable = coverageGapRetryable || coverageReason === 'BOUNDED';
        const completion=resolveRenderedCompletionState({inspectedPages,timedOut,telemetry,pageBudgetExhausted,interactionGap,requiredWorkRemaining,coverageReason,coverageRetryable});
        const noPageProcessed=completion.failureClass==='NO_PAGE_PROCESSED';
        const zeroPageReason=resolveRenderedZeroPageReason({inspectedPages,timedOut,saturated:false,browserLaunchFailed:false,thrown:false,telemetry});
        if (zeroPageReason) telemetry.zeroPageReason=zeroPageReason;
        const candidates=mergeDiscordCandidates(discovered);
        const first=candidates[0];
        if (completion.queueComplete && !pageBudgetExhausted && inspectedPages < limits.maxPages) drops.count('queue-exhausted');
        // Persist the bounded control-coverage certificate alongside the
        // crawler telemetry so production can distinguish 64-overflow from
        // ordinary click-budget slicing. Counts only; never selectors/text.
        // P0.2 adds the coverage-reason certificate; P1.7 consumed it above.
        return {
          foundInvite:first?.nativeInviteCode||null,
          foundLocation:first?.sourceUrl,
          candidates,
          inspectedPages,scrolls,clicks,
          complete:completion.complete,
          retryable:completion.retryable,
          timedOut,
          coverageGapRetryable,
          failureClass:completion.failureClass,
          telemetry,
          dropReasons:drops.snapshot(),
          crossOriginEnqueued: crossOriginEnqueued || undefined,
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
          detail:resolveRenderedFallbackDetail({
            candidatesFound:candidates.length,
            inspectedPages,
            timedOut,
            telemetry,
            noPageProcessed,
            interactionGap,
            evidenceControlsFailed,
            evidenceControlsSkipped,
            coverageReason,
          }),
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
        return {foundInvite:candidates[0]?.nativeInviteCode||null,foundLocation:candidates[0]?.sourceUrl,candidates,inspectedPages,scrolls,clicks,complete:false,retryable:true,timedOut:false,coverageGapRetryable:true,failureClass,telemetry,dropReasons:drops.snapshot(),interactionGap:interactionGap||undefined,evidenceControlsTotal:evidenceControlsSeen||undefined,evidenceControlsClicked:evidenceControlsClicked||undefined,evidenceControlsFailed:evidenceControlsFailed||undefined,evidenceControlsSkipped:evidenceControlsSkipped||undefined,evidenceControlsNavigableOnly:(evidenceControlsNavigableOnly&&!evidenceControlsClickableWindow)||undefined,evidenceControlsUncertified:(evidenceControlsUncertified||uncertifiedRequestKeys.size>0)||undefined,evidenceControlsOffsetAdvance:evidenceControlsOffsetAdvance||undefined,detail:`Rendered acquisition unavailable or failed${causeSnippet?` (cause: ${causeSnippet})`:''}: ${browserFallbackTelemetrySummary(telemetry)}`};
      } finally {
        telemetry.crawlFinishedAt = new Date().toISOString();
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
    }), limits.admissionLane || 'UNKNOWN', { isWorkStarted: renderedCrawlStarted });
  } catch (error:any) {
    if (!telemetry.crawlFinishedAt) telemetry.crawlFinishedAt = new Date().toISOString();
    const candidates=mergeDiscordCandidates(discovered);
    const saturated=error?.message==='RENDERED_FALLBACK_SATURATED';
    const retryAtValue = Number(error?.retryAt);
    const retryAt = Number.isFinite(retryAtValue) && retryAtValue > 0 ? retryAtValue : undefined;
    const failedAdmissionId = Number(error?.admissionId);
    if (Number.isSafeInteger(failedAdmissionId) && failedAdmissionId > 0
      && !renderedCrawlStarted({ inspectedPages, telemetry })) {
      renderedFallbackGate.refund(failedAdmissionId);
    }
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
    return {foundInvite:candidates[0]?.nativeInviteCode||null,foundLocation:candidates[0]?.sourceUrl,candidates,inspectedPages,scrolls,clicks,complete:false,retryable:true,timedOut:false,failureClass,retryAt,telemetry,detail:saturated?`Rendered acquisition deferred because the process-wide browser launch gate is saturated; ${browserFallbackTelemetrySummary(telemetry)}`:`Rendered acquisition unavailable or failed${causeSnippet?` (cause: ${causeSnippet})`:''}: ${browserFallbackTelemetrySummary(telemetry)}`};
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
