import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRenderedRequestTracker,
  markRenderedRequestFailed,
  markRenderedRequestSucceeded,
  renderedUnresolvedFailureCount,
  resolveRenderedCompletionState,
  terminalUnresolvedFailures,
  wasRenderedResultProcessed,
  type BrowserFallbackTelemetry,
} from './browserCommunityFallback';
import type { BrowserFallbackResult } from './browserCommunityFallback';
import { normalizeExternalUrl, runChannelInspection } from './inspector';

const zeroTelemetry = (): BrowserFallbackTelemetry => ({
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
});

const zeroPageStub = (overrides: Partial<BrowserFallbackResult> = {}) =>
  (async (seedUrl: string): Promise<BrowserFallbackResult> => ({
    foundInvite: null,
    foundLocation: seedUrl,
    candidates: [],
    inspectedPages: 0,
    scrolls: 0,
    clicks: 0,
    complete: true,
    retryable: false,
    telemetry: zeroTelemetry(),
    detail: 'stub resolved without processing any request',
    ...overrides,
  })) as (seedUrl: string) => Promise<BrowserFallbackResult>;

const processedStub = () =>
  (async (seedUrl: string): Promise<BrowserFallbackResult> => ({
    foundInvite: null,
    foundLocation: seedUrl,
    candidates: [],
    inspectedPages: 1,
    scrolls: 0,
    clicks: 0,
    complete: true,
    retryable: false,
    telemetry: { ...zeroTelemetry(), requestsStarted: 1, requestsFinished: 1 },
    detail: 'stub processed one page without an invite',
  })) as (seedUrl: string) => Promise<BrowserFallbackResult>;

const response = (status: number, body = '{}', contentType = 'application/json') =>
  new Response(body, { status, headers: { 'content-type': contentType } });
const html = (body: string) => response(200, `<html><body>${body}</body></html>`, 'text/html');
const noInviteHtml = async () => html('No Discord invite here');
const fillers = ['one', 'two', 'three', 'four', 'five'];

// 1. Crawler resolves without invoking the request handler.
test('zero processed pages with clean counters is incomplete with NO_PAGE_PROCESSED', () => {
  const state = resolveRenderedCompletionState({ inspectedPages: 0, timedOut: false, telemetry: zeroTelemetry() });
  assert.equal(state.complete, false);
  assert.equal(state.retryable, true);
  assert.equal(state.failureClass, 'NO_PAGE_PROCESSED');
});

// 2. Request rejected before the handler (timeout evidence, zero admissions).
test('pre-handler rejection without admissions is incomplete with NO_PAGE_PROCESSED', () => {
  const state = resolveRenderedCompletionState({
    inspectedPages: 0,
    timedOut: false,
    telemetry: { ...zeroTelemetry(), navigationTimeouts: 1 },
  });
  assert.equal(state.complete, false);
  assert.equal(state.retryable, true);
  assert.equal(state.failureClass, 'NO_PAGE_PROCESSED');
});

// 3. Deadline reached before request admission.
test('deadline before admission is incomplete with NO_PAGE_PROCESSED', () => {
  const state = resolveRenderedCompletionState({ inspectedPages: 0, timedOut: true, telemetry: zeroTelemetry() });
  assert.equal(state.complete, false);
  assert.equal(state.retryable, true);
  assert.equal(state.failureClass, 'NO_PAGE_PROCESSED');
});

// 10. Invariant: complete=true implies processed=true.
test('invariant complete=true implies processed=true across the outcome matrix', () => {
  const cases: Array<{ inspectedPages: number; timedOut: boolean; telemetry: BrowserFallbackTelemetry }> = [
    { inspectedPages: 0, timedOut: false, telemetry: zeroTelemetry() },
    { inspectedPages: 0, timedOut: true, telemetry: zeroTelemetry() },
    { inspectedPages: 0, timedOut: false, telemetry: { ...zeroTelemetry(), navigationTimeouts: 2 } },
    { inspectedPages: 0, timedOut: false, telemetry: { ...zeroTelemetry(), requestsFailed: 1 } },
    { inspectedPages: 1, timedOut: false, telemetry: zeroTelemetry() },
    { inspectedPages: 0, timedOut: false, telemetry: { ...zeroTelemetry(), requestsStarted: 1, requestsFinished: 1 } },
    { inspectedPages: 3, timedOut: false, telemetry: { ...zeroTelemetry(), requestsStarted: 3, requestsFinished: 3 } },
    { inspectedPages: 2, timedOut: true, telemetry: { ...zeroTelemetry(), requestsStarted: 2, requestsFinished: 2 } },
  ];
  for (const input of cases) {
    const state = resolveRenderedCompletionState(input);
    const processed = wasRenderedResultProcessed({ inspectedPages: input.inspectedPages, telemetry: input.telemetry });
    if (state.complete) assert.equal(processed, true, `complete=true requires processed evidence: ${JSON.stringify(input)}`);
    if (!processed) {
      assert.equal(state.complete, false);
      assert.equal(state.retryable, true);
      assert.equal(state.failureClass, 'NO_PAGE_PROCESSED');
    }
  }
  assert.equal(wasRenderedResultProcessed(null), false);
  assert.equal(wasRenderedResultProcessed(undefined), false);
  assert.equal(wasRenderedResultProcessed({ inspectedPages: 0 }), false);
});

