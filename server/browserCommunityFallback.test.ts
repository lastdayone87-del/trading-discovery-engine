import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DEFAULT_BROWSER_FALLBACK_BUDGET, advanceRenderedLifecycleStage, browserCauseSnippet, browserFallbackTelemetrySummary, classifyCrawlCatch, isTelegramPostPermalink, RenderedFallbackGate, renderedFallbackGate, resolveRenderedZeroPageReason, shouldEnqueueRenderedCommunityLink, shouldEscalateToRenderedFallback, type BrowserFallbackTelemetry } from './browserCommunityFallback';
import { redactCauseSnippet } from './crawlerTelemetry';
import { classifyRenderedCrawlerFailure, isRenderedNavigationTimeout, renderedCrawlerHostBackoffMs, renderedCrawlerRetryPolicy } from './renderedCrawlerPolicy';

test('browser fallback remains bounded while allowing useful retries', () => {
  assert.ok(DEFAULT_BROWSER_FALLBACK_BUDGET.maxPages <= 6);
  assert.ok(DEFAULT_BROWSER_FALLBACK_BUDGET.maxScrollsPerPage <= 5);
  assert.ok(DEFAULT_BROWSER_FALLBACK_BUDGET.maxClicksPerPage <= 4);
  assert.equal(DEFAULT_BROWSER_FALLBACK_BUDGET.maxRequestRetries, 3);
  assert.ok(DEFAULT_BROWSER_FALLBACK_BUDGET.maxSessionRotations <= 4);
  assert.ok(DEFAULT_BROWSER_FALLBACK_BUDGET.totalTimeoutMs <= 60_000);
});

test('Telegram message permalinks are not recursively crawled as community surfaces', () => {
  assert.equal(isTelegramPostPermalink('https://t.me/vipintraders/4013'), true);
  assert.equal(isTelegramPostPermalink('https://t.me/s/vipintraders/4014?single'), true);
  assert.equal(isTelegramPostPermalink('https://telegram.me/vipintraders/4015'), true);
  assert.equal(shouldEnqueueRenderedCommunityLink('https://t.me/vipintraders/4013'), false);
  assert.equal(shouldEnqueueRenderedCommunityLink('https://t.me/s/vipintraders/4014'), false);
});

test('Telegram community roots and non-Telegram community links remain eligible', () => {
  assert.equal(isTelegramPostPermalink('https://t.me/vipintraders'), false);
  assert.equal(shouldEnqueueRenderedCommunityLink('https://t.me/vipintraders'), true);
  assert.equal(shouldEnqueueRenderedCommunityLink('https://example.com/vip-community'), true);
});

test('rendered retry policy rotates sessions for blocked responses', () => {
  assert.equal(classifyRenderedCrawlerFailure(new Error('Request blocked - received 403 status code.')), 'BLOCKED');
  const policy = renderedCrawlerRetryPolicy(new Error('Request blocked - received 403 status code.'), 0);
  assert.equal(policy.retryable, true);
  assert.equal(policy.retireSession, true);
  assert.ok(policy.delayMs >= 500);
});

test('rendered retry policy backs off harder for 429 rate limits', () => {
  const first = renderedCrawlerRetryPolicy(new Error('received 429 Too Many Requests'), 0);
  const second = renderedCrawlerRetryPolicy(new Error('received 429 Too Many Requests'), 1);
  assert.equal(first.failureClass, 'RATE_LIMITED');
  assert.equal(first.retireSession, true);
  assert.ok(second.delayMs > first.delayMs);
  assert.ok(second.delayMs <= 8_000);
});

test('navigation timeout is a transient request failure, not a browser-runtime failure', () => {
  const error = new Error('Page.goto: Timeout 15000ms exceeded.');
  assert.equal(isRenderedNavigationTimeout(error), true);
  assert.equal(classifyRenderedCrawlerFailure(error), 'TRANSIENT');
  assert.equal(renderedCrawlerHostBackoffMs('TRANSIENT', 0), 500);
  assert.equal(renderedCrawlerHostBackoffMs('TRANSIENT', 8), 4_000);
});

