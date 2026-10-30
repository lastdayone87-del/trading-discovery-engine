import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DEFAULT_BROWSER_FALLBACK_BUDGET, DECLARATIVE_SHADOW_SCAN_MAX_BYTES, advanceRenderedLifecycleStage, beginRenderedDeclarativeShadowScan, browserCauseSnippet, browserFallbackTelemetrySummary, classifyCrawlCatch, classifyRenderedPopupDestination, countDeclarativeClosedShadowRoots, createRenderedRouteGuard, disposeRenderedRouteGuards, installRenderedRouteCloseCleanup, isExpectedRenderedRouteShutdownError, isTelegramPostPermalink, mergeRenderedPageContextCounts, readRenderedDeclarativeShadowScan, RenderedFallbackGate, renderedFallbackGate, resolveRenderedZeroPageReason, shouldEnqueueRenderedCommunityLink, shouldEscalateToRenderedFallback, shouldSkipPreexistingSiblingPage, sumRenderedPageContextCounts, type BrowserFallbackTelemetry, type RenderedRouteLike } from './browserCommunityFallback';
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

test('declarative closed shadow roots are counted from raw markup without claiming open roots', () => {
  assert.equal(
    countDeclarativeClosedShadowRoots('<div><template shadowrootmode="closed"><a href="/room">Room</a></template></div>'),
    1,
    'standard closed declarative root is detected',
  );
  assert.equal(
    countDeclarativeClosedShadowRoots("<template shadowrootmode='closed'>x</template>"),
    1,
    'single-quoted attribute is detected',
  );
  assert.equal(
    countDeclarativeClosedShadowRoots('<template SHADOWROOTMODE=closed>x</template>'),
    1,
    'attribute names and unquoted values are case-insensitive',
  );
  assert.equal(
    countDeclarativeClosedShadowRoots('<template shadowroot="closed">x</template>'),
    1,
    'the legacy shadowroot spelling is counted conservatively',
  );
  assert.equal(
    countDeclarativeClosedShadowRoots('<template title="Guests > 10" shadowrootmode="closed">x</template>'),
    1,
    'a quoted attribute containing > does not hide a later closed declaration',
  );
  assert.equal(
    countDeclarativeClosedShadowRoots("<template data-note='a > b' shadowrootmode='closed'>x</template>"),
    1,
    'single-quoted values with > are respected',
  );
  assert.equal(
    countDeclarativeClosedShadowRoots('<template shadowrootmode="open">x</template>'),
    0,
    'open declarative roots are traversable and are not a closed-context gap',
  );
  assert.equal(
    countDeclarativeClosedShadowRoots('<template shadowrootmode="closedx">x</template>'),
    0,
    'a value prefix is not a closed root',
  );
  assert.equal(
    countDeclarativeClosedShadowRoots(Array.from({ length: 1200 }, () => '<template shadowrootmode="closed"></template>').join('')),
    1000,
    'the markup scan is bounded even for a pathological document',
  );
  assert.equal(
    countDeclarativeClosedShadowRoots('<template id="x"shadowrootmode="closed">x</template>'),
    1,
    'an attribute immediately after a closing quote is still an attribute boundary',
  );
  assert.equal(
    countDeclarativeClosedShadowRoots('<template id="x"shadowrootmode="closed"/>'),
    1,
    'a self-closing start tag still counts its closed declaration',
  );
  const malformed = '<template '.repeat(131_072);
  const malformedStart = Date.now();
  assert.equal(countDeclarativeClosedShadowRoots(malformed), 0, 'an unterminated start tag yields no closed root');
  assert.ok(Date.now() - malformedStart < 1_000, 'an unterminated template tag scan is linear, not quadratic');
});

