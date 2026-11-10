import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DEFAULT_BROWSER_FALLBACK_BUDGET, DECLARATIVE_SHADOW_SCAN_MAX_BYTES, advanceRenderedLifecycleStage, beginRenderedDeclarativeShadowScan, browserCauseSnippet, browserFallbackTelemetrySummary, buildRenderedLinkBaseline, classifyCrawlCatch, classifyRenderedPopupDestination, collectRenderedCrossOriginCandidates, countDeclarativeClosedShadowRoots, createRenderedRouteGuard, disposeRenderedRouteGuards, installRenderedRouteCloseCleanup, isDiscordDestinationUrl, isNativeDiscordInviteUrl, isExpectedRenderedRouteShutdownError, isTelegramPostPermalink, mergeRenderedPageContextCounts, planRevealedSameOriginEnqueues, popupMarkupEvidenceSourceUrl, readRenderedDeclarativeShadowScan, renderedCrawlStarted, renderedPopupWaitTimeoutMs, RenderedFallbackGate, renderedFallbackGate, resolveRenderedZeroPageReason, retainSkippableAnchorEvidence, shouldEnqueueRenderedCommunityLink, shouldEscalateToRenderedFallback, shouldRecordSaturatedBaselineGap, shouldSkipPreexistingSiblingPage, sumRenderedPageContextCounts, type BrowserFallbackTelemetry, type RenderedRouteLike } from './browserCommunityFallback';
import { RenderedAdmissionGovernor } from './renderedAdmissionGovernor';
import { inferDiscordOwnership, makeDiscordCandidate } from './discordCandidates';
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
  assert.equal(countDeclarativeClosedShadowRoots(malformed), 0, 'an unterminated start tag yields no closed root');

  // Raw text and comments are not markup. A template-looking string in a
  // script must neither fabricate a root nor hide a real closed root later.
  assert.equal(
    countDeclarativeClosedShadowRoots(
      `<script>const fragment = "<template data-x='";</script><div><template shadowrootmode="closed"><span>hidden</span></template></div>`,
    ),
    1,
    'a template string in a script cannot hide a later real closed root',
  );
  assert.equal(
    countDeclarativeClosedShadowRoots(
      '<script>const x = "<template shadowrootmode=\\"closed\\">";</script><p>no root</p>',
    ),
    0,
    'a template string inside a script is not a root',
  );
  assert.equal(
    countDeclarativeClosedShadowRoots(
      '<!-- <template shadowrootmode="closed"></template> --><template shadowrootmode="closed"></template>',
    ),
    1,
    'a template inside a comment is inert but a real root is still counted',
  );
  assert.equal(
    countDeclarativeClosedShadowRoots(
      '<style>.x::before{content:"<template shadowrootmode=closed>"}</style><template shadowrootmode="closed"></template>',
    ),
    1,
    'style text is skipped without losing the real root',
  );
  assert.equal(
    countDeclarativeClosedShadowRoots(
      '<div data-note="<script>"><template shadowrootmode="closed"><span>hidden</span></template></div>',
    ),
    1,
    'a raw-text tag name inside a quoted attribute cannot hide a later real root',
  );
  assert.equal(
    countDeclarativeClosedShadowRoots(
      '<div data-note="<template shadowrootmode=\'closed\'>"></div><p>no root</p>',
    ),
    0,
    'a template start tag inside a quoted attribute is inert',
  );
  assert.equal(
    countDeclarativeClosedShadowRoots(
      '<scriptx><template shadowrootmode="closed"></template></scriptx>',
    ),
    1,
    'a script-prefixed element is not raw text; its template child is real markup',
  );
  assert.equal(
    countDeclarativeClosedShadowRoots(
      '<script data-note="</script>"><template shadowrootmode="closed"></template></script>',
    ),
    0,
    'a quoted </script> in an opening attribute is not the raw-text terminator; the script body stays inert',
  );
  assert.equal(
    countDeclarativeClosedShadowRoots(
      '<script data-note="</script>">const x = 1;</script><div><template shadowrootmode="closed"></template></div>',
    ),
    1,
    'the real terminator still ends the script and a later genuine closed root is counted',
  );
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