test('rendered retry policy keeps transient network retries without forced session churn', () => {
  const policy = renderedCrawlerRetryPolicy(new Error('Navigation timed out after 15000 ms'), 1);
  assert.equal(policy.failureClass, 'TRANSIENT');
  assert.equal(policy.retryable, true);
  assert.equal(policy.retireSession, false);
});

test('rendered browser launches are process-wide bounded', async () => {
  assert.ok(renderedFallbackGate.snapshot().concurrency <= 2);
  assert.ok(renderedFallbackGate.snapshot().maxPending <= 32);

  const gate = new RenderedFallbackGate(1, 2);
  let active = 0;
  let maxActive = 0;
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>(resolve => { releaseFirst = resolve; });

  const first = gate.run(async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await firstBlocked;
    active--;
  });
  const second = gate.run(async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    active--;
  });

  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(gate.snapshot(), { active: 1, pending: 1, concurrency: 1, maxPending: 2 });
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(maxActive, 1);
  assert.deepEqual(gate.snapshot(), { active: 0, pending: 0, concurrency: 1, maxPending: 2 });
});

test('rendered host backoff remains bounded by failure class and retry count', () => {
  assert.equal(renderedCrawlerHostBackoffMs('RATE_LIMITED', 0), 1_000);
  assert.equal(renderedCrawlerHostBackoffMs('RATE_LIMITED', 10), 8_000);
  assert.equal(renderedCrawlerHostBackoffMs('BLOCKED', 10), 4_000);
  assert.equal(renderedCrawlerHostBackoffMs('OTHER', 10), 250);
});

test('rendered browser gate rejects unbounded pending launches', async () => {
  const gate = new RenderedFallbackGate(1, 1);
  let release!: () => void;
  const blocker = new Promise<void>(resolve => { release = resolve; });
  const first = gate.run(async () => blocker);
  const second = gate.run(async () => undefined);
  await assert.rejects(gate.run(async () => undefined), /RENDERED_FALLBACK_SATURATED/);
  release();
  await Promise.all([first, second]);
});

test('does not launch browser after static Discord success', () => {
  assert.equal(shouldEscalateToRenderedFallback({ staticOutcome: 'FOUND', creatorLikelyTrading: true, surface: 'CREATOR_WEBSITES' }), false);
});

test('does not spend browser budget on non-trading creators', () => {
  assert.equal(shouldEscalateToRenderedFallback({ staticOutcome: 'PARTIALLY_INSPECTED', creatorLikelyTrading: false, surface: 'CREATOR_WEBSITES' }), false);
});

test('escalates incomplete trading-creator websites', () => {
  assert.equal(shouldEscalateToRenderedFallback({ staticOutcome: 'PARTIALLY_INSPECTED', creatorLikelyTrading: true, surface: 'CREATOR_WEBSITES' }), true);
  assert.equal(shouldEscalateToRenderedFallback({ staticOutcome: 'ACQUISITION_FAILED', creatorLikelyTrading: true, surface: 'CREATOR_WEBSITES' }), true);
});

test('can escalate a fully static no-match because Discord may be JS-hidden', () => {
  assert.equal(shouldEscalateToRenderedFallback({ staticOutcome: 'INSPECTED_NO_MATCH', creatorLikelyTrading: true, surface: 'CREATOR_WEBSITES' }), true);
});