test('per-document context counters keep maxima and sum every inspected document', () => {
  const first = mergeRenderedPageContextCounts(undefined, {
    frameCount: 2, shadowRootCount: 3, closedShadowRootCount: 0, baseHrefPresent: false,
  });
  assert.deepEqual(first, { frameCount: 2, shadowRootCount: 3, closedShadowRootCount: 0, baseHrefPresent: false });
  const merged = mergeRenderedPageContextCounts(first, {
    frameCount: 1, shadowRootCount: 5, closedShadowRootCount: 4, baseHrefPresent: true,
  });
  assert.deepEqual(
    merged,
    { frameCount: 2, shadowRootCount: 5, closedShadowRootCount: 4, baseHrefPresent: true },
    'a later smaller snapshot cannot erase contexts already observed in the same document',
  );
  const clickedDocument = { frameCount: 1, shadowRootCount: 0, closedShadowRootCount: 2, baseHrefPresent: false };
  assert.deepEqual(
    sumRenderedPageContextCounts([first, clickedDocument]),
    { frameCount: 3, shadowRootCount: 3, closedShadowRootCount: 2, baseHrefPresent: false },
    'a click-navigated document contributes its own contexts instead of being dropped',
  );
});

test('declarative shadow response scan reports roots, gaps, and per-navigation resets', async () => {
  type Listener = (response: {
    url(): string;
    status(): number;
    headers(): Record<string, string>;
    request(): { resourceType(): string; frame(): unknown };
    text(): Promise<string>;
  }) => void;
  const mainFrame = {};
  let listener: Listener | undefined;
  const page = {
    on(_event: 'response', callback: Listener) { listener = callback; },
    mainFrame() { return mainFrame; },
  };
  beginRenderedDeclarativeShadowScan(page);
  assert.deepEqual(
    await readRenderedDeclarativeShadowScan(page as object, 0),
    { documents: 0, closedRoots: 0, gaps: 1 },
    'a navigation with no observed document response is a scan gap, not an empty document',
  );

  beginRenderedDeclarativeShadowScan(page);
  listener!({
    url: () => 'https://fixture.test/',
    status: () => 200,
    headers: () => ({ 'content-length': '60' }),
    request: () => ({ resourceType: () => 'document', frame: () => mainFrame }),
    text: async () => '<template shadowrootmode="closed"></template>',
  });
  assert.deepEqual(
    await readRenderedDeclarativeShadowScan(page as object, 100),
    { documents: 1, closedRoots: 1, gaps: 0 },
  );

  // A second navigation on the same reused page starts from zero; the first
  // document's root is not carried forward.
  beginRenderedDeclarativeShadowScan(page);
  listener!({
    url: () => 'https://fixture.test/next',
    status: () => 200,
    headers: () => ({ 'content-length': '48' }),
    request: () => ({ resourceType: () => 'document', frame: () => mainFrame }),
    text: async () => '<html><body>no shadow roots</body></html>',
  });
  assert.deepEqual(
    await readRenderedDeclarativeShadowScan(page as object, 100),
    { documents: 1, closedRoots: 0, gaps: 0 },
  );

  // A redirect response and a subframe document are not final main-document
  // bodies and must not create a false gap.
  beginRenderedDeclarativeShadowScan(page);
  listener!({
    url: () => 'https://fixture.test/redirect',
    status: () => 302,
    headers: () => ({}),
    request: () => ({ resourceType: () => 'document', frame: () => mainFrame }),
    text: async () => '',
  });
  listener!({
    url: () => 'https://fixture.test/frame',
    status: () => 200,
    headers: () => ({}),
    request: () => ({ resourceType: () => 'document', frame: () => ({}) }),
    text: async () => '<template shadowrootmode="closed"></template>',
  });
  assert.deepEqual(
    await readRenderedDeclarativeShadowScan(page as object, 0),
    { documents: 0, closedRoots: 0, gaps: 1 },
    'neither response is a final main-document body',
  );
});

