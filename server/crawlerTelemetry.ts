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
  const instance = text(candidate.workerInstanceId, 120);
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
    ...(cause ? { launchCauseSnippet: cause } : {}),
    ...(instance ? { workerInstanceId: instance } : {}),
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