test('crawler telemetry summary is sanitized and bounded for durable inspection detail', () => {
  assert.equal(browserFallbackTelemetrySummary({requestsStarted:2,requestsFinished:1,requestsFailed:1,navigationTimeouts:1,blockedRequests:0,rateLimitedRequests:0,transientRequests:1,unresolvedFailedRequests:1,hostBackoffsApplied:1,clicksStarted:3,clicksSucceeded:2,clicksFailed:1,clickFailureClasses:{BLOCKED:0,RATE_LIMITED:0,TRANSIENT:1,OTHER:0}} as BrowserFallbackTelemetry), 'telemetry{started:2,finished:1,failed:1,navigationTimeouts:1,blocked:0,rateLimited:0,transient:1,hostBackoffs:1,clicksStarted:3,clicksSucceeded:2,clicksFailed:1,clickFailureClasses:{"BLOCKED":0,"RATE_LIMITED":0,"TRANSIENT":1,"OTHER":0}}');
  assert.equal(browserFallbackTelemetrySummary({requestsStarted:0,requestsFinished:0,requestsFailed:0,navigationTimeouts:0,blockedRequests:0,rateLimitedRequests:0,transientRequests:0,unresolvedFailedRequests:0,hostBackoffsApplied:0,clicksStarted:0,clicksSucceeded:0,clicksFailed:0,clickFailureClasses:{BLOCKED:0,RATE_LIMITED:0,TRANSIENT:0,OTHER:0},lastLifecycleStage:'CRAWLER_RUNNING',zeroPageReason:'CRAWLER_RETURNED_WITHOUT_REQUESTS'}), 'telemetry{started:0,finished:0,failed:0,navigationTimeouts:0,blocked:0,rateLimited:0,transient:0,hostBackoffs:0,clicksStarted:0,clicksSucceeded:0,clicksFailed:0,clickFailureClasses:{"BLOCKED":0,"RATE_LIMITED":0,"TRANSIENT":0,"OTHER":0},stage:CRAWLER_RUNNING,zeroPage:CRAWLER_RETURNED_WITHOUT_REQUESTS}');
});

test('crawler exposes bounded failure telemetry and keeps partial results retryable', () => {
  const source = fs.readFileSync(new URL('./browserCommunityFallback.ts', import.meta.url), 'utf8');
  assert.match(source, /telemetry\.requestsFailed/);
  assert.match(source, /telemetry\.navigationTimeouts/);
  assert.match(source, /hostBackoffUntil/);
  assert.match(source, /isBrowserRuntimeFailure/);
  assert.match(source, /clicksFailed/);
  assert.match(source, /clickFailureClasses/);
  assert.match(source, /complete:completion\.complete/);
  assert.match(source, /resolveRenderedCompletionState/);
  assert.match(source, /NO_PAGE_PROCESSED/);
});

test('browser acquisition failure remains retryable rather than proving NOT_FOUND', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('./browserCommunityFallback.ts', import.meta.url), 'utf8'));
  assert.match(source, /complete:\s*false/);
  assert.match(source, /retryable:\s*true/);
  assert.match(source, /retryOnBlocked:\s*true/);
  assert.match(source, /maxSessionRotations:\s*limits\.maxSessionRotations/);
});

test('browser-gate saturation keeps an explicit capacity class without poisoning capability', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('./browserCommunityFallback.ts', import.meta.url), 'utf8'));
  // Saturation must surface as RENDERED_FALLBACK_SATURATED (attempt-free
  // capacity), never collapse into generic NO_PAGE_PROCESSED (which would
  // consume a bounded attempt for work that never started). Classification
  // lives in classifyCrawlCatch; the outer catch delegates to it.
  assert.match(source, /failureClass: 'RENDERED_FALLBACK_SATURATED', preserveLaunchCause: false/);
  assert.match(source, /classifyCrawlCatch\(error,\{saturated\}\)/);
  assert.match(source, /if \(failureClass&&!saturated\) markBrowserCapabilityUnavailable\(error\)/);
});

