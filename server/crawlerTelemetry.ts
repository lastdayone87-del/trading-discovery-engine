export type CrawlerAcquisitionMode = 'STATIC' | 'RENDERED';

/**
 * Closed taxonomy of why a discovered URL/page was not pursued. Counters
 * only — never URLs, HTML, or payloads — so retention stays memory-bounded
 * under the existing OOM protections.
 */
export const CRAWL_DROP_REASONS = [
  'invalid-protocol',
  /**
   * Shared crawl admission rejection (R6): a discovered seed or navigation
   * target failed VALIDATE or ASSET/RESOURCE checks and was excluded before
   * scoring, fetching, or queue-cap accounting.
   */
  'admission-rejected',
  'cross-origin-disallowed',
  'score-zero',
  'hint-rejected',
  'duplicate',
  'queue-cap',
  'depth-limit',
  'exploration-limit',
  /**
   * Per-seed cross-origin destination fan-out bound. A page with many
   * evidence-bearing external targets can exceed the bounded host/page budget;
   * skips set the seed ceiling so absence is never reported as complete.
   */
  'destination-budget',
  'already-visited',
  'control-slice',
  'page-budget',
  'queue-exhausted',
  /**
   * Frontier stopping-arbiter halt: the marginal-yield or remaining-value
   * floor (or budget) ended child exploration early under the P-C frontier
   * policy. Counted separately from exploration-limit so arbiter-driven
   * stops stay distinguishable from fixed-cap cutoffs in telemetry.
   */
  'frontier-yield-stop',
  /**
   * Bounded-response-cap truncation. Counted whenever a fetched response is
   * cut at MAX_CRAWL_RESPONSE_CHARS, independent of the single primary
   * ceiling label — so a later truncation is never lost when an earlier,
   * different cap already claimed `ceiling`.
   */
  'response-cap',
] as const;
export type CrawlDropReason = typeof CRAWL_DROP_REASONS[number];
export function isCrawlDropReason(value: unknown): value is CrawlDropReason {
  return typeof value === 'string' && (CRAWL_DROP_REASONS as readonly string[]).includes(value);
}

/**
 * Closed taxonomy of ceilings that can truncate crawl coverage. A ceiling
 * entry means a named cap cut coverage short — never a terminal failure
 * cause (HTTP, network, content-type, login walls, rate limits, browser
 * defects), which keep living in failureClass. Absent when no cap tripped.
 */
export const CEILING_KINDS = [
  'page-budget',
  'depth-limit',
  'queue-cap',
  'exploration-limit',
  'response-cap',
  'total-timeout',
  /** Frontier stopping-arbiter halt (see frontier-yield-stop above). */
  'frontier-yield',
] as const;
export type CeilingKind = typeof CEILING_KINDS[number];
export function isCeilingKind(value: unknown): value is CeilingKind {
  return typeof value === 'string' && (CEILING_KINDS as readonly string[]).includes(value);
}

/** Shared taxonomy/bound enforcement for drop counters, used both when
 * telemetry objects are constructed and when ledger rows are persisted, so
 * direct in-process consumers never receive invalid reason keys or
 * unbounded/non-integer counters either. */
export function sanitizeDropReasons(input: unknown): Partial<Record<CrawlDropReason, number>> {
  const drops: Partial<Record<CrawlDropReason, number>> = {};
  if (input && typeof input === 'object') {
    for (const [key, value] of Object.entries(input)) {
      if (isCrawlDropReason(key) && typeof value === 'number' && Number.isFinite(value) && value > 0) {
        drops[key] = Math.min(999999, Math.floor(value));
      }
    }
  }
  return drops;
}

/** Shared bound for scroll usage counters (positive ints, capped). */
export function sanitizeScrollsUsed(input: unknown): number {
  return typeof input === 'number' && Number.isFinite(input) && input > 0
    ? Math.min(999999, Math.floor(input))
    : 0;
}

