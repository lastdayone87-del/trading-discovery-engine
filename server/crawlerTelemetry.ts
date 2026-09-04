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
  };
}

export function safeCrawlerTelemetry(input: unknown): CrawlerTelemetry | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const candidate = input as Partial<CrawlerTelemetry>;
  if (candidate.mode !== 'STATIC' && candidate.mode !== 'RENDERED') return undefined;
  const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
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
  };
}