test('zero-page reason names the concrete terminal condition', () => {
  const base = { inspectedPages: 0, timedOut: false, saturated: false, browserLaunchFailed: false };
  const tel = (overrides: object) => ({
    requestsStarted: 0, requestsFailed: 0, lastLifecycleStage: 'CRAWLER_RUNNING' as const, ...overrides,
  });
  assert.equal(resolveRenderedZeroPageReason({ ...base, saturated: true, telemetry: tel({}) }), 'GATE_SATURATED');
  assert.equal(resolveRenderedZeroPageReason({ ...base, browserLaunchFailed: true, telemetry: tel({}) }), 'BROWSER_LAUNCH_FAILED');
  assert.equal(resolveRenderedZeroPageReason({ ...base, telemetry: tel({ lastLifecycleStage: 'GATE_QUEUED' }) }), 'CRAWLER_START_FAILED');
  assert.equal(resolveRenderedZeroPageReason({ ...base, telemetry: tel({ lastLifecycleStage: 'GATE_ACQUIRED' }) }), 'CRAWLER_START_FAILED');
  assert.equal(
    resolveRenderedZeroPageReason({ ...base, telemetry: tel({ requestsFailed: 2 }) }),
    'PRE_HANDLER_REQUEST_FAILURE',
  );
  assert.equal(
    resolveRenderedZeroPageReason({ ...base, timedOut: true, telemetry: tel({}) }),
    'DEADLINE_BEFORE_ADMISSION',
  );
  assert.equal(
    resolveRenderedZeroPageReason({ ...base, telemetry: tel({ requestsStarted: 1, lastLifecycleStage: 'HANDLER_ENTERED' }) }),
    'HANDLER_ENTERED_NO_PAGES',
  );
  assert.equal(resolveRenderedZeroPageReason({ ...base, telemetry: tel({}) }), 'CRAWLER_RETURNED_WITHOUT_REQUESTS');
  // Pages present is never zero-page, regardless of flags.
  assert.equal(
    resolveRenderedZeroPageReason({ ...base, inspectedPages: 2, saturated: true, browserLaunchFailed: true, telemetry: tel({ requestsStarted: 2 }) }),
    undefined,
  );
  // Concrete request failures outrank an expired deadline for diagnosis.
  assert.equal(
    resolveRenderedZeroPageReason({ ...base, timedOut: true, telemetry: tel({ requestsFailed: 1 }) }),
    'PRE_HANDLER_REQUEST_FAILURE',
  );
});

test('recorded lifecycle stage outranks zero counters in zero-page reasons', () => {
  // HANDLER_ENTERED proves admission even when the deadline guard fired before
  // requestsStarted++: classifying that as DEADLINE_BEFORE_ADMISSION would be
  // false, so the stage takes precedence over requestsStarted === 0.
  const tel = () => ({ requestsStarted: 0, requestsFailed: 0, lastLifecycleStage: 'HANDLER_ENTERED' as const });
  assert.equal(
    resolveRenderedZeroPageReason({ inspectedPages: 0, timedOut: true, saturated: false, browserLaunchFailed: false, telemetry: tel() }),
    'HANDLER_ENTERED_NO_PAGES',
  );
});

test('thrown crawler execution is distinct from a normal zero-request return', () => {
  const tel = () => ({ requestsStarted: 0, requestsFailed: 0, lastLifecycleStage: 'CRAWLER_RUNNING' as const });
  const base = { inspectedPages: 0, timedOut: false, saturated: false, browserLaunchFailed: false, telemetry: tel() };
  // A normal return with no requests is a clean no-op bucket...
  assert.equal(resolveRenderedZeroPageReason(base), 'CRAWLER_RETURNED_WITHOUT_REQUESTS');
  // ...while a run that threw before admission is an aborted execution, even
  // with identical counters. Browser throws keep their own classification.
  assert.equal(resolveRenderedZeroPageReason({ ...base, thrown: true }), 'CRAWLER_RUN_THREW');
  assert.equal(
    resolveRenderedZeroPageReason({ ...base, thrown: true, browserLaunchFailed: true }),
    'BROWSER_LAUNCH_FAILED',
  );
});