/**
 * Bounded experiment-attribution record for persisted observations. Answers
 * which experimental treatment (if any) was active for an observation, so
 * ladder/frontier crawls stay distinguishable from legacy crawls in the
 * ledger. All fields are bounded (no URLs/payloads); absent means legacy
 * (no experimental treatment active). Sanitizer drops malformed values
 * rather than storing them.
 */
export interface ExperimentAttribution {
  /** Treatment policy versions active, e.g. ['acquisition-ladder-v1']. */
  policies: string[];
  /** Admission method, e.g. 'sitemap-seed', 'structured-navigation'. */
  method?: string;
  /** Ladder seed admission counts (admitted vs considered). */
  admittedSeeds?: number;
  consideredSeeds?: number;
  /** Render escalation outcome for rendered rows. */
  escalation?: 'none' | 'static' | 'rendered';
  /** Stopping-arbiter reason when a halt cut coverage short. */
  stoppingReason?: string;
}

const EXPERIMENT_ATTRIBUTION_STRING_MAX = 64;

export function sanitizeExperimentAttribution(input: unknown): ExperimentAttribution | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const candidate = input as Partial<ExperimentAttribution>;
  const text = (value: unknown): string | undefined => {
    if (typeof value !== 'string' || !value.trim()) return undefined;
    return value.replace(/\s+/g, ' ').trim().slice(0, EXPERIMENT_ATTRIBUTION_STRING_MAX) || undefined;
  };
  const count = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(999999, Math.floor(value)) : undefined;
  const policies = Array.isArray(candidate.policies)
    ? candidate.policies.map(text).filter((policy): policy is string => !!policy).slice(0, 4)
    : [];
  if (!policies.length) return undefined;
  const method = text(candidate.method);
  const admittedSeeds = count(candidate.admittedSeeds);
  const consideredSeeds = count(candidate.consideredSeeds);
  const escalation = candidate.escalation === 'none' || candidate.escalation === 'static' || candidate.escalation === 'rendered'
    ? candidate.escalation
    : undefined;
  const stoppingReason = text(candidate.stoppingReason);
  return {
    policies,
    ...(method ? { method } : {}),
    ...(admittedSeeds !== undefined ? { admittedSeeds } : {}),
    ...(consideredSeeds !== undefined ? { consideredSeeds } : {}),
    ...(escalation ? { escalation } : {}),
    ...(stoppingReason ? { stoppingReason } : {}),
  };
}

/** Tiny bounded counter for per-crawl drop/stop reasons (ints only). */
export interface DropCounter {
  count(reason: CrawlDropReason, n?: number): void;
  /**
   * Count once per key (typically the candidate URL): the anchor and dynamic
   * extraction passes can evaluate the same discovered link twice, and a
   * twice-seen candidate is still one lost candidate.
   */
  countUnique(reason: CrawlDropReason, key: string): void;
  snapshot(): Partial<Record<CrawlDropReason, number>>;
}
export function createDropCounter(): DropCounter {
  const counts = new Map<CrawlDropReason, number>();
  const seen = new Set<string>();
  return {
    count(reason, n = 1) {
      if (!isCrawlDropReason(reason)) return;
      if (!Number.isFinite(n) || n <= 0) return;
      counts.set(reason, (counts.get(reason) || 0) + Math.floor(n));
    },
    countUnique(reason, key) {
      if (!isCrawlDropReason(reason)) return;
      const marker = `${reason}\n${key}`;
      if (seen.has(marker)) return;
      seen.add(marker);
      counts.set(reason, (counts.get(reason) || 0) + 1);
    },
    snapshot() {
      return Object.fromEntries(counts);
    },
  };
}

