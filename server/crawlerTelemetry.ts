export type CrawlerAcquisitionMode = 'STATIC' | 'RENDERED';

export interface CrawlerTelemetry {
  mode: CrawlerAcquisitionMode;
  redirectsFollowed: number;
  pagesInspected: number;
  budgetExhausted: boolean;
  clicksStarted: number;
  clicksSucceeded: number;
  clicksFailed: number;
  requestsStarted: number;
  requestsFinished: number;
  requestsFailed: number;
  navigationTimeouts: number;
  blockedRequests: number;
  rateLimitedRequests: number;
  hostBackoffsApplied: number;
  /**
   * Stable worker-instance attribution (`hostname:pid`, cached per process).
   * Distinguishes deployment replicas and worker processes in the persisted
   * ledger; absent on rows predating instrumentation.
   */
  workerInstanceId?: string;
  /**
   * Furthest rendered-crawler lifecycle stage confirmed for this observation
   * (see RenderedLifecycleStage). Absent on static rows and pre-instrumentation
   * rendered rows.
   */
  lastLifecycleStage?: string;
  /**
   * Explicit zero-page/pre-handler reason for rendered rows with no inspected
   * pages (see RenderedZeroPageReason). Never a substitute for failureClass:
   * retry and outcome semantics keep reading failureClass; this field exists
   * so zero-page results are diagnosable instead of generic.
   */
  zeroPageReason?: string;
  /**
   * Bounded underlying launch/start error text (whitespace-collapsed, capped).
   * Preserves the actual Playwright/browser cause instead of only the generic
   * classifier label.
   */
  launchCauseSnippet?: string;
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
 * Stable per-process worker identity (`hostname:pid`). On Railway the
 * hostname is the replica container name, so distinct replicas (and distinct
 * worker processes after restarts) produce distinct ids, while one process
 * keeps its id for life. Cached: never changes identity mid-process.
 */
export function workerInstanceId(): string {
  if (!cachedWorkerInstanceId) {
    const host = (os.hostname() || 'unknown-host').toLowerCase();
    cachedWorkerInstanceId = `${host}:${process.pid}`;
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
}): CrawlerTelemetry {
  return {
    ...emptyCrawlerTelemetry('RENDERED'),
    ...input.telemetry,
    pagesInspected: input.inspectedPages,
    clicksSucceeded: input.clicks,
    // budgetExhausted must describe the actual budget/time state, never serve
    // as a generic "incomplete" label: blocked, zero-page, saturation, and
    // transient failures are incomplete without exhausting any budget.
    budgetExhausted: input.telemetry?.budgetExhausted === true || input.timedOut === true,
    // Instance attribution is always this process: telemetry objects are built
    // in-process per crawl, so a spread-carried id could only ever be stale.
    workerInstanceId: workerInstanceId(),
    mode: 'RENDERED',
  };
}

export function staticCrawlerTelemetry(input: {
  redirectsFollowed: number;
  pagesInspected: number;
  budgetExhausted: boolean;
}): CrawlerTelemetry {
  return {
    ...emptyCrawlerTelemetry('STATIC'),
    redirectsFollowed: Math.max(0, Math.floor(input.redirectsFollowed)),
    pagesInspected: Math.max(0, Math.floor(input.pagesInspected)),
    budgetExhausted: input.budgetExhausted === true,
    workerInstanceId: workerInstanceId(),
  };
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
  // Lifecycle stage and zero-page reason are validated against their closed
  // taxonomies (see browserCommunityFallback): unknown persisted values are
  // dropped rather than stored, keeping the ledger queryable. Rows predating
  // instrumentation simply omit these fields (backward compatible).
  const stage = text(candidate.lastLifecycleStage, 40);
  const reason = text(candidate.zeroPageReason, 40);
  return {
    ...emptyCrawlerTelemetry(candidate.mode),
    redirectsFollowed: number(candidate.redirectsFollowed),
    pagesInspected: number(candidate.pagesInspected),
    budgetExhausted: candidate.budgetExhausted === true,
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
    ...(isRenderedLifecycleStage(stage) ? { lastLifecycleStage: stage } : {}),
    ...(isRenderedZeroPageReason(reason) ? { zeroPageReason: reason } : {}),
    ...(text(candidate.launchCauseSnippet, 500) ? { launchCauseSnippet: text(candidate.launchCauseSnippet, 500)! } : {}),
    ...(text(candidate.workerInstanceId, 120) ? { workerInstanceId: text(candidate.workerInstanceId, 120)! } : {}),
  };
}