test('thrown startup failure resolves by lifecycle stage, not the thrown flag', () => {
  // Module loading or crawler construction throwing before crawler.run()
  // begins never progressed past startup: stage evidence outranks the thrown
  // flag, so these resolve to CRAWLER_START_FAILED rather than
  // CRAWLER_RUN_THREW. A throw at/after CRAWLER_RUNNING keeps RUN_THREW.
  const zeroed = { requestsStarted: 0, requestsFailed: 0 };
  assert.equal(
    resolveRenderedZeroPageReason({
      inspectedPages: 0, timedOut: false, saturated: false, browserLaunchFailed: false, thrown: true,
      telemetry: { ...zeroed, lastLifecycleStage: 'GATE_ACQUIRED' },
    }),
    'CRAWLER_START_FAILED',
  );
  assert.equal(
    resolveRenderedZeroPageReason({
      inspectedPages: 0, timedOut: false, saturated: false, browserLaunchFailed: false, thrown: true,
      telemetry: { ...zeroed, lastLifecycleStage: 'GATE_QUEUED' },
    }),
    'CRAWLER_START_FAILED',
  );
  assert.equal(
    resolveRenderedZeroPageReason({
      inspectedPages: 0, timedOut: false, saturated: false, browserLaunchFailed: false, thrown: true,
      telemetry: { ...zeroed, lastLifecycleStage: 'CRAWLER_RUNNING' },
    }),
    'CRAWLER_RUN_THREW',
  );
  // HANDLER_ENTERED proof survives even a later throw.
  assert.equal(
    resolveRenderedZeroPageReason({
      inspectedPages: 0, timedOut: true, saturated: false, browserLaunchFailed: false, thrown: true,
      telemetry: { ...zeroed, lastLifecycleStage: 'HANDLER_ENTERED' },
    }),
    'HANDLER_ENTERED_NO_PAGES',
  );
});

test('browser cause snippet preserves message plus cause, bounded and flat', () => {
  assert.equal(browserCauseSnippet(new Error('launch boom')), 'launch boom');
  const nested = new Error('outer');
  (nested as { cause?: unknown }).cause = new Error('inner\n  spaced\ttext');
  assert.equal(browserCauseSnippet(nested), 'outer | inner spaced text');
  assert.equal(browserCauseSnippet(new Error('x'), 5), 'x');
  assert.equal(browserCauseSnippet('a'.repeat(600)), 'a'.repeat(500));
  assert.equal(browserCauseSnippet(undefined), undefined);
  assert.equal(browserCauseSnippet(''), undefined);
});

test('cause redaction removes secrets but keeps diagnostic meaning', () => {
  // URL credentials, token/query values, bearer material, password
  // assignments, and home-directory paths must not survive into the snippet
  // (and therefore neither into persisted detail); error classes, codes,
  // hostnames, and Chromium internals stay for diagnosis.
  assert.equal(
    redactCauseSnippet('Failed to launch https://user:s3cret@proxy:8080 browser'),
    'Failed to launch https://user:***@proxy:8080 browser',
  );
  assert.equal(
    redactCauseSnippet('net::ERR_ABORTED https://x.test/cb?token=abc123&other=keep#frag'),
    'net::ERR_ABORTED https://x.test/cb?token=***&other=keep#frag',
  );
  assert.equal(
    redactCauseSnippet('auth failed Bearer eyJhbGciOiJIUzI1NiJ9 payload'),
    'auth failed Bearer *** payload',
  );
  assert.equal(
    redactCauseSnippet('launch opts {"password": "hunter2", "headless": true}'),
    'launch opts {"password": "***", "headless": true}',
  );
  assert.equal(
    redactCauseSnippet('spawn EAGAIN at /root/.cache/ms-playwright/chromium/chrome'),
    'spawn EAGAIN at /<redacted-path>',
  );
  assert.equal(
    redactCauseSnippet('ok plain BROWSER_BINARY_MISSING code 12'),
    'ok plain BROWSER_BINARY_MISSING code 12',
  );
  // Redaction applies before the length cap, and empty input stays empty.
  assert.equal(redactCauseSnippet(''), undefined);
  assert.ok((redactCauseSnippet(`t=${'s'.repeat(40)} ` + 'v'.repeat(600)) || '').length <= 500);
});