export interface CrawlerTelemetry {
  mode: CrawlerAcquisitionMode;
  redirectsFollowed: number;
  pagesInspected: number;
  /**
   * True only when a named ceiling actually cut coverage short (see
   * `ceiling`). Derived, never set directly by crawlers: terminal failures
   * (HTTP, network, content-type, login walls, rate limits, browser defects)
   * must not inherit it from seed-level crawl state.
   */
  budgetExhausted: boolean;
  /**
   * The ceiling that truncated coverage, when one did. Absent means no cap
   * tripped for this observation — including terminal failures, which carry
   * their cause in failureClass instead.
   */
  ceiling?: { kind: CeilingKind };
  clicksStarted: number;
  clicksSucceeded: number;
  clicksFailed: number;
  requestsStarted: number;
  /**
   * Additive per-click failure taxonomy (fixed 7-kind keys; see
   * classifyRenderedClickFailure in renderedCrawlerPolicy.ts). Sparse:
   * omitted when no click has failed yet or the row predates instrumentation.
   * The coarser clickFailureClasses buckets live in detail text only and are
   * intentionally not part of this persisted interface.
   */
  clickFailureDetail?: Partial<Record<string, number>>;
  /**
   * Failed-click control kinds (anchor/button/role counts) and href-presence
   * count. Bounded aggregates only: no selectors, texts, or URLs. Sparse.
   */
  clickFailedTargetKinds?: { anchor?: number; button?: number; role?: number };
  clickFailedWithHref?: number;
  /**
   * Single sanitized first-failure sample per crawl ("kind|href|message",
   * URL-stripped, secrets-redacted, capped at 200 chars). Sparse. Never a
   * raw exception object or unbounded text.
   */
  firstClickFailureSample?: string;
  requestsFinished: number;
  requestsFailed: number;
  navigationTimeouts: number;
  blockedRequests: number;
  rateLimitedRequests: number;
  hostBackoffsApplied: number;
  /**
   * Bounded rendered-control coverage certificate (counts only, never
   * selectors/text/URLs). `Total` is the complete matched-control set on
   * processed pages; `Skipped` is the subset not examined because of the
   * 64-control evaluation window or click budget. Sparse: omitted when no
   * evidence-bearing control was enumerated or the row predates
   * instrumentation. Persisting these distinguishes 64-overflow from ordinary
   * click-budget slicing in production.
   */
  evidenceControlsTotal?: number;
  evidenceControlsClicked?: number;
  evidenceControlsFailed?: number;
  evidenceControlsSkipped?: number;
  /**
   * True when every processed page with controls had an entirely navigable
   * evaluation window: each window was fully examined with zero clicks, so
   * the durable retry offset may advance past it. Sparse; absent on rows that
   * predate instrumentation or when any page had clickable targets.
   */
  evidenceControlsNavigableOnly?: boolean;
  /**
   * True when a processed page had clickable controls inside its evaluation
   * window but recorded no progress (deadline, zero budget, detached marker).
   * The shared per-seed retry offset must not advance while such a window is
   * unexamined. Sparse; rendered-only.
   */
  evidenceControlsUncertified?: boolean;
  /**
   * Bounded full-pool positions the durable retry offset should advance: the
   * smallest per-page progress, so a page with a smaller pool is never rotated
   * past controls it did not examine. Sparse; absent on pre-instrumentation
   * rows.
   */
  evidenceControlsOffsetAdvance?: number;
  /**
   * Compact per-crawl drop/stop counters keyed by CRAWL_DROP_REASONS
   * (ints only, taxonomy-bounded to 13 keys — never URLs or payloads).
   * Tells future investigations where candidate URLs were lost. Sparse:
   * absent when nothing was dropped.
   */
  dropReasons?: Partial<Record<CrawlDropReason, number>>;
  /**
   * Rendered scroll iterations actually executed this crawl. Answers whether
   * maxScrollsPerPage binds. Sparse: absent when zero/unapplicable (static).
   */
  scrollsUsed?: number;
  /**
   * Stable worker-instance attribution (`hostname:pid`, cached per process).
   * Distinguishes deployment replicas and worker processes in the persisted
   * ledger; absent on rows predating instrumentation.
   */
  workerInstanceId?: string;
  /**
   * Furthest rendered-crawler lifecycle stage confirmed for this observation
   * (see RenderedLifecycleStage). Rendered-only: the ledger sanitizer drops
   * this field on STATIC rows so static telemetry can never carry rendered
   * diagnostics. Absent on rows predating instrumentation.
   */
  lastLifecycleStage?: string;
  /**
   * Explicit zero-page/pre-handler reason for rendered rows with no inspected
   * pages (see RenderedZeroPageReason). Rendered-only, same retention rule as
   * lastLifecycleStage. Never a substitute for failureClass: retry and outcome
   * semantics keep reading failureClass; this field exists so zero-page
   * results are diagnosable instead of generic.
   */
  zeroPageReason?: string;
  /**
   * Bounded underlying launch/start error text (whitespace-collapsed, capped,
   * secrets redacted before persistence). Rendered-only, same retention rule.
   * Preserves the actual Playwright/browser cause instead of only the generic
   * classifier label.
   */
  launchCauseSnippet?: string;
  /**
   * Experimental treatment attribution (see ExperimentAttribution). Sparse:
   * absent on legacy crawls and on rows predating instrumentation.
   */
  experimentAttribution?: ExperimentAttribution;
}

