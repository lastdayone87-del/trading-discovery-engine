export type RenderedCrawlerFailureClass = 'BLOCKED' | 'RATE_LIMITED' | 'TRANSIENT' | 'OTHER';

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