test('persisted detail carries the redacted cause, never raw secrets', async () => {
  // The failure detail is what lands in the observation ledger: prove a
  // secret-bearing launch error cannot reach it unredacted.
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('./browserCommunityFallback.ts', import.meta.url), 'utf8'));
  assert.match(source, /\(cause: \$\{causeSnippet\}\)`:''\}/);
});

test('generic crawler errors never populate the launch-cause field', () => {
  // launchCauseSnippet requires affirmative browser launch/startup/runtime
  // failure: ordinary execution errors (navigation, timeouts, crashes after
  // CRAWLER_RUNNING) must not be relabeled as browser-launch causes.
  const generic = classifyCrawlCatch(new Error('net::ERR_CONNECTION_REFUSED after CRAWLER_RUNNING'), { saturated: false });
  assert.equal(generic.browserLaunchFailed, false);
  assert.equal(generic.failureClass, undefined);
  assert.equal(generic.preserveLaunchCause, false);
  const timeout = classifyCrawlCatch(new Error('navigation timeout exceeded'), { saturated: false });
  assert.equal(timeout.preserveLaunchCause, false);
  const browser = classifyCrawlCatch(new Error('browser process exited'), { saturated: false });
  assert.equal(browser.browserLaunchFailed, true);
  assert.equal(browser.failureClass, 'BROWSER_LAUNCH_FAILED');
  assert.equal(browser.preserveLaunchCause, true);
  const saturated = classifyCrawlCatch(new Error('RENDERED_FALLBACK_SATURATED'), { saturated: true });
  assert.equal(saturated.failureClass, 'RENDERED_FALLBACK_SATURATED');
  assert.equal(saturated.preserveLaunchCause, false);
});

test('catch paths gate the launch-cause snippet on affirmative browser failure', async () => {
  // Both crawler catch blocks may only forward a cause snippet when the
  // classifier proved a browser failure; redaction alone cannot fix a
  // mislabeled field.
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('./browserCommunityFallback.ts', import.meta.url), 'utf8'));
  const gated = source.match(/preserveLaunchCause\?browserCauseSnippet/g) || [];
  assert.equal(gated.length, 2);
});

test('lifecycle stages advance monotonically and never regress after a page', () => {
  // Simulates: handler enters → page processed → another handler/request
  // enters. Later shallower activity must not overwrite PAGE_PROCESSED, so a
  // successful crawl always retains its highest observed stage. The previous
  // inline guard is now structural: stages move only forward by rank.
  let stage = advanceRenderedLifecycleStage('GATE_QUEUED', 'GATE_ACQUIRED');
  assert.equal(stage, 'GATE_ACQUIRED');
  stage = advanceRenderedLifecycleStage(stage, 'CRAWLER_RUNNING');
  assert.equal(stage, 'CRAWLER_RUNNING');
  stage = advanceRenderedLifecycleStage(stage, 'HANDLER_ENTERED');
  assert.equal(stage, 'HANDLER_ENTERED');
  stage = advanceRenderedLifecycleStage(stage, 'PAGE_PROCESSED');
  assert.equal(stage, 'PAGE_PROCESSED');
  stage = advanceRenderedLifecycleStage(stage, 'HANDLER_ENTERED');
  assert.equal(stage, 'PAGE_PROCESSED');
  stage = advanceRenderedLifecycleStage(stage, 'CRAWLER_RUNNING');
  assert.equal(stage, 'PAGE_PROCESSED');
  stage = advanceRenderedLifecycleStage('GATE_QUEUED', 'GATE_QUEUED');
  assert.equal(stage, 'GATE_QUEUED');
});