import os from 'node:os';

/**
 * Closed lifecycle taxonomy for the rendered crawler: the furthest stage with
 * affirmative evidence. Every zero-page outcome must map to one of these via
 * resolveRenderedZeroPageReason so the ledger tells where the crawl stopped:
 * seed accepted → gate acquired → crawler running → handler entered (navigation
 * completed) → page processed. Defined here (not in the fallback) so the
 * ledger sanitizer can validate persisted values without a dependency cycle.
 */
export const RENDERED_LIFECYCLE_STAGES = [
  'GATE_QUEUED',
  'GATE_ACQUIRED',
  'CRAWLER_RUNNING',
  'HANDLER_ENTERED',
  'PAGE_PROCESSED',
] as const;
export type RenderedLifecycleStage = typeof RENDERED_LIFECYCLE_STAGES[number];
export function isRenderedLifecycleStage(value: unknown): value is RenderedLifecycleStage {
  return typeof value === 'string' && (RENDERED_LIFECYCLE_STAGES as readonly string[]).includes(value);
}

/**
 * Closed zero-page/pre-handler reason taxonomy. Each reason names a concrete,
 * technically distinguishable terminal condition for inspectedPages===0 —
 * never a generic bucket. Kept separate from failureClass (which drives retry
 * and outcome semantics) so diagnosis never perturbs accounting.
 */
export const RENDERED_ZERO_PAGE_REASONS = [
  'GATE_SATURATED',
  'CRAWLER_START_FAILED',
  'BROWSER_LAUNCH_FAILED',
  'CRAWLER_RUN_THREW',
  'PRE_HANDLER_REQUEST_FAILURE',
  'DEADLINE_BEFORE_ADMISSION',
  'HANDLER_ENTERED_NO_PAGES',
  'CRAWLER_RETURNED_WITHOUT_REQUESTS',
] as const;
export type RenderedZeroPageReason = typeof RENDERED_ZERO_PAGE_REASONS[number];
export function isRenderedZeroPageReason(value: unknown): value is RenderedZeroPageReason {
  return typeof value === 'string' && (RENDERED_ZERO_PAGE_REASONS as readonly string[]).includes(value);
}

let cachedWorkerInstanceId: string | null = null;
/**
 * Stable per-process worker identity (`hostname:pid:startup discriminator`).
 * On Railway the hostname names the replica container; the pid and the
 * startup discriminator (random per process boot) make the id unique even
 * when a pid is reused after a worker restart. Cached: constant for the life
 * of the process, different across restarts. Documented as worker/process
 * provenance, not deployment provenance: no platform deployment id is
 * consumed, because none is reliably available at runtime.
 */
export function workerInstanceId(): string {
  if (!cachedWorkerInstanceId) {
    const host = (os.hostname() || 'unknown-host').toLowerCase();
    const discriminator = Math.floor(Math.random() * 0xffffffff)
      .toString(16)
      .padStart(8, '0');
    cachedWorkerInstanceId = `${host}:${process.pid}:${discriminator}`;
  }
  return cachedWorkerInstanceId;
}

