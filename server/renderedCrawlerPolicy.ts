export type RenderedCrawlerFailureClass = 'BLOCKED' | 'RATE_LIMITED' | 'TRANSIENT' | 'OTHER';

/**
 * Per-click failure kind (additive observability; the coarser
 * RenderedCrawlerFailureClass buckets above are unchanged and still recorded
 * alongside). First-match wins in the order below; documented overlaps:
 * - a navigation that destroys the frame can surface as either
 *   `nav_interrupted` ("execution context was destroyed") or `detached_stale`
 *   ("not attached to the DOM") depending on which error Playwright raises
 *   first — the recorded kind names the observed error, not the root cause;
 * - visibility/stability/disabled actionability gates share
 *   `overlay_intercepted` (the element could not be acted upon for page-state
 *   reasons, as opposed to timing out or being detached);
 * - a timeout message that also mentions navigation still classifies
 *   `nav_interrupted` only for destruction/crash/failure phrasing, so plain
 *   "Timeout Nms exceeded" actionability timeouts stay `timeout`.
 */
export type RenderedClickFailureKind =
  | 'timeout'
  | 'detached_stale'
  | 'overlay_intercepted'
  | 'nav_interrupted'
  | 'target_closed'
  | 'network'
  | 'other';

export const RENDERED_CLICK_FAILURE_KINDS: readonly RenderedClickFailureKind[] = [
  'timeout',
  'detached_stale',
  'overlay_intercepted',
  'nav_interrupted',
  'target_closed',
  'network',
  'other',
];

export function emptyRenderedClickFailureDetail(): Record<RenderedClickFailureKind, number> {
  return {
    timeout: 0,
    detached_stale: 0,
    overlay_intercepted: 0,
    nav_interrupted: 0,
    target_closed: 0,
    network: 0,
    other: 0,
  };
}

export function classifyRenderedClickFailure(error: unknown): RenderedClickFailureKind {
  const message = String((error as any)?.message || error || '');
  if (/target closed|browser has been closed|target page, context or browser has been closed/i.test(message)) {
    return 'target_closed';
  }
  if (/execution context was destroyed|navigation failed|page crashed/i.test(message)) {
    return 'nav_interrupted';
  }
  if (/element is not attached to the dom|detached from dom|stale element/i.test(message)) {
    return 'detached_stale';
  }
  if (/intercepts pointer events|receives pointer events|element is not visible|element is not stable|element is disabled/i.test(message)) {
    return 'overlay_intercepted';
  }
  if (/net::ERR_|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_|ENOTFOUND|EAI_AGAIN/i.test(message)) {
    return 'network';
  }
  if (/timeout|timed out/i.test(message)) {
    return 'timeout';
  }
  return 'other';
}

export interface RenderedCrawlerRetryPolicy {
  failureClass: RenderedCrawlerFailureClass;
  retryable: boolean;
  retireSession: boolean;
  delayMs: number;
}

export const DEFAULT_RENDERED_MAX_REQUEST_RETRIES = 3;
export const DEFAULT_RENDERED_MAX_SESSION_ROTATIONS = 4;

function boundedDelay(retryCount: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * Math.pow(2, Math.max(0, retryCount)));
}

export function isRenderedNavigationTimeout(error: unknown): boolean {
  const message = String((error as any)?.message || error || '').toLowerCase();
  return /page\.goto|navigation.*timeout|timeout.*navigation|timed? ?out/.test(message);
}

export function classifyRenderedCrawlerFailure(error: unknown): RenderedCrawlerFailureClass {
  const message = String((error as any)?.message || error || '').toLowerCase();
  const status = Number((error as any)?.statusCode || (error as any)?.status || (error as any)?.response?.status);
  if (status === 429 || /\b429\b|too many requests|rate.?limit/.test(message)) return 'RATE_LIMITED';
  if ([401, 403].includes(status) || /\b403\b|\b401\b|request blocked|access denied|forbidden|captcha|bot protection|cloudflare/.test(message)) return 'BLOCKED';
  if ([408, 425, 500, 502, 503, 504].includes(status) || /timeout|timed out|econnreset|econnrefused|eai_again|enotfound|network|navigation.*failed|browser.*closed|target.*closed/.test(message)) return 'TRANSIENT';
  return 'OTHER';
}

export function renderedCrawlerHostBackoffMs(failureClass: RenderedCrawlerFailureClass, retryCount: number): number {
  if (failureClass === 'RATE_LIMITED') return boundedDelay(retryCount, 1_000, 8_000);
  if (failureClass === 'BLOCKED') return boundedDelay(retryCount, 500, 4_000);
  if (failureClass === 'TRANSIENT') return boundedDelay(retryCount, 500, 4_000);
  return 250;
}

export function renderedCrawlerRetryPolicy(error: unknown, retryCount: number): RenderedCrawlerRetryPolicy {
  const failureClass = classifyRenderedCrawlerFailure(error);
  if (failureClass === 'RATE_LIMITED') {
    return { failureClass, retryable: true, retireSession: true, delayMs: boundedDelay(retryCount, 1_000, 8_000) };
  }
  if (failureClass === 'BLOCKED') {
    return { failureClass, retryable: true, retireSession: true, delayMs: boundedDelay(retryCount, 500, 4_000) };
  }
  if (failureClass === 'TRANSIENT') {
    return { failureClass, retryable: true, retireSession: false, delayMs: boundedDelay(retryCount, 500, 4_000) };
  }
  return { failureClass, retryable: true, retireSession: false, delayMs: 250 };
}