test('declarative shadow scan never reads a body whose decoded size cannot be bounded', async () => {
  type Listener = (response: {
    url(): string;
    status(): number;
    headers(): Record<string, string>;
    request(): { resourceType(): string; frame(): unknown };
    text(): Promise<string>;
  }) => void;
  const mainFrame = {};
  let listener: Listener | undefined;
  const page = {
    on(_event: 'response', callback: Listener) { listener = callback; },
    mainFrame() { return mainFrame; },
  };
  let textReads = 0;
  const emit = (headers: Record<string, string>) => listener!({
    url: () => 'https://fixture.test/',
    status: () => 200,
    headers: () => headers,
    request: () => ({ resourceType: () => 'document', frame: () => mainFrame }),
    text: async () => { textReads++; return '<template shadowrootmode="closed"></template>'; },
  });

  beginRenderedDeclarativeShadowScan(page);
  emit({});
  assert.deepEqual(
    await readRenderedDeclarativeShadowScan(page as object, 0),
    { documents: 0, closedRoots: 0, gaps: 1 },
    'a chunked response without content-length is an explicit scan gap',
  );
  assert.equal(textReads, 0, 'the unbounded body was never materialized');

  beginRenderedDeclarativeShadowScan(page);
  emit({ 'content-length': '60', 'content-encoding': 'gzip' });
  assert.equal((await readRenderedDeclarativeShadowScan(page as object, 0)).gaps, 1);
  assert.equal(textReads, 0, 'a compressed body cannot be bounded by its compressed length');

  beginRenderedDeclarativeShadowScan(page);
  emit({ 'content-length': String(DECLARATIVE_SHADOW_SCAN_MAX_BYTES + 1) });
  assert.equal((await readRenderedDeclarativeShadowScan(page as object, 0)).gaps, 1);
  assert.equal(textReads, 0, 'an over-cap declared body is skipped before reading');
});

test('popup destinations are classified before policy exclusion or discard', () => {
  const pageUrl = 'https://creator.example/';
  assert.equal(classifyRenderedPopupDestination('about:blank', pageUrl), 'uninspectable');
  assert.equal(classifyRenderedPopupDestination('chrome-error://chromewebdata/', pageUrl), 'uninspectable');
  assert.equal(
    classifyRenderedPopupDestination('https://discord.gg/InviteCode', pageUrl),
    'discord',
    'a direct Discord invite opened by window.open is terminal evidence',
  );
  assert.equal(
    classifyRenderedPopupDestination('https://discord.com/invite/InviteCode', pageUrl),
    'discord',
    'the discord.com/invite form is also terminal evidence',
  );
  assert.equal(
    classifyRenderedPopupDestination('https://discord.com/', pageUrl),
    'cross-origin',
    'a generic Discord-host page has no invite in its URL and stays unexamined',
  );
  assert.equal(
    classifyRenderedPopupDestination('https://discord.com/channels/1/2', pageUrl),
    'cross-origin',
    'a Discord channel view is not terminal invite evidence',
  );
  assert.equal(
    classifyRenderedPopupDestination('https://discord.gg/', pageUrl),
    'cross-origin',
    'a Discord host without an extractable code is not terminal evidence',
  );
  assert.equal(classifyRenderedPopupDestination('https://creator.example/room', pageUrl), 'same-origin');
  assert.equal(classifyRenderedPopupDestination('https://other.example/room', pageUrl), 'cross-origin');
  assert.equal(classifyRenderedPopupDestination('http://127.0.0.1/private', pageUrl), 'admission-rejected');
});