export function emptyCrawlerTelemetry(mode: CrawlerAcquisitionMode): CrawlerTelemetry {
  return {
    mode,
    redirectsFollowed: 0,
    pagesInspected: 0,
    budgetExhausted: false,
    clicksStarted: 0,
    clicksSucceeded: 0,
    clicksFailed: 0,
    requestsStarted: 0,
    requestsFinished: 0,
    requestsFailed: 0,
    navigationTimeouts: 0,
    blockedRequests: 0,
    rateLimitedRequests: 0,
    hostBackoffsApplied: 0,
  };
}

export function renderedCrawlerTelemetry(input: {
  inspectedPages: number;
  clicks: number;
  complete: boolean;
  timedOut?: boolean;
  telemetry?: Partial<CrawlerTelemetry>;
  dropReasons?: Partial<Record<CrawlDropReason, number>>;
  scrollsUsed?: number;
  ceiling?: CeilingKind;
  experimentAttribution?: ExperimentAttribution;
}): CrawlerTelemetry {
  // Ceiling precedence: explicit > page-budget evidence > total timeout.
  // A timeout alone still records total-timeout (an elapsed budget is a
  // ceiling), but never inherits an unrelated cap, and terminal failures
  // without any cap carry no ceiling at all.
  const ceilingKind = input.ceiling
    ?? (sanitizeDropReasons(input.dropReasons)['page-budget'] ? 'page-budget' as const : undefined)
    ?? (input.timedOut ? 'total-timeout' as const : undefined);
  // A spread-carried ceiling/budget flag could only ever be stale (inner
  // telemetry never owns the ceiling decision), so both are stripped before
  // the derived values below are set.
  const { ceiling: _staleCeiling, budgetExhausted: _staleExhausted, ...restTelemetry } = (input.telemetry || {}) as Partial<CrawlerTelemetry>;
  void _staleCeiling;
  void _staleExhausted;
  return {
    ...emptyCrawlerTelemetry('RENDERED'),
    ...restTelemetry,
    pagesInspected: input.inspectedPages,
    clicksSucceeded: input.clicks,
    budgetExhausted: ceilingKind !== undefined,
    ...(ceilingKind ? { ceiling: { kind: ceilingKind } } : {}),
    // Instance attribution is always this process: telemetry objects are built
    // in-process per crawl, so a spread-carried id could only ever be stale.
    workerInstanceId: workerInstanceId(),
    mode: 'RENDERED',
    ...(Object.keys(sanitizeDropReasons(input.dropReasons)).length ? { dropReasons: sanitizeDropReasons(input.dropReasons) } : {}),
    ...(sanitizeScrollsUsed(input.scrollsUsed) > 0 ? { scrollsUsed: sanitizeScrollsUsed(input.scrollsUsed) } : {}),
    ...(sanitizeExperimentAttribution(input.experimentAttribution) ? { experimentAttribution: sanitizeExperimentAttribution(input.experimentAttribution)! } : {}),
  };
}

export function staticCrawlerTelemetry(input: {
  redirectsFollowed: number;
  pagesInspected: number;
  ceiling?: CeilingKind;
  dropReasons?: Partial<Record<CrawlDropReason, number>>;
  experimentAttribution?: ExperimentAttribution;
}): CrawlerTelemetry {
  return {
    ...emptyCrawlerTelemetry('STATIC'),
    redirectsFollowed: Math.max(0, Math.floor(input.redirectsFollowed)),
    pagesInspected: Math.max(0, Math.floor(input.pagesInspected)),
    budgetExhausted: input.ceiling !== undefined,
    ...(input.ceiling ? { ceiling: { kind: input.ceiling } } : {}),
    workerInstanceId: workerInstanceId(),
    ...(Object.keys(sanitizeDropReasons(input.dropReasons)).length ? { dropReasons: sanitizeDropReasons(input.dropReasons) } : {}),
    ...(sanitizeExperimentAttribution(input.experimentAttribution) ? { experimentAttribution: sanitizeExperimentAttribution(input.experimentAttribution)! } : {}),
  };
}

/**
 * Bounded click-failure taxonomy sanitizer (closed 7-kind keys, non-negative
 * ints, additionally clamped to maxTotal so persisted counters can never
 * exceed the crawl's actual click attempts). Unknown keys, non-finite, and
 * non-positive values are dropped rather than stored. Clamping spends a fixed
 * taxonomy-order budget, so both per-key and total counts stay bounded.
 */