// 11. Zero-page incompleteness can never resolve as a clean completion.
test('zero-page incompleteness never resolves clean across zero-processed variants', () => {
  const variants: BrowserFallbackTelemetry[] = [
    zeroTelemetry(),
    { ...zeroTelemetry(), navigationTimeouts: 1 },
    { ...zeroTelemetry(), hostBackoffsApplied: 2 },
    { ...zeroTelemetry(), requestsFailed: 1 },
  ];
  for (const telemetry of variants) {
    const state = resolveRenderedCompletionState({ inspectedPages: 0, timedOut: false, telemetry });
    assert.equal(state.complete, false);
  }
  const timedOut = resolveRenderedCompletionState({ inspectedPages: 0, timedOut: true, telemetry: zeroTelemetry() });
  assert.equal(timedOut.complete, false);
});

// 4. Zero-page https://g/ never counts as successful inspection.
test('zero-page https://g/ becomes incomplete and retryable, never INSPECTED_NO_MATCH', async () => {
  let renderedCalls = 0;
  const countingZeroPageStub = zeroPageStub();
  const result = await runChannelInspection({
    channelId: 'UCzeropage0000000000000001',
    channelName: 'Zero Page Channel',
    channelBio: 'Trading notes',
    channelLinks: ['https://g/'],
    videoDescriptions: fillers,
    creatorLikelyTrading: true,
    externalFetchImpl: (async (input) => {
      if (String(input).includes('https://g/')) throw new Error('getaddrinfo ENOTFOUND g');
      return noInviteHtml();
    }) as typeof fetch,
    renderedFallback: async (seedUrl) => {
      renderedCalls++;
      return countingZeroPageStub(seedUrl);
    },
  });
  assert.equal(renderedCalls, 1);
  const renderedObs = (result.acquisitionOutcomes || []).filter(
    (item) => item.requestedUrl === 'https://g/' && item.failureClass === 'NO_PAGE_PROCESSED',
  );
  assert.equal(renderedObs.length, 1);
  assert.equal(renderedObs[0].outcome, 'ACQUISITION_FAILED');
  assert.equal(renderedObs[0].required, true);
  assert.equal(renderedObs[0].retryable, true);
  assert.ok(
    !(result.acquisitionOutcomes || []).some(
      (item) => item.requestedUrl === 'https://g/' && item.outcome === 'INSPECTED_NO_MATCH',
    ),
  );
  assert.equal(result.acquisitionStatus, 'ACQUISITION_FAILED');
  assert.equal(result.retryDirective?.retryReason, 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE');
  assert.equal(result.steps.find((step) => step.step === 'CUSTOM_DOMAINS')?.status, 'ERROR');
});

// 5. Zero-page http://fb.me/BV4REX stays eligible but never clean.
test('zero-page http://fb.me/BV4REX remains eligible yet never counts as inspected', async () => {
  assert.equal(normalizeExternalUrl('http://fb.me/BV4REX')?.kind, 'WEBSITE');
  const result = await runChannelInspection({
    channelId: 'UCzerofbme0000000000000001',
    channelName: 'Zero fb.me Channel',
    channelBio: 'Trading notes',
    channelLinks: ['http://fb.me/BV4REX'],
    videoDescriptions: fillers,
    creatorLikelyTrading: true,
    externalFetchImpl: noInviteHtml as typeof fetch,
    renderedFallback: zeroPageStub(),
  });
  // Eligible: statically attempted.
  assert.ok(
    (result.acquisitionOutcomes || []).some(
      (item) => item.requestedUrl === 'http://fb.me/BV4REX' && item.outcome === 'INSPECTED_NO_MATCH',
    ),
    'expected the static fb.me inspection to be attempted and recorded',
  );
  // But the zero-page rendered pass is incomplete, never a second clean vote.
  assert.ok(
    (result.acquisitionOutcomes || []).some(
      (item) =>
        item.requestedUrl === 'http://fb.me/BV4REX' &&
        item.outcome === 'ACQUISITION_FAILED' &&
        item.failureClass === 'NO_PAGE_PROCESSED',
    ),
  );
  assert.ok(
    !(result.acquisitionOutcomes || []).some(
      (item) => item.requestedUrl === 'http://fb.me/BV4REX' && item.outcome === 'INSPECTED_NO_MATCH' && item.required === true,
    ),
    'zero-page processing must never produce a required clean inspection',
  );
  assert.notEqual(result.acquisitionStatus, 'INSPECTED_NO_MATCH');
});

// 6. A genuine one-page fb.me inspection with no Discord stays legitimately clean.
test('genuine one-page fb.me inspection without Discord remains INSPECTED_NO_MATCH', async () => {
  const result = await runChannelInspection({
    channelId: 'UCgenuinefbme00000000000001',
    channelName: 'Genuine fb.me Channel',
    channelBio: 'Trading notes',
    channelLinks: ['http://fb.me/BV4REX'],
    videoDescriptions: fillers,
    creatorLikelyTrading: false,
    externalFetchImpl: noInviteHtml as typeof fetch,
    renderedFallback: async (seedUrl) => ({
      foundInvite: null,
      foundLocation: seedUrl,
      candidates: [],
      inspectedPages: 1,
      scrolls: 0,
      clicks: 0,
      complete: true,
      retryable: false,
      detail: 'unused',
    }),
  });
  assert.equal(result.acquisitionStatus, 'INSPECTED_NO_MATCH');
  assert.equal(result.steps.find((step) => step.step === 'CUSTOM_DOMAINS')?.status, 'NOT_FOUND');
  const staticObs = (result.acquisitionOutcomes || []).find(
    (item) => item.requestedUrl === 'http://fb.me/BV4REX' && item.outcome === 'INSPECTED_NO_MATCH',
  );
  assert.ok(staticObs && (staticObs.telemetry?.pagesInspected || 0) > 0, 'expected processed-page evidence');
});

// 8. Mixed real no-match plus zero-page incomplete yields PARTIAL.
test('mixed real no-match and zero-page incomplete yields PARTIAL with community retry', async () => {
  let renderedCalls = 0;
  const result = await runChannelInspection({
    channelId: 'UCmixedzero0000000000000001',
    channelName: 'Mixed Zero Channel',
    channelBio: 'Trading notes',
    channelLinks: ['https://clean.example.com', 'https://zero.example.com'],
    videoDescriptions: fillers,
    creatorLikelyTrading: true,
    externalFetchImpl: noInviteHtml as typeof fetch,
    renderedFallback: async (seedUrl) => {
      renderedCalls++;
      if (seedUrl.includes('zero.example.com')) return zeroPageStub()(seedUrl);
      return processedStub()(seedUrl);
    },
  });
  assert.equal(renderedCalls, 2);
  assert.equal(result.acquisitionStatus, 'PARTIALLY_INSPECTED');
  assert.equal(result.steps.find((step) => step.step === 'CUSTOM_DOMAINS')?.status, 'PARTIAL');
  assert.equal(result.retryDirective?.retryReason, 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE');
});

// 9. Step 4 success-counting: zero-only is ERROR (the required rendered
// failure dominates the superseded auxiliary static clean), genuine-only is
// NOT_FOUND.
test('Step 4 counts only evidenced inspections as success', async () => {
  const zeroOnly = await runChannelInspection({
    channelId: 'UCstepzero0000000000000001',
    channelName: 'Step Zero Channel',
    channelBio: 'Trading notes',
    channelLinks: ['https://zero.example.com'],
    videoDescriptions: fillers,
    creatorLikelyTrading: true,
    externalFetchImpl: noInviteHtml as typeof fetch,
    renderedFallback: zeroPageStub(),
  });
  // Static clean plus evidence-less required rendered failure collapses to
  // retryable PARTIAL (not FAILED): the statically inspected pages remain
  // usable evidence, so the URL must not be counted "unavailable after
  // fallback". The zero-page pass itself is still never a success.
  assert.equal(zeroOnly.steps.find((step) => step.step === 'CUSTOM_DOMAINS')?.status, 'PARTIAL');

  const genuineOnly = await runChannelInspection({
    channelId: 'UCstepgenuine00000000000001',
    channelName: 'Step Genuine Channel',
    channelBio: 'Trading notes',
    channelLinks: ['https://genuine.example.com'],
    videoDescriptions: fillers,
    creatorLikelyTrading: true,
    externalFetchImpl: noInviteHtml as typeof fetch,
    renderedFallback: processedStub(),
  });
  assert.equal(genuineOnly.steps.find((step) => step.step === 'CUSTOM_DOMAINS')?.status, 'NOT_FOUND');
});

// Static partial/failure followed by required rendered success collapses to
// INSPECTED_NO_MATCH end to end (never PARTIALLY_INSPECTED).
test('static budget exhaustion with later successful rendered completion reports INSPECTED_NO_MATCH', async () => {
  const rootLinks = Array.from({ length: 12 }, (_, i) => `<a href="/community-${i}">community ${i}</a>`).join('');
  const result = await runChannelInspection({
    channelId: 'UCexhaustrender000000000001',
    channelName: 'Exhaust Render Channel',
    channelBio: 'Trading notes',
    channelLinks: ['https://exhaust.test/'],
    videoDescriptions: fillers,
    creatorLikelyTrading: true,
    externalFetchImpl: (async (input) =>
      String(input) === 'https://exhaust.test/'
        ? html(rootLinks)
        : html('Subpage without invite')) as typeof fetch,
    renderedFallback: processedStub(),
  });
  assert.equal(result.acquisitionStatus, 'INSPECTED_NO_MATCH');
  assert.equal(result.steps.find((step) => step.step === 'CUSTOM_DOMAINS')?.status, 'NOT_FOUND');
  assert.equal(result.retryDirective, undefined);
});

// 7. Duplicate URLs collapse without losing the unique target.
test('duplicate discovered URLs collapse to a single attempted target', async () => {
  const result = await runChannelInspection({
    channelId: 'UCdupseed000000000000000001',
    channelName: 'Duplicate Seed Channel',
    channelBio: 'Trading notes',
    channelLinks: ['https://dup.example.com/x', 'https://dup.example.com/x'],
    videoDescriptions: fillers,
    creatorLikelyTrading: false,
    externalFetchImpl: noInviteHtml as typeof fetch,
    renderedFallback: async (seedUrl) => ({
      foundInvite: null,
      foundLocation: seedUrl,
      candidates: [],
      inspectedPages: 1,
      scrolls: 0,
      clicks: 0,
      complete: true,
      retryable: false,
      detail: 'unused',
    }),
  });
  const seedObs = (result.acquisitionOutcomes || []).filter(
    (item) => item.surface === 'CREATOR_WEBSITES' && item.requestedUrl === 'https://dup.example.com/x',
  );
  assert.equal(seedObs.length, 1);
  assert.equal(seedObs[0].outcome, 'INSPECTED_NO_MATCH');
  assert.equal(result.acquisitionStatus, 'INSPECTED_NO_MATCH');
});

// A failed attempt that later succeeds is recovered: raw requestsFailed must
// not invalidate coverage on its own — only terminal unresolved failures do.
test('pages processed with one recovered failed request still completes', () => {
  const state = resolveRenderedCompletionState({
    inspectedPages: 3,
    timedOut: false,
    telemetry: { ...zeroTelemetry(), requestsStarted: 4, requestsFinished: 3, requestsFailed: 1, transientRequests: 1, unresolvedFailedRequests: 0 },
  });
  assert.equal(state.complete, true);
  assert.equal(state.retryable, false);
  assert.equal(state.failureClass, undefined);
});

// A permanently failed child after its attempts keeps the crawl incomplete
// even when the seed and siblings succeeded: the failed child may hold the
// Discord evidence sought.
test('successful seed with terminally failed child stays incomplete and retryable', () => {
  const state = resolveRenderedCompletionState({
    inspectedPages: 2,
    timedOut: false,
    telemetry: { ...zeroTelemetry(), requestsStarted: 3, requestsFinished: 2, requestsFailed: 1, transientRequests: 1, unresolvedFailedRequests: 1 },
  });
  assert.equal(state.complete, false);
  assert.equal(state.retryable, true);
});

test('terminalUnresolvedFailures counts failed URLs with no later success', () => {
  assert.equal(terminalUnresolvedFailures([], []), 0);
  assert.equal(terminalUnresolvedFailures(['https://a.example/x'], ['https://a.example/x']), 0);
  assert.equal(terminalUnresolvedFailures(['https://a.example/x', 'https://a.example/x'], ['https://a.example/x']), 0);
  assert.equal(terminalUnresolvedFailures(['https://a.example/x'], []), 1);
  assert.equal(
    terminalUnresolvedFailures(
      ['https://a.example/x', 'https://b.example/y'],
      ['https://a.example/x'],
    ),
    1,
  );
});

// Failures with zero pages remain failures; timeouts always stay incomplete.
test('failures without pages and expirations stay incomplete and retryable', () => {
  const noPages = resolveRenderedCompletionState({
    inspectedPages: 0,
    timedOut: false,
    telemetry: { ...zeroTelemetry(), requestsStarted: 2, requestsFailed: 2 },
  });
  assert.equal(noPages.complete, false);
  assert.equal(noPages.retryable, true);
  const expired = resolveRenderedCompletionState({
    inspectedPages: 3,
    timedOut: true,
    telemetry: { ...zeroTelemetry(), requestsStarted: 3, requestsFinished: 3 },
  });
  assert.equal(expired.complete, false);
  assert.equal(expired.retryable, true);
});

// Clicks are opportunistic traversal, never acquisition evidence.
test('click failures never affect completion when pages were processed', () => {
  const state = resolveRenderedCompletionState({
    inspectedPages: 2,
    timedOut: false,
    telemetry: { ...zeroTelemetry(), requestsStarted: 2, requestsFinished: 2, clicksStarted: 4, clicksSucceeded: 1, clicksFailed: 3 },
  });
  assert.equal(state.complete, true);
  assert.equal(state.retryable, false);
});

// Static clean + evidence-less rendered failure collapses to retryable PARTIAL.
test('static clean survives evidence-less rendered failure as retryable partial', async () => {
  const result = await runChannelInspection({
    channelId: 'UCstatclean000000000000001',
    channelName: 'Static Clean Channel',
    channelBio: 'Trading notes',
    channelLinks: ['https://clean.example.com/'],
    videoDescriptions: fillers,
    creatorLikelyTrading: true,
    externalFetchImpl: (async () => noInviteHtml()) as typeof fetch,
    renderedFallback: zeroPageStub({ detail: 'gate saturated, zero pages processed' }),
  });
  // Effective step aggregate (not raw observations) carries the synthesis.
  assert.equal(result.steps.find((step) => step.step === 'CUSTOM_DOMAINS')?.status, 'PARTIAL');
  const details = result.steps.find((step) => step.step === 'CUSTOM_DOMAINS')?.details;
  const text = Array.isArray(details) ? details.join('\n') : String(details || '');
  assert.ok(!text.includes('remained unavailable after fallback'));
  assert.equal(result.acquisitionStatus, 'PARTIALLY_INSPECTED');
  assert.equal(result.retryDirective?.retryReason, 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE');
});

// Rendered timeout with real pages is partial with budget-expired class.
test('rendered budget expiry with pages is PARTIALLY_INSPECTED, never unavailable', async () => {
  const result = await runChannelInspection({
    channelId: 'UCtimeoutpages0000000000001',
    channelName: 'Timeout Pages Channel',
    channelBio: 'Trading notes',
    channelLinks: ['https://slow.example.com/'],
    videoDescriptions: fillers,
    creatorLikelyTrading: true,
    externalFetchImpl: (async () => noInviteHtml()) as typeof fetch,
    renderedFallback: (async (seedUrl: string) => ({
      foundInvite: null,
      foundLocation: seedUrl,
      candidates: [],
      inspectedPages: 2,
      scrolls: 0,
      clicks: 0,
      complete: false,
      retryable: true,
      timedOut: true,
      telemetry: { ...zeroTelemetry(), requestsStarted: 2, requestsFinished: 2 },
      detail: 'Rendered acquisition budget expired before coverage completed',
    })) as (seedUrl: string) => Promise<BrowserFallbackResult>,
  });
  const renderedObs = (result.acquisitionOutcomes || []).filter((item) => item.requestedUrl === 'https://slow.example.com/');
  assert.ok(renderedObs.some((item) => item.outcome === 'PARTIALLY_INSPECTED' && item.failureClass === 'RENDERED_BUDGET_EXPIRED' && item.retryable === true));
  assert.ok(!renderedObs.some((item) => item.outcome === 'ACQUISITION_FAILED'));
});

// Full candidate set is preserved: failures never drop siblings, dedupe is exact.
test('deduped candidate set is fully preserved across mixed success and failure', async () => {
  const seen: string[] = [];
  const result = await runChannelInspection({
    channelId: 'UCcandidateset000000000001',
    channelName: 'Candidate Set Channel',
    channelBio: 'Trading notes',
    channelLinks: ['https://one.example.com/', 'https://two.example.com/', 'https://one.example.com/'],
    videoDescriptions: fillers,
    creatorLikelyTrading: true,
    externalFetchImpl: (async () => noInviteHtml()) as typeof fetch,
    renderedFallback: (async (seedUrl: string) => {
      seen.push(seedUrl);
      if (seedUrl.includes('one.example')) throw new Error('boom');
      return {
        foundInvite: null, foundLocation: seedUrl, candidates: [], inspectedPages: 1, scrolls: 0, clicks: 0,
        complete: true, retryable: false, telemetry: { ...zeroTelemetry(), requestsStarted: 1, requestsFinished: 1 },
        detail: 'clean',
      };
    }) as (seedUrl: string) => Promise<BrowserFallbackResult>,
  });
  // Both unique seeds attempted exactly once despite the first failing.
  assert.deepEqual([...seen].sort(), ['https://one.example.com/', 'https://two.example.com/']);
  const urls = new Set((result.acquisitionOutcomes || []).filter((item) => item.surface === 'CREATOR_WEBSITES').map((item) => item.requestedUrl));
  assert.ok(urls.has('https://one.example.com/'));
  assert.ok(urls.has('https://two.example.com/'));
});

// A started-but-never-inspected request is zero-page evidence, not processing.
test('request starting without page inspection does not count as processed', () => {
  assert.equal(wasRenderedResultProcessed({ inspectedPages: 0, telemetry: { requestsStarted: 2 } }), false);
  assert.equal(wasRenderedResultProcessed({ inspectedPages: 1, telemetry: { requestsStarted: 1 } }), true);
  const state = resolveRenderedCompletionState({
    inspectedPages: 0,
    timedOut: false,
    telemetry: { ...zeroTelemetry(), requestsStarted: 2, requestsFinished: 1 },
  });
  assert.equal(state.complete, false);
  assert.equal(state.retryable, true);
  assert.equal(state.failureClass, 'NO_PAGE_PROCESSED');
});

// Lifecycle 1: seed + child fails once + retry succeeds → recovered → COMPLETE.
// Exercises the exact tracker/completion composition wired into the crawler.
test('lifecycle recovered failure completes with usable page evidence', () => {
  const tracker = createRenderedRequestTracker();
  markRenderedRequestFailed(tracker, 'https://creator.example/child');
  markRenderedRequestSucceeded(tracker, 'https://creator.example/');
  markRenderedRequestSucceeded(tracker, 'https://creator.example/child');
  assert.equal(renderedUnresolvedFailureCount(tracker), 0);
  const state = resolveRenderedCompletionState({
    inspectedPages: 2,
    timedOut: false,
    telemetry: { ...zeroTelemetry(), requestsStarted: 2, requestsFinished: 2, requestsFailed: 1, transientRequests: 1, unresolvedFailedRequests: renderedUnresolvedFailureCount(tracker) },
  });
  assert.equal(state.complete, true);
  assert.equal(state.retryable, false);
});

// Lifecycle 2: seed succeeds + child permanently fails → INCOMPLETE + retryable.
test('lifecycle terminal child failure keeps crawl incomplete and retryable', () => {
  const tracker = createRenderedRequestTracker();
  markRenderedRequestSucceeded(tracker, 'https://creator.example/');
  markRenderedRequestFailed(tracker, 'https://creator.example/child');
  markRenderedRequestFailed(tracker, 'https://creator.example/child');
  assert.equal(renderedUnresolvedFailureCount(tracker), 1);
  const state = resolveRenderedCompletionState({
    inspectedPages: 1,
    timedOut: false,
    telemetry: { ...zeroTelemetry(), requestsStarted: 2, requestsFinished: 1, requestsFailed: 2, transientRequests: 2, unresolvedFailedRequests: renderedUnresolvedFailureCount(tracker) },
  });
  assert.equal(state.complete, false);
  assert.equal(state.retryable, true);
});

// Lifecycle 3: failed/blocked sole request + zero pages → NO_PAGE_PROCESSED.
test('lifecycle blocked sole request with zero pages is NO_PAGE_PROCESSED', () => {
  const tracker = createRenderedRequestTracker();
  markRenderedRequestFailed(tracker, 'https://blocked.example/');
  assert.equal(renderedUnresolvedFailureCount(tracker), 1);
  const state = resolveRenderedCompletionState({
    inspectedPages: 0,
    timedOut: false,
    telemetry: { ...zeroTelemetry(), requestsStarted: 1, requestsFailed: 1, blockedRequests: 1, unresolvedFailedRequests: renderedUnresolvedFailureCount(tracker) },
  });
  assert.equal(state.complete, false);
  assert.equal(state.retryable, true);
  assert.equal(state.failureClass, 'NO_PAGE_PROCESSED');
});

// Lifecycle 5: click handling never touches request terminal accounting.
test('lifecycle click outcomes never affect terminal accounting or completion', () => {
  const tracker = createRenderedRequestTracker();
  markRenderedRequestSucceeded(tracker, 'https://creator.example/');
  // Clicks have no mark function by design: only page processing and request
  // failures participate. Completion with click failures stays complete.
  const state = resolveRenderedCompletionState({
    inspectedPages: 2,
    timedOut: false,
    telemetry: { ...zeroTelemetry(), requestsStarted: 2, requestsFinished: 2, unresolvedFailedRequests: renderedUnresolvedFailureCount(tracker), clicksStarted: 4, clicksSucceeded: 1, clicksFailed: 3 },
  });
  assert.equal(renderedUnresolvedFailureCount(tracker), 0);
  assert.equal(state.complete, true);
  assert.equal(state.retryable, false);
});

// Later terminal failure revokes earlier success: last disposition wins.
test('lifecycle later terminal failure revokes earlier page success', () => {
  const tracker = createRenderedRequestTracker();
  markRenderedRequestSucceeded(tracker, 'https://creator.example/child');
  markRenderedRequestFailed(tracker, 'https://creator.example/child');
  assert.equal(renderedUnresolvedFailureCount(tracker), 1);
  const state = resolveRenderedCompletionState({
    inspectedPages: 1,
    timedOut: false,
    telemetry: { ...zeroTelemetry(), requestsStarted: 1, requestsFinished: 0, requestsFailed: 1, unresolvedFailedRequests: renderedUnresolvedFailureCount(tracker) },
  });
  assert.equal(state.complete, false);
  assert.equal(state.retryable, true);
});

// Full lifecycle: fail → success → fail ends unresolved (never clean).
test('lifecycle fail-success-fail sequence stays unresolved', () => {
  const tracker = createRenderedRequestTracker();
  markRenderedRequestFailed(tracker, 'https://creator.example/child');
  markRenderedRequestSucceeded(tracker, 'https://creator.example/child');
  assert.equal(renderedUnresolvedFailureCount(tracker), 0);
  markRenderedRequestFailed(tracker, 'https://creator.example/child');
  assert.equal(renderedUnresolvedFailureCount(tracker), 1);
});

// Failed initial extraction claims no page: zero pages + terminal failure.
test('lifecycle failed extraction yields NO_PAGE_PROCESSED, never partial', () => {
  const tracker = createRenderedRequestTracker();
  markRenderedRequestFailed(tracker, 'https://creator.example/');
  const state = resolveRenderedCompletionState({
    inspectedPages: 0,
    timedOut: false,
    telemetry: { ...zeroTelemetry(), requestsStarted: 1, requestsFailed: 1, unresolvedFailedRequests: renderedUnresolvedFailureCount(tracker) },
  });
  assert.equal(state.complete, false);
  assert.equal(state.retryable, true);
  assert.equal(state.failureClass, 'NO_PAGE_PROCESSED');
});

// Step 4 reporting splits populations instead of comparing observations to URLs.
test('linked-website summary separates URLs, static, rendered, pages, retryables', async () => {
  const { summarizeLinkedWebsiteAcquisition, formatLinkedWebsiteAcquisitionSummary } = await import('./inspector');
  const summary = summarizeLinkedWebsiteAcquisition([
    { requestedUrl: 'https://a.example/', surface: 'CREATOR_WEBSITES', required: false, outcome: 'INSPECTED_NO_MATCH', retryable: false, detail: '', observedAt: '', telemetry: { mode: 'STATIC', redirectsFollowed: 0, pagesInspected: 2, budgetExhausted: false, clicksStarted: 0, clicksSucceeded: 0, clicksFailed: 0, requestsStarted: 0, requestsFinished: 0, requestsFailed: 0, navigationTimeouts: 0, blockedRequests: 0, rateLimitedRequests: 0, hostBackoffsApplied: 0 } },
    { requestedUrl: 'https://a.example/', surface: 'CREATOR_WEBSITES', required: true, outcome: 'ACQUISITION_FAILED', retryable: true, failureClass: 'NO_PAGE_PROCESSED', detail: '', observedAt: '' },
    { requestedUrl: 'https://b.example/docs', surface: 'CREATOR_WEBSITES', required: false, outcome: 'INSPECTED_NO_MATCH', retryable: false, detail: '', observedAt: '' },
  ]);
  assert.equal(summary.uniqueRootUrls, 2);
  assert.equal(summary.staticRan, 2);
  assert.equal(summary.staticSucceeded, 1);
  assert.equal(summary.staticFailed, 0);
  assert.equal(summary.renderedRan, 1);
  assert.equal(summary.renderedSucceeded, 0);
  assert.equal(summary.renderedFailed, 1);
  assert.equal(summary.pagesProcessed, 2);
  assert.equal(summary.retryableFailures, 1);
  const text = formatLinkedWebsiteAcquisitionSummary(summary);
  assert.match(text, /2 unique website URL\(s\)/);
  assert.match(text, /static: 2 attempted, 1 inspected, 0 failed/);
  assert.match(text, /rendered fallback: 1 attempted, 0 inspected, 1 failed/);
  assert.match(text, /2 page\(s\) processed/);
  assert.match(text, /1 retryable failure\(s\)/);
});

// Static required:true failures (messaging previews use the flag for retry
// ownership) must not be reported as rendered fallback attempts.
test('required static failures split as static, not rendered', async () => {
  const { summarizeLinkedWebsiteAcquisition } = await import('./inspector');
  const staticTelemetry = (pages: number) => ({ mode: 'STATIC' as const, redirectsFollowed: 0, pagesInspected: pages, budgetExhausted: false, clicksStarted: 0, clicksSucceeded: 0, clicksFailed: 0, requestsStarted: 0, requestsFinished: 0, requestsFailed: 0, navigationTimeouts: 0, blockedRequests: 0, rateLimitedRequests: 0, hostBackoffsApplied: 0 });
  const summary = summarizeLinkedWebsiteAcquisition([
    { requestedUrl: 'https://t.me/preview', surface: 'CREATOR_WEBSITES', required: true, outcome: 'ACQUISITION_FAILED', retryable: true, detail: '', observedAt: '', telemetry: staticTelemetry(0) },
    { requestedUrl: 'https://site.example/', surface: 'CREATOR_WEBSITES', required: true, outcome: 'ACQUISITION_FAILED', retryable: true, detail: '', observedAt: '' },
  ]);
  assert.equal(summary.staticRan, 1);
  assert.equal(summary.staticFailed, 1);
  assert.equal(summary.renderedRan, 1);
  assert.equal(summary.renderedFailed, 1);
});

// Cumulative per-crawl counters must not multiply pages across observations.
test('pages are deduplicated per URL instead of summed raw', async () => {
  const { summarizeLinkedWebsiteAcquisition } = await import('./inspector');
  const telemetry = (pages: number) => ({ mode: 'STATIC' as const, redirectsFollowed: 0, pagesInspected: pages, budgetExhausted: false, clicksStarted: 0, clicksSucceeded: 0, clicksFailed: 0, requestsStarted: 0, requestsFinished: 0, requestsFailed: 0, navigationTimeouts: 0, blockedRequests: 0, rateLimitedRequests: 0, hostBackoffsApplied: 0 });
  const summary = summarizeLinkedWebsiteAcquisition([
    { requestedUrl: 'https://a.example/sub', surface: 'CREATOR_WEBSITES', required: false, outcome: 'ACQUISITION_FAILED', retryable: true, detail: '', observedAt: '', telemetry: telemetry(2) },
    { requestedUrl: 'https://a.example/', surface: 'CREATOR_WEBSITES', required: false, outcome: 'INSPECTED_NO_MATCH', retryable: false, detail: '', observedAt: '', telemetry: telemetry(5) },
  ]);
  assert.equal(summary.uniqueRootUrls, 2);
  assert.equal(summary.pagesProcessed, 7);
  const sameUrl = summarizeLinkedWebsiteAcquisition([
    { requestedUrl: 'https://a.example/', surface: 'CREATOR_WEBSITES', required: false, outcome: 'ACQUISITION_FAILED', retryable: true, detail: '', observedAt: '', telemetry: telemetry(2) },
    { requestedUrl: 'https://a.example/', surface: 'CREATOR_WEBSITES', required: false, outcome: 'INSPECTED_NO_MATCH', retryable: false, detail: '', observedAt: '', telemetry: telemetry(5) },
  ]);
  assert.equal(sameUrl.uniqueRootUrls, 1);
  assert.equal(sameUrl.pagesProcessed, 5);
});

// FOUND results carry the same split summary (previously omitted entirely).
test('found website acquisition still reports the URL/phase split', async () => {
  const result = await runChannelInspection({
    channelId: 'UCfoundwithsummary00000001',
    channelName: 'Found Summary Channel',
    channelBio: 'Trading notes',
    channelLinks: ['https://found.example/'],
    videoDescriptions: fillers,
    creatorLikelyTrading: false,
    externalFetchImpl: (async () => html('<html><body><p>Join https://discord.gg/foundroom1</p></body></html>')) as typeof fetch,
  });
  const step = result.steps.find((item) => item.step === 'CUSTOM_DOMAINS');
  assert.equal(step?.status, 'FOUND');
  assert.match(step?.details || '', /unique website URL\(s\)/);
  assert.match(step?.details || '', /static:/);
});

// Child-fetch failures group under their seed root: one crawled website,
// pages counted once per root crawl, never multiplied.
test('child observations collapse to the seed root URL', async () => {
  const { summarizeLinkedWebsiteAcquisition } = await import('./inspector');
  const telemetry = (pages: number) => ({ mode: 'STATIC' as const, redirectsFollowed: 0, pagesInspected: pages, budgetExhausted: false, clicksStarted: 0, clicksSucceeded: 0, clicksFailed: 0, requestsStarted: 0, requestsFinished: 0, requestsFailed: 0, navigationTimeouts: 0, blockedRequests: 0, rateLimitedRequests: 0, hostBackoffsApplied: 0 });
  const summary = summarizeLinkedWebsiteAcquisition([
    { requestedUrl: 'https://root.example/guide/part-1', surface: 'CREATOR_WEBSITES', required: false, outcome: 'ACQUISITION_FAILED', retryable: true, detail: '', observedAt: '', rootUrl: 'https://root.example/', telemetry: telemetry(2) },
    { requestedUrl: 'https://root.example/guide/part-2', surface: 'CREATOR_WEBSITES', required: false, outcome: 'ACQUISITION_FAILED', retryable: true, detail: '', observedAt: '', rootUrl: 'https://root.example/', telemetry: telemetry(4) },
    { requestedUrl: 'https://root.example/', surface: 'CREATOR_WEBSITES', required: false, outcome: 'INSPECTED_NO_MATCH', retryable: false, detail: '', observedAt: '', rootUrl: 'https://root.example/', telemetry: telemetry(4) },
    { requestedUrl: 'https://other.example/', surface: 'CREATOR_WEBSITES', required: false, outcome: 'INSPECTED_NO_MATCH', retryable: false, detail: '', observedAt: '', telemetry: telemetry(1) },
  ]);
  assert.equal(summary.uniqueRootUrls, 2);
  assert.equal(summary.pagesProcessed, 5);
  assert.equal(summary.staticFailed, 2);
  assert.equal(summary.staticSucceeded, 2);
});

// Static crawl tags every observation of a seed crawl with the seed root.
test('static crawl observations carry the seed root URL', async () => {
  const { crawlExternalLinks } = await import('./inspector');
  const result = await crawlExternalLinks(
    ['https://rootsite.example/'],
    [],
    undefined,
    (async (input: unknown) => {
      const url = String(input);
      if (url === 'https://rootsite.example/') {
        return html('<html><body><a href="/community">join our community</a><p>hello</p></body></html>');
      }
      throw new Error('connection reset');
    }) as typeof fetch,
    'CREATOR_WEBSITES',
    false,
  );
  const urls = new Set(result.observations.map(item => (item as { rootUrl?: string }).rootUrl || item.requestedUrl));
  assert.ok(result.observations.length > 1, 'child page must actually be fetched and fail');
  assert.deepEqual([...urls], ['https://rootsite.example/']);
});