test('declarative shadow scan bounds decoded bodies without gapping ordinary encodings', async () => {
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
  let body = '<template shadowrootmode="closed"></template>';
  const emit = (headers: Record<string, string>) => listener!({
    url: () => 'https://fixture.test/',
    status: () => 200,
    headers: () => headers,
    request: () => ({ resourceType: () => 'document', frame: () => mainFrame }),
    text: async () => { textReads++; return body; },
  });

  // Chunked / HTTP2 responses have no content-length. Their decoded body is
  // read and bounded after decoding; treating them as gaps made every such
  // page BOUNDED and retryable.
  beginRenderedDeclarativeShadowScan(page);
  emit({});
  assert.deepEqual(
    await readRenderedDeclarativeShadowScan(page as object, 0),
    { documents: 1, closedRoots: 1, gaps: 0 },
    'a chunked response is scanned, not an automatic gap',
  );
  assert.equal(textReads, 1);

  // A compressed response declares the compressed size, not the decoded size.
  beginRenderedDeclarativeShadowScan(page);
  emit({ 'content-length': '60', 'content-encoding': 'gzip' });
  assert.deepEqual(
    await readRenderedDeclarativeShadowScan(page as object, 0),
    { documents: 1, closedRoots: 1, gaps: 0 },
    'a gzip/brotli body is scanned after decoding',
  );
  assert.equal(textReads, 2);

  beginRenderedDeclarativeShadowScan(page);
  emit({ 'content-length': String(DECLARATIVE_SHADOW_SCAN_MAX_BYTES + 1) });
  assert.equal((await readRenderedDeclarativeShadowScan(page as object, 0)).gaps, 1);
  assert.equal(textReads, 2, 'an over-cap declared body is skipped before reading');

  // A server can under-declare (or omit) the length. The decoded size is
  // checked before the document is claimed scanned.
  beginRenderedDeclarativeShadowScan(page);
  body = 'x'.repeat(DECLARATIVE_SHADOW_SCAN_MAX_BYTES + 1);
  emit({ 'content-length': '60' });
  assert.deepEqual(
    await readRenderedDeclarativeShadowScan(page as object, 0),
    { documents: 0, closedRoots: 0, gaps: 1 },
    'a decoded body above the cap is a gap even when the declared length is small',
  );
  assert.equal(textReads, 3);
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

test('popup markup is attributed to the popup URL, not the branded opener', () => {
  const openerUrl = 'https://atlasfx.io/';
  const popupUrl = 'https://discord.com/channels/1/2';
  const sourceUrl = popupMarkupEvidenceSourceUrl('cross-origin', popupUrl, openerUrl);
  assert.equal(sourceUrl, popupUrl, 'a committed popup document is its own evidence source');

  const candidate = (url: string) => makeDiscordCandidate({
    locatorType: 'NATIVE_INVITE',
    sourceSurface: 'CREATOR_WEBSITES',
    rawLocator: 'https://discord.gg/third-party',
    nativeInviteCode: 'third-party',
    normalizedLocator: 'https://discord.gg/third-party',
    sourceUrl: url,
    extractionConfidence: 'EXPLICIT',
  });
  const identity = { creatorName: 'Atlas Fx', creatorWebsiteHosts: ['atlasfx.io'] };
  assert.notEqual(
    inferDiscordOwnership(candidate(sourceUrl), identity).ownershipStatus,
    'CREATOR_OWNED',
    'an invite in a generic Discord popup cannot inherit the opener brand',
  );
  assert.equal(
    inferDiscordOwnership(candidate(openerUrl), identity).ownershipStatus,
    'CREATOR_OWNED',
    'the old opener attribution is what produced the false creator-owned classification',
  );
  assert.equal(
    popupMarkupEvidenceSourceUrl('uninspectable', 'about:blank', openerUrl),
    openerUrl,
    'a document.write popup has no URL, so its markup remains attributed to the opener',
  );
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

test('rendered crawl work is recognized once the handler is entered', () => {
  assert.equal(renderedCrawlStarted({
    inspectedPages: 0,
    telemetry: { lastLifecycleStage: 'HANDLER_ENTERED' } as unknown as BrowserFallbackTelemetry,
  }), true);
  assert.equal(renderedCrawlStarted({
    inspectedPages: 0,
    telemetry: { lastLifecycleStage: 'PAGE_PROCESSED' } as unknown as BrowserFallbackTelemetry,
  }), true);
  assert.equal(renderedCrawlStarted({
    inspectedPages: 0,
    telemetry: { lastLifecycleStage: 'CRAWLER_RUNNING' } as unknown as BrowserFallbackTelemetry,
  }), false);
  assert.equal(renderedCrawlStarted({
    inspectedPages: 0,
    telemetry: { lastLifecycleStage: 'CRAWLER_RUNNING', requestsFailed: 1 } as unknown as BrowserFallbackTelemetry,
  }), true);
});

test('rendered admission governor denies over-budget crawls as capacity', async () => {
  const clock = { now: 0 };
  const governor = new RenderedAdmissionGovernor({
    enabled: true,
    nominalPerHour: 1,
    emergencyPerHour: 1,
    discoveryFloorPct: 0,
    windowMs: 60_000,
  }, () => clock.now);
  const gate = new RenderedFallbackGate(1, 4, governor);

  assert.equal(await gate.run(async () => 'first', 'RETRY'), 'first');
  await assert.rejects(
    gate.run(async () => 'second', 'RETRY'),
    (error: any) => error?.message === 'RENDERED_FALLBACK_SATURATED' && error.retryAt === 60_000,
    'rate-limited work must carry the next window expiry',
  );
  assert.deepEqual(gate.snapshot(), { active: 0, pending: 0, concurrency: 1, maxPending: 4 });

  clock.now = 60_001;
  assert.equal(await gate.run(async () => 'third', 'RETRY'), 'third');
  assert.equal(gate.admissionSnapshot().admissionsInWindow, 1);
});

test('rendered gate refunds a zero-work startup failure', async () => {
  const governor = new RenderedAdmissionGovernor({
    enabled: true,
    nominalPerHour: 1,
    emergencyPerHour: 1,
    discoveryFloorPct: 0,
    windowMs: 60_000,
  }, () => 0);
  const gate = new RenderedFallbackGate(1, 4, governor);

  const failedStart = await gate.run(
    async () => ({ started: false }),
    'RETRY',
    { isWorkStarted: result => result.started },
  );
  assert.equal(failedStart.started, false);
  assert.equal(gate.admissionSnapshot().admissionsInWindow, 0);

  const started = await gate.run(
    async () => ({ started: true }),
    'RETRY',
    { isWorkStarted: result => result.started },
  );
  assert.equal(started.started, true);
  assert.equal(gate.admissionSnapshot().admissionsInWindow, 1);
});

test('rendered gate exposes the admission id on a rejected startup', async () => {
  const governor = new RenderedAdmissionGovernor({
    enabled: true,
    nominalPerHour: 1,
    emergencyPerHour: 1,
    discoveryFloorPct: 0,
    windowMs: 60_000,
  }, () => 0);
  const gate = new RenderedFallbackGate(1, 4, governor);
  let admissionId = 0;

  await assert.rejects(
    gate.run(async () => { throw new Error('proxy startup failed'); }, 'RETRY'),
    (error: any) => {
      admissionId = Number(error?.admissionId);
      return Number.isSafeInteger(admissionId) && admissionId > 0;
    },
  );
  assert.equal(gate.admissionSnapshot().admissionsInWindow, 1);
  assert.equal(gate.refund(admissionId), true);
  assert.equal(gate.admissionSnapshot().admissionsInWindow, 0);
});

test('rendered gate keeps a discovery slot when the non-discovery queue is full', async () => {
  const governor = new RenderedAdmissionGovernor({
    enabled: true,
    nominalPerHour: 100,
    emergencyPerHour: 100,
    discoveryFloorPct: 0,
    windowMs: 60_000,
  }, () => 0);
  const gate = new RenderedFallbackGate(1, 1, governor);
  let releaseFirst!: () => void;
  const blocker = new Promise<void>(resolve => { releaseFirst = resolve; });

  const first = gate.run(async () => { await blocker; }, 'RETRY');
  await new Promise(resolve => setTimeout(resolve, 0));
  const retry = gate.run(async () => undefined, 'RETRY');
  const discovery = gate.run(async () => undefined, 'DISCOVERY');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(gate.snapshot().pending, 2, 'discovery may use the extra queue reserve');

  // The extra slot is exclusive to discovery: another RETRY is rejected.
  await assert.rejects(
    gate.run(async () => undefined, 'RETRY'),
    /RENDERED_FALLBACK_SATURATED/,
  );

  releaseFirst();
  await Promise.all([first, retry, discovery]);
});

test('rendered gate prioritizes a discovery waiter when the floor is short', async () => {
  const governor = new RenderedAdmissionGovernor({
    enabled: true,
    nominalPerHour: 10,
    emergencyPerHour: 10,
    discoveryFloorPct: 35,
    windowMs: 60_000,
  }, () => 0);
  const gate = new RenderedFallbackGate(1, 4, governor);
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>(resolve => { releaseFirst = resolve; });

  const first = gate.run(async () => {
    order.push('enrichment-start');
    await firstBlocked;
    order.push('enrichment-end');
  }, 'ENRICHMENT');
  await new Promise(resolve => setTimeout(resolve, 0));

  const retry = gate.run(async () => { order.push('retry'); }, 'RETRY');
  const discovery = gate.run(async () => { order.push('discovery'); }, 'DISCOVERY');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(gate.snapshot(), { active: 1, pending: 2, concurrency: 1, maxPending: 4 });

  releaseFirst();
  await Promise.all([first, retry, discovery]);
  assert.deepEqual(order, ['enrichment-start', 'enrichment-end', 'discovery', 'retry']);
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

test('Discord destination exclusion is not bypassed by a trailing-dot host', () => {
  assert.equal(isDiscordDestinationUrl('https://discord.gg/Abc123'), true);
  assert.equal(isDiscordDestinationUrl('https://discord.gg./Abc123'), true,
    'a DNS-equivalent trailing-dot host is still a Discord destination');
  assert.equal(isDiscordDestinationUrl('https://www.discord.com./invite/Abc123'), true);
  assert.equal(isDiscordDestinationUrl('https://canary.discord.gg./Abc123'), true);
  assert.equal(isDiscordDestinationUrl('https://linktr.ee/creator'), false);
  assert.equal(isDiscordDestinationUrl('https://notdiscord.gg.example/Abc123'), false,
    'a lookalike suffix is not a Discord host');
});

test('only native Discord invite URLs are excluded from cross-origin navigation', () => {
  assert.equal(isNativeDiscordInviteUrl('https://discord.gg/Abc123'), true);
  assert.equal(isNativeDiscordInviteUrl('https://www.discord.com/invite/Abc123'), true);
  assert.equal(isNativeDiscordInviteUrl('https://discordapp.com/invite/Abc123'), true);
  assert.equal(isNativeDiscordInviteUrl('https://discord.gg./Abc123'), true,
    'a DNS-equivalent trailing-dot host still names a native invite');
  assert.equal(isNativeDiscordInviteUrl('https://dsc.gg/creator'), false,
    'a redirect shortener carries no native code and must be resolved through navigation');
  assert.equal(isNativeDiscordInviteUrl('https://discord.me/creator'), false);
  assert.equal(isNativeDiscordInviteUrl('https://discord.io/creator'), false);
  assert.equal(isNativeDiscordInviteUrl('https://disboard.org/server/123'), false,
    'a directory page still needs a visit to reveal its invite');
  assert.equal(isNativeDiscordInviteUrl('https://discord.com/channels/123/456'), false,
    'a non-invite Discord path is not terminal invite evidence');
  assert.equal(isNativeDiscordInviteUrl('https://notdiscord.gg.example/Abc123'), false);
});

test('cross-origin requests are tagged and skip uncapped same-host fan-out', () => {
  const source = fs.readFileSync(new URL('./browserCommunityFallback.ts', import.meta.url), 'utf8');
  assert.ok(
    source.includes("userData: { crossOrigin: true }"),
    'optional third-party requests must be identifiable in the handler',
  );
  assert.match(
    source,
    /const crossOriginRequest = \(request\.userData as \{ crossOrigin\?: unknown \} \| undefined\)\?\.crossOrigin === true;/,
  );
  const guardedPasses = [...source.matchAll(/if \(!crossOriginRequest && Date\.now\(\) - startedAt < limits\.totalTimeoutMs\)/g)];
  assert.equal(
    guardedPasses.length,
    2,
    'both static same-host hint passes must be skipped for optional third-party pages',
  );
  assert.match(
    source,
    /if \(!crossOriginRequest\) await enqueueSameHostHints\(\);/,
    'the reveal-time same-host hint pass must be skipped for optional third-party pages',
  );
  const taggedOptionalEnqueues = [
    ...source.matchAll(/\.\.\.\(crossOriginRequest \? \{ userData: \{ crossOrigin: true \} \} : \{\}\)/g),
  ];
  assert.equal(
    taggedOptionalEnqueues.length,
    2,
    'revealed destinations and popups opened by a third-party page inherit the optional tag',
  );
  assert.match(
    source,
    /urls: revealedPlan\.admitted,[\s\S]{0,220}?\.\.\.\(crossOriginRequest \? \{ userData: \{ crossOrigin: true \} \} : \{\}\)/,
    'the revealed-destination enqueue propagates the optional tag',
  );
  assert.match(
    source,
    /urls: \[popupUrl\],[\s\S]{0,220}?\.\.\.\(crossOriginRequest \? \{ userData: \{ crossOrigin: true \} \} : \{\}\)/,
    'the popup enqueue propagates the optional tag',
  );
  assert.match(
    source,
    /crossOriginRequest\s*\?\s*Math\.max\(0, MAX_RENDERED_CROSS_ORIGIN_ENQUEUES - crossOriginQueued\.size\)/,
    'revealed destinations from a third-party page share the crawl-wide optional cap',
  );
  assert.match(
    source,
    /crossOriginRequest && crossOriginQueued\.size >= MAX_RENDERED_CROSS_ORIGIN_ENQUEUES/,
    'popups opened by a third-party page cannot exceed the crawl-wide optional cap',
  );
  assert.match(
    source,
    /hintPassSkipped: crossOriginRequest/,
    'hint-bearing links revealed on an optional page are admitted through the capped pass instead of being dropped',
  );
});

test('cross-origin submission is deferred until after the post-click same-host pass', () => {
  const source = fs.readFileSync(new URL('./browserCommunityFallback.ts', import.meta.url), 'utf8');
  const clickLoop = source.indexOf('let clickLoop: Awaited<ReturnType<typeof runRenderedClickLoop>>;');
  const capture = source.search(/preClickCrossOriginCandidates = await collectCrossOriginCandidates\(/);
  const reservation = source.indexOf('await enqueueCrossOrigin(false);');
  const submissions = [...source.matchAll(/await enqueueCrossOrigin\(\);/g)].map(match => match.index!);
  assert.ok(clickLoop > 0 && capture > 0 && capture < clickLoop,
    'pre-click anchors are captured before any click can replace the document');
  assert.ok(reservation > capture && reservation < clickLoop,
    'the pre-click snapshot reserves cap-owned destinations before click planning');
  assert.equal(submissions.length, 1, 'there is exactly one actual cross-origin submission');
  assert.ok(submissions[0] > clickLoop,
    'the optional pass is submitted only after the click loop and post-click same-host pass');
  const postClickSameHost = source.lastIndexOf('await enqueueSameHostHints();');
  assert.ok(postClickSameHost > clickLoop && postClickSameHost < submissions[0],
    'JS-revealed required same-host links are queued before optional cross-origin pages');
  assert.match(
    source,
    /preClickCrossOriginCandidates = await collectCrossOriginCandidates\(\);/,
    'the pre-click snapshot collects its own overflow evidence instead of discarding it',
  );
  assert.match(
    source,
    /pursuableRenderedOverflowUrls\(collection\.overflowCandidates, currentUrl\)[\s\S]{0,120}?crossOriginOverflowEligible\.add\(url\)/,
    'overflow from every snapshot is merged into one URL-deduplicated set',
  );
  assert.match(
    source,
    /const latestCandidates = await collectCrossOriginCandidates\(\);\s*const candidates = \[\.\.\.preClickCrossOriginCandidates, \.\.\.latestCandidates\];/,
    'the post-click snapshot is merged with the pre-click snapshot before accounting',
  );
  assert.equal(
    [...source.matchAll(/publishCrossOriginOverflow\(\);/g)].length,
    2,
    'overflow is published from exactly two terminal paths, never from the pre-click reservation',
  );
  assert.match(
    source,
    /if \(!limits\.crossOriginEnqueue\) \{[\s\S]{0,800}?publishCrossOriginOverflow\(\);/,
    'the default-OFF path publishes overflow on its only accounting pass',
  );
  assert.match(
    source,
    /if \(!submit\) \{[\s\S]{0,1400}?return;\s*\}[\s\S]{0,300}?publishCrossOriginOverflow\(\);/,
    'the reserve-only call never publishes overflow; the post-click submission does',
  );
  assert.match(
    source,
    /if \(!limits\.crossOriginEnqueue\) \{[\s\S]{0,800}?else if \(crossOriginOverflowSampleFilled\)/,
    'the default-OFF path treats a filled overflow sample as unclassified, not a clean absence',
  );
  assert.match(
    source,
    /for \(const candidate of collection\.candidates\)[\s\S]{0,220}?recoverRenderedOverflowCandidate\(\s*candidate,\s*crossOriginOverflowLabels,\s*crossOriginOverflowEligible,?\s*\)/,
    'a URL recovered into a later visible candidate window stops counting as truncation',
  );
  assert.match(
    source,
    /for \(const candidate of collection\.overflowCandidates\)[\s\S]{0,500}?crossOriginOverflowLabels\.set\(key, labels\);[\s\S]{0,500}?for \(const candidate of collection\.candidates\)[\s\S]{0,300}?recoverRenderedOverflowCandidate\(/,
    'overflow labels are accumulated before the visible candidates are recovered',
  );
  assert.match(
    source,
    /for \(const key of crossOriginQueued\) crossOriginOverflowEligible\.delete\(key\)/,
    'queued overflow destinations are covered work, not truncation',
  );
  assert.match(
    source,
    /\[\.\.\.alreadyVisitedSet, \.\.\.terminalSuccessUrls\]/,
    'already-inspected overflow destinations stop counting as truncation',
  );
});

test('pre-click cross-origin reservation owns cap slots without submitting', () => {
  const source = fs.readFileSync(new URL('./browserCommunityFallback.ts', import.meta.url), 'utf8');
  assert.match(source, /const crossOriginReserved = new Set<string>\(\);/);
  assert.match(
    source,
    /crossOriginQueued\.size \+ crossOriginReserved\.size < MAX_RENDERED_CROSS_ORIGIN_ENQUEUES/,
    'the click plan treats reserved cap slots as already owned',
  );
  assert.match(source, /crossOriginReserved\.has\(visitKey\)/, 'reserved hubs are never clicked');
  assert.match(
    source,
    /if \(!submit\) \{[\s\S]*?crossOriginReserved\.add\(key\)/,
    'the pre-click pass reserves admitted destinations without enqueueing them',
  );
});

test('declarative shadow scan awaits every main-document body in a generation', async () => {
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
  const pendingBodies: Array<(html: string) => void> = [];
  const emit = () => listener!({
    url: () => 'https://fixture.test/redirected',
    status: () => 200,
    headers: () => ({}),
    request: () => ({ resourceType: () => 'document', frame: () => mainFrame }),
    text: () => new Promise<string>(resolve => { pendingBodies.push(resolve); }),
  });
  // A JS redirect/location.replace can emit two main-document responses in
  // one generation. Both bodies must be awaited and counted.
  emit();
  emit();
  pendingBodies[0]('<template shadowrootmode="closed"></template>');
  await new Promise<void>(resolve => setImmediate(resolve));
  let settled = false;
  const read = readRenderedDeclarativeShadowScan(page as object, 500).then(result => {
    settled = true;
    return result;
  });
  await new Promise<void>(resolve => setTimeout(resolve, 25));
  assert.equal(settled, false, 'the read must wait for the second in-flight body');
  pendingBodies[1]('<template shadowrootmode="closed"></template><template shadowrootmode="closed"></template>');
  assert.deepEqual(await read, { documents: 2, closedRoots: 3, gaps: 0 });
});

test('popup URL waits are capped by the remaining crawl budget', () => {
  assert.equal(renderedPopupWaitTimeoutMs(5_000), 1_500);
  assert.equal(renderedPopupWaitTimeoutMs(400), 400);
  assert.equal(renderedPopupWaitTimeoutMs(0), 0);
  assert.equal(renderedPopupWaitTimeoutMs(-1), 0);
  assert.equal(renderedPopupWaitTimeoutMs(Number.NaN), 0);
});

test('skipped navigable anchors retain live text and href before exclusion', () => {
  const retained: Array<[string, string]> = [];
  const count = retainSkippableAnchorEvidence([
    { text: 'Join Discord', href: 'https://discord.gg/INVITE' },
    { text: 'Resources', href: 'https://creator.example/resources' },
    { text: 'Community', href: 'https://creator.example/community' },
    { text: 'Button without href', href: null },
  ], 'https://creator.example/', (text, url) => { retained.push([text, url]); });
  assert.equal(count, 2, 'only the cross-origin and same-origin hint-owned anchors are click-skipped');
  assert.deepEqual(retained, [
    ['Join Discord https://discord.gg/INVITE', 'https://creator.example/'],
    ['Community https://creator.example/community', 'https://creator.example/'],
  ]);
});

test('a saturated same-origin baseline never admits or counts overflow as revealed work', () => {
  // The collector keeps 500 candidates and reports the rest as overflow. A
  // page with >500 static internal links must not have that overflow treated as
  // interaction-revealed work, or every such page becomes permanently
  // BOUNDED and retries forever without any new link appearing.
  const all = Array.from({ length: 501 }, (_, index) => ({
    url: `https://creator.example/page-${index}`,
    text: `Page ${index}`,
  }));
  const collection = {
    candidates: all.slice(0, 500),
    overflowCandidates: all.slice(500),
    truncated: 1,
  };
  const baseline = buildRenderedLinkBaseline(collection);
  assert.equal(baseline.links.size, 500);
  assert.equal(baseline.saturated, true, 'an overflowing baseline is marked saturated');

  // Even a URL genuinely absent from the baseline is not admitted: static
  // overflow cannot be distinguished from interaction-revealed links.
  const revealed = [{ url: 'https://creator.example/inserted-after-click', text: 'New' }];
  const plan = planRevealedSameOriginEnqueues({
    candidates: revealed,
    currentUrl: 'https://creator.example/',
    initialLinks: baseline.links,
    alreadyVisited: new Set(),
    queued: new Set(),
    maxEnqueues: 6,
    baselineSaturated: baseline.saturated,
  });
  assert.deepEqual(plan.admitted, []);
  assert.equal(plan.budget, 0, 'saturated overflow is not a budget loss');
  assert.equal(plan.alreadyVisited, 0);
  assert.equal(plan.admissionRejected, 0);

  // The same collection with a non-saturated baseline still admits the link,
  // so the saturation guard does not suppress genuine revealed navigation.
  const unsaturated = buildRenderedLinkBaseline({ ...collection, truncated: 0 });
  const admitted = planRevealedSameOriginEnqueues({
    candidates: revealed,
    currentUrl: 'https://creator.example/',
    initialLinks: unsaturated.links,
    alreadyVisited: new Set(),
    queued: new Set(),
    maxEnqueues: 6,
    baselineSaturated: unsaturated.saturated,
  });
  assert.deepEqual(admitted.admitted, ['https://creator.example/inserted-after-click']);
});

test('a saturated baseline records one coverage gap only after a real interaction', () => {
  const baseline = buildRenderedLinkBaseline({
    candidates: Array.from({ length: 500 }, (_, index) => ({
      url: `https://creator.example/static-${index}`,
      text: `Static ${index}`,
    })),
    overflowCandidates: [{ url: 'https://creator.example/overflow', text: 'Overflow' }],
    truncated: 1,
  });
  assert.equal(baseline.saturated, true);
  const recorded = new Set<string>();
  assert.equal(
    shouldRecordSaturatedBaselineGap(baseline, false, recorded, 'doc-a'),
    false,
    'static overflow with no interaction still resolves cleanly',
  );
  assert.equal(
    shouldRecordSaturatedBaselineGap(baseline, true, recorded, 'doc-a'),
    true,
    'an interaction may have revealed a destination the saturated baseline cannot distinguish',
  );
  recorded.add('doc-a');
  assert.equal(
    shouldRecordSaturatedBaselineGap(baseline, true, recorded, 'doc-a'),
    false,
    'the ambiguity is reported once per document, not once per click',
  );
  assert.equal(
    shouldRecordSaturatedBaselineGap(baseline, true, recorded, 'doc-b'),
    true,
    'a later clicked-to document is accounted independently',
  );
  assert.equal(
    shouldRecordSaturatedBaselineGap({ links: new Set(), saturated: false }, true, recorded, 'doc-c'),
    false,
    'an unsaturated baseline classifies revealed links normally and needs no gap',
  );
});

test('a filled cross-origin overflow sample is never treated as fully classified', () => {
  const node = (href: string) => ({
    href,
    textContent: 'Outbound',
  }) as unknown as Element;
  const url = 'https://creator.example/';
  // 500 same-origin anchors are filtered before the bound. 500 cross-origin
  // anchors fill the collection, then 500 more fill the overflow sample. The
  // final anchor fills the sample exactly, so every anchor was classified.
  const exact = [
    ...Array.from({ length: 500 }, (_, index) => node(`https://creator.example/${index}`)),
    ...Array.from({ length: 1000 }, (_, index) => node(`https://outside.test/${index}`)),
  ];
  const exactCollection = collectRenderedCrossOriginCandidates(exact, url);
  assert.equal(exactCollection.candidates.length, 500);
  assert.equal(exactCollection.overflowCandidates.length, 500);
  assert.equal(exactCollection.overflowSampleFilled, false, 'a page ending at the sample bound is fully classified');

  // 500 collected + 500 sampled + one more anchor: the final anchor was never
  // classified, so an all-vendor sample still cannot certify a clean absence.
  const truncated = [
    ...Array.from({ length: 500 }, (_, index) => node(`https://creator.example/${index}`)),
    ...Array.from({ length: 1001 }, (_, index) => node(`https://outside.test/${index}`)),
  ];
  const truncatedCollection = collectRenderedCrossOriginCandidates(truncated, url);
  assert.equal(truncatedCollection.candidates.length, 500);
  assert.equal(truncatedCollection.overflowCandidates.length, 500);
  assert.equal(truncatedCollection.overflowSampleFilled, true, 'the unclassified remainder keeps coverage partial');
});