const CLICK_FAILURE_DETAIL_KEYS = [
  'timeout',
  'detached_stale',
  'overlay_intercepted',
  'nav_interrupted',
  'target_closed',
  'network',
  'other',
] as const;

function clampCountRecord(
  record: Record<string, unknown>,
  keys: readonly string[],
  maxTotal: number,
): Partial<Record<string, number>> | undefined {
  // Infinity (the default when callers omit maxTotal) means an unlimited
  // budget: direct callers retain valid counters unclamped, while
  // safeCrawlerTelemetry always passes the finite clicksStarted count so
  // persisted rows stay bounded by actual attempts. Only finite positive
  // budgets clamp; anything else yields no positive counts.
  const unlimited = maxTotal === Number.POSITIVE_INFINITY;
  const budget = unlimited ? Number.POSITIVE_INFINITY : Number.isFinite(maxTotal) && maxTotal > 0 ? Math.floor(maxTotal) : 0;
  const out: Partial<Record<string, number>> = {};
  let remaining = budget;
  for (const key of keys) {
    if (remaining <= 0) break;
    const entry = record[key];
    if (typeof entry === 'number' && Number.isFinite(entry) && entry > 0) {
      const taken = unlimited ? Math.floor(entry) : Math.min(Math.floor(entry), remaining);
      if (taken > 0) {
        out[key] = taken;
        remaining -= taken;
      }
    }
  }
  return Object.keys(out).length ? out : undefined;
}

export function sanitizeClickFailureDetail(
  value: unknown,
  maxTotal: number = Number.POSITIVE_INFINITY,
): Partial<Record<string, number>> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return clampCountRecord(value as Record<string, unknown>, CLICK_FAILURE_DETAIL_KEYS, maxTotal);
}

const CLICK_TARGET_KIND_KEYS = ['anchor', 'button', 'role'] as const;

export function sanitizeClickFailedTargetKinds(
  value: unknown,
  maxTotal: number = Number.POSITIVE_INFINITY,
): { anchor?: number; button?: number; role?: number } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return clampCountRecord(value as Record<string, unknown>, CLICK_TARGET_KIND_KEYS, maxTotal) as
    | { anchor?: number; button?: number; role?: number }
    | undefined;
}

/**
 * First-failure sample sanitizer for the persistence boundary: strips URLs
 * and query strings, then applies the shared secret redaction, capped at 200
 * chars. Mirrors buildClickFailureSample's producer-side sanitation so ledger
 * rows are safe even if a caller passes unsanitized text.
 */
export function sanitizeClickFailureSample(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const stripped = value.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, '[url]').replace(/[\r\n\t]+/g, ' ').trim();
  const redacted = redactCauseSnippet(stripped, 200);
  if (!redacted) return undefined;
  return redacted.slice(0, 200) || undefined;
}