test('idle pool pages are skipped but real load-time blank popups are captured', () => {
  assert.equal(shouldSkipPreexistingSiblingPage('https://creator.example/room', null), false, 'committed HTTP(S) siblings are real');
  assert.equal(shouldSkipPreexistingSiblingPage('about:blank', { hasOpener: false, hasContent: false }), true, 'an empty opener-less pool page is idle');
  assert.equal(shouldSkipPreexistingSiblingPage('about:blank', { hasOpener: true, hasContent: false }), false, 'an opener proves a real popup');
  assert.equal(shouldSkipPreexistingSiblingPage('about:blank', { hasOpener: false, hasContent: true }), false, 'document.write content proves a real popup');
  assert.equal(shouldSkipPreexistingSiblingPage('about:blank', null), true, 'an unreadable blank page is treated as idle, never closed as a gap');
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

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function routeLike(
  url: string,
  resourceType: string,
  action: (name: string, errorCode?: string) => Promise<void> = async () => {},
): RenderedRouteLike {
  return {
    request: () => ({ url: () => url, resourceType: () => resourceType }),
    abort: (errorCode?: string) => action('abort', errorCode),
    continue: () => action('continue'),
  };
}

test('route guard treats an in-flight target-closed rejection as benign and cleans up once', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    let routeReject!: (reason?: unknown) => void;
    let unrouteCalls = 0;
    let unrouteBehavior: string | undefined;
    const continueStarted = deferred();
    const context = {
      unrouteAll: async (options?: { behavior?: 'default' | 'wait' | 'ignoreErrors' }) => {
        unrouteCalls++;
        unrouteBehavior = options?.behavior;
        routeReject(new Error('TargetClosedError2: route.continue: Target page, context or browser has been closed'));
      },
    };
    const guard = createRenderedRouteGuard(context, {
      isAllowed: async () => true,
      onBlocked: () => {},
    });
    const route: RenderedRouteLike = {
      request: () => ({ url: () => 'https://public.example/', resourceType: () => 'document' }),
      abort: async () => {},
      continue: () => {
        continueStarted.resolve();
        return new Promise<void>((_resolve, reject) => { routeReject = reject; });
      },
    };

    const pending = guard.handler(route);
    await continueStarted.promise;
    await guard.dispose();
    await pending;
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(unrouteCalls, 1);
    assert.equal(unrouteBehavior, 'ignoreErrors');
    assert.deepEqual(unhandled, []);

    // A close hook and the crawl finally may both dispose the same guard.
    await guard.dispose();
    assert.equal(unrouteCalls, 1);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('route guard treats a target-closed continue failure as benign even before cleanup', async () => {
  const actions: string[] = [];
  let unexpected = 0;
  const guard = createRenderedRouteGuard(
    { unrouteAll: async () => {} },
    { isAllowed: async () => true, onBlocked: () => {}, onUnexpectedRouteError: () => { unexpected++; } },
  );

  await guard.handler({
    request: () => ({ url: () => 'https://public.example/', resourceType: () => 'document' }),
    continue: async () => { throw new Error('TargetClosedError2: Target page, context or browser has been closed'); },
    abort: async (code?: string) => { actions.push(`abort:${code || ''}`); },
  });

  assert.deepEqual(actions, []);
  assert.equal(unexpected, 0);
});

test('route guard preserves normal routing and the public-destination block', async () => {
  const actions: string[] = [];
  let blocked = 0;
  const guard = createRenderedRouteGuard(
    { unrouteAll: async () => {} },
    { isAllowed: async url => !url.includes('127.0.0.1'), onBlocked: () => { blocked++; } },
  );

  await guard.handler(routeLike('https://public.example/page', 'document', async name => { actions.push(name); }));
  await guard.handler(routeLike('http://127.0.0.1/private', 'document', async (name, code) => { actions.push(`${name}:${code || ''}`); }));
  await guard.handler(routeLike('https://public.example/image.png', 'image', async (name, code) => { actions.push(`${name}:${code || ''}`); }));

  assert.deepEqual(actions, ['continue', 'abort:blockedbyclient', 'abort:']);
  assert.equal(blocked, 1);
});

test('route guard fails closed on unexpected callback errors instead of swallowing them', async () => {
  const actions: string[] = [];
  const unexpected: unknown[] = [];
  const guard = createRenderedRouteGuard(
    { unrouteAll: async () => {} },
    { isAllowed: async () => true, onBlocked: () => {}, onUnexpectedRouteError: error => { unexpected.push(error); } },
  );

  await guard.handler({
    request: () => ({ url: () => 'https://public.example/', resourceType: () => 'document' }),
    continue: async () => { throw new Error('unexpected continue failure'); },
    abort: async (code?: string) => { actions.push(`abort:${code || ''}`); },
  });

  assert.deepEqual(actions, ['abort:failed']);
  assert.equal(unexpected.length, 1);
  assert.match(String(unexpected[0]), /unexpected continue failure/);
});

test('route guard reports an unexpected fallback abort failure without rejecting', async () => {
  const unexpected: unknown[] = [];
  const guard = createRenderedRouteGuard(
    { unrouteAll: async () => {} },
    { isAllowed: async () => true, onBlocked: () => {}, onUnexpectedRouteError: error => { unexpected.push(error); } },
  );

  await guard.handler({
    request: () => ({ url: () => 'https://public.example/', resourceType: () => 'document' }),
    continue: async () => { throw new Error('continue boom'); },
    abort: async () => { throw new Error('abort boom'); },
  });

  assert.equal(unexpected.length, 2);
  assert.match(String(unexpected[0]), /continue boom/);
  assert.match(String(unexpected[1]), /abort boom/);
});

test('route guard fails closed when the destination check itself rejects', async () => {
  const actions: string[] = [];
  const guard = createRenderedRouteGuard(
    { unrouteAll: async () => {} },
    { isAllowed: async () => { throw new Error('resolver bug'); }, onBlocked: () => {} },
  );

  await guard.handler(routeLike('https://public.example/', 'document', async (name, code) => { actions.push(`${name}:${code || ''}`); }));
  assert.deepEqual(actions, ['abort:failed']);
});

test('route guard fails closed when destination resolution rejects with shutdown-looking text', async () => {
  const actions: string[] = [];
  const unexpected: unknown[] = [];
  const guard = createRenderedRouteGuard(
    { unrouteAll: async () => {} },
    {
      isAllowed: async () => { throw new Error('connection closed by resolver'); },
      onBlocked: () => {},
      onUnexpectedRouteError: error => { unexpected.push(error); },
    },
  );

  await guard.handler(routeLike('https://public.example/', 'document', async (name, code) => { actions.push(`${name}:${code || ''}`); }));

  assert.deepEqual(actions, ['abort:failed']);
  assert.equal(unexpected.length, 1);
  assert.match(String(unexpected[0]), /connection closed by resolver/);
});

test('route guard attempts a fail-closed abort when the route lookup is already handled', async () => {
  const actions: string[] = [];
  const unexpected: unknown[] = [];
  const guard = createRenderedRouteGuard(
    { unrouteAll: async () => {} },
    { isAllowed: async () => true, onBlocked: () => {}, onUnexpectedRouteError: error => { unexpected.push(error); } },
  );

  await guard.handler({
    request: () => { throw new Error('Route is already handled!'); },
    abort: async (code?: string) => {
      actions.push(`abort:${code || ''}`);
      throw new Error('Route is already handled!');
    },
    continue: async () => { actions.push('continue'); },
  });

  assert.deepEqual(actions, ['abort:failed']);
  assert.equal(unexpected.length, 0);
});

test('route shutdown classifier accepts expected close races but not policy failures', () => {
  assert.equal(isExpectedRenderedRouteShutdownError(new Error('TargetClosedError2: Target page, context or browser has been closed')), true);
  assert.equal(isExpectedRenderedRouteShutdownError(new Error('route.continue: Target page, context or browser has been closed')), true);
  assert.equal(isExpectedRenderedRouteShutdownError(new Error('Route is already handled!')), true);
  assert.equal(isExpectedRenderedRouteShutdownError(new Error('NON_PUBLIC_DESTINATION: blocked')), false);
  assert.equal(isExpectedRenderedRouteShutdownError(new Error('unexpected routing failure')), false);
});

test('route close wrapper disposes before closing and is idempotent', async () => {
  const order: string[] = [];
  let disposeCalls = 0;
  let closeCalls = 0;
  const target = {
    close: async () => { closeCalls++; order.push('close'); },
  };
  installRenderedRouteCloseCleanup(target, async () => { disposeCalls++; order.push('dispose'); });

  await Promise.all([target.close(), target.close()]);
  await target.close();

  assert.deepEqual(order, ['dispose', 'close']);
  assert.equal(disposeCalls, 1);
  assert.equal(closeCalls, 1);
});

test('disposeRenderedRouteGuards handles repeated and already-closed contexts', async () => {
  let calls = 0;
  const guard = createRenderedRouteGuard(
    { unrouteAll: async () => { calls++; throw new Error('Target page, context or browser has been closed'); } },
    { isAllowed: async () => true, onBlocked: () => {} },
  );
  await disposeRenderedRouteGuards([guard, guard]);
  await disposeRenderedRouteGuards([guard]);
  assert.equal(calls, 1);
});