export function safeCrawlerTelemetry(input: unknown): CrawlerTelemetry | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const candidate = input as Partial<CrawlerTelemetry>;
  if (candidate.mode !== 'STATIC' && candidate.mode !== 'RENDERED') return undefined;
  const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  // Bounded sanitized string: collapsed whitespace, capped length. Non-string
  // input yields undefined so malformed persisted rows cannot smuggle text.
  const text = (value: unknown, max: number): string | undefined => {
    if (typeof value !== 'string' || !value.trim()) return undefined;
    return value.replace(/\s+/g, ' ').trim().slice(0, max) || undefined;
  };
  // Lifecycle stage, zero-page reason, and browser cause are rendered-only
  // diagnostics (see browserCommunityFallback): the sanitizer drops them on
  // STATIC rows so static telemetry can never carry rendered diagnostics.
  // The cause additionally passes through the redaction routine — truncation
  // alone is not redaction, and the sanitizer must stay safe even if a caller
  // passes unredacted text. Unknown taxonomy values are dropped rather than
  // stored. Rows predating instrumentation simply omit these fields.
  const stage = candidate.mode === 'RENDERED' ? text(candidate.lastLifecycleStage, 40) : undefined;
  const reason = candidate.mode === 'RENDERED' ? text(candidate.zeroPageReason, 40) : undefined;
  const cause = candidate.mode === 'RENDERED' ? redactCauseSnippet(candidate.launchCauseSnippet) : undefined;
  // Drop-reason counters and scroll usage are compact ints under a closed
  // taxonomy (no URLs/payloads); unknown keys, non-finite, and non-positive
  // values are dropped rather than stored. Allowed on both modes: static
  // records enqueue/drop reasons, rendered records those plus scroll usage.
  // Shared with the constructors so direct consumers get the same bounds as
  // persisted rows.
  const drops = sanitizeDropReasons(candidate.dropReasons);
  const scrolls = sanitizeScrollsUsed(candidate.scrollsUsed);
  const attribution = sanitizeExperimentAttribution(candidate.experimentAttribution);
  const instance = text(candidate.workerInstanceId, 120);
  const ceiling = candidate.ceiling && typeof candidate.ceiling === 'object' && isCeilingKind((candidate.ceiling as { kind?: unknown }).kind)
    ? { kind: (candidate.ceiling as { kind: CeilingKind }).kind }
    : undefined;
  // Backward compatibility: rows persisted before ceiling taxonomy keep
  // their recorded boolean (only new rows are derived strictly). The
  // constructors above never emit budgetExhausted without a ceiling.
  const legacyExhausted = candidate.budgetExhausted === true;
  return {
    ...emptyCrawlerTelemetry(candidate.mode),
    redirectsFollowed: number(candidate.redirectsFollowed),
    pagesInspected: number(candidate.pagesInspected),
    budgetExhausted: ceiling !== undefined || legacyExhausted,
    clicksStarted: number(candidate.clicksStarted),
    clicksSucceeded: number(candidate.clicksSucceeded),
    clicksFailed: number(candidate.clicksFailed),
    requestsStarted: number(candidate.requestsStarted),
    requestsFinished: number(candidate.requestsFinished),
    requestsFailed: number(candidate.requestsFailed),
    navigationTimeouts: number(candidate.navigationTimeouts),
    blockedRequests: number(candidate.blockedRequests),
    rateLimitedRequests: number(candidate.rateLimitedRequests),
    hostBackoffsApplied: number(candidate.hostBackoffsApplied),
    ...(candidate.mode === 'RENDERED' && number(candidate.evidenceControlsTotal) > 0
      ? { evidenceControlsTotal: number(candidate.evidenceControlsTotal) }
      : {}),
    ...(candidate.mode === 'RENDERED' && number(candidate.evidenceControlsClicked) > 0
      ? { evidenceControlsClicked: number(candidate.evidenceControlsClicked) }
      : {}),
    ...(candidate.mode === 'RENDERED' && number(candidate.evidenceControlsFailed) > 0
      ? { evidenceControlsFailed: number(candidate.evidenceControlsFailed) }
      : {}),
    ...(candidate.mode === 'RENDERED' && number(candidate.evidenceControlsSkipped) > 0
      ? { evidenceControlsSkipped: number(candidate.evidenceControlsSkipped) }
      : {}),
    ...(candidate.mode === 'RENDERED' && (candidate as { evidenceControlsNavigableOnly?: unknown }).evidenceControlsNavigableOnly === true
      ? { evidenceControlsNavigableOnly: true }
      : {}),
    ...(candidate.mode === 'RENDERED' && (candidate as { evidenceControlsUncertified?: unknown }).evidenceControlsUncertified === true
      ? { evidenceControlsUncertified: true }
      : {}),
    ...(candidate.mode === 'RENDERED' && number(candidate.evidenceControlsOffsetAdvance) > 0
      ? { evidenceControlsOffsetAdvance: number(candidate.evidenceControlsOffsetAdvance) }
      : {}),
    ...(isRenderedLifecycleStage(stage) ? { lastLifecycleStage: stage } : {}),
    ...(isRenderedZeroPageReason(reason) ? { zeroPageReason: reason } : {}),
    ...(cause ? { launchCauseSnippet: cause } : {}),
    ...(instance ? { workerInstanceId: instance } : {}),
    ...(Object.keys(drops).length ? { dropReasons: drops } : {}),
    ...(scrolls > 0 ? { scrollsUsed: scrolls } : {}),
    ...(attribution ? { experimentAttribution: attribution } : {}),
    ...(ceiling ? { ceiling } : {}),
    ...(sanitizeClickFailureDetail(
      (candidate as { clickFailureDetail?: unknown }).clickFailureDetail,
      number(candidate.clicksStarted),
    )
      ? {
          clickFailureDetail: sanitizeClickFailureDetail(
            (candidate as { clickFailureDetail?: unknown }).clickFailureDetail,
            number(candidate.clicksStarted),
          )!,
        }
      : {}),
    ...(sanitizeClickFailedTargetKinds(
      (candidate as { clickFailedTargetKinds?: unknown }).clickFailedTargetKinds,
      number(candidate.clicksStarted),
    )
      ? {
          clickFailedTargetKinds: sanitizeClickFailedTargetKinds(
            (candidate as { clickFailedTargetKinds?: unknown }).clickFailedTargetKinds,
            number(candidate.clicksStarted),
          )!,
        }
      : {}),
    ...(typeof (candidate as { clickFailedWithHref?: unknown }).clickFailedWithHref === 'number' &&
    Number.isFinite((candidate as { clickFailedWithHref?: unknown }).clickFailedWithHref) &&
    (candidate as { clickFailedWithHref?: number }).clickFailedWithHref! > 0
      ? {
          clickFailedWithHref: Math.min(
            Math.floor((candidate as { clickFailedWithHref?: number }).clickFailedWithHref!),
            number(candidate.clicksStarted),
          ),
        }
      : {}),
    ...(sanitizeClickFailureSample((candidate as { firstClickFailureSample?: unknown }).firstClickFailureSample)
      ? { firstClickFailureSample: sanitizeClickFailureSample((candidate as { firstClickFailureSample?: unknown }).firstClickFailureSample)! }
      : {}),
  };
}

/**
 * Bounded safe redaction for persisted/visible diagnostics. Truncation is not
 * redaction, and both launchCauseSnippet and acquisition detail persist —
 * so secrets are scrubbed before either receives the text:
 * - URL userinfo (`scheme://user:pass@host` → `scheme://***@host`);
 * - query/fragment values on sensitive keys (token, secret, key, auth,
 *   password, session, bearer) → `key=***`;
 * - bearer/basic authorization material → `Bearer ***, Basic ***`;
 * - password-style assignments (`\"password\": \"...\"`, `password=...`);
 * - home-directory filesystem paths (`/root/...`, `/home/<user>/...`).
 * Error classes, codes, hostnames, non-sensitive paths, and Chromium internals
 * survive: diagnostics keep everything that identifies the failure mode.
 */
export function redactCauseSnippet(raw: unknown, maxLength = 500): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  let out = raw.replace(/\s+/g, ' ').trim();
  out = out.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s:]+:)[^@/\s]+@/g, '$1***@');
  out = out.replace(/((?:^|[\s?&#;])(?:[^?&#;=\s]*?(?:token|secret|api[_-]?key|auth|password|passwd|pwd|credential|session|bearer)[^?&#;=]*)=)[^?&#;\s]*/gi, '$1***');
  out = out.replace(/\b([Bb]earer\s+)[A-Za-z0-9\-._~+/=]{4,}/g, '$1***');
  out = out.replace(/\b([Bb]asic\s+)[A-Za-z0-9+/=]{8,}/g, '$1***');
  out = out.replace(/((?:"|')?(?:password|passwd|pwd|secret|api[_-]?key)(?:"|')?\s*[:=]\s*"?)[^"\s,}]+/gi, '$1***');
  out = out.replace(/\/(?:root|home\/[^/\s'"]+)(?:\/[^\s'"]*)?/g, '/<redacted-path>');
  const flat = out.trim().slice(0, Math.max(1, maxLength));
  return flat || undefined;
}
