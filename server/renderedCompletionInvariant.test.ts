import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveRenderedCompletionState,
  wasRenderedResultProcessed,
  isPureTargetBlockOutcome,
  type BrowserFallbackTelemetry,
} from './browserCommunityFallback';
import { classifyRenderedCrawlerFailure } from './renderedCrawlerPolicy';
import { readFileSync } from 'node:fs';

test('rendered success path applies the pure-target-block retry rule', () => {
  const source = readFileSync(new URL('./browserCommunityFallback.ts', import.meta.url), 'utf8');
  assert.match(source, /isPureTargetBlockOutcome\(\{timedOut,telemetry\}\)/);
  assert.match(source, /retryable:completion\.retryable && !pureTargetBlock/);
});
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
  // Static clean (auxiliary) plus required rendered failure collapses to the
  // required failure: the zero-page pass must not be counted as a success.
  assert.equal(zeroOnly.steps.find((step) => step.step === 'CUSTOM_DOMAINS')?.status, 'ERROR');

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

// Failure classification: Playwright network signals map to TRANSIENT, while
// ambiguous signals stay OTHER/retryable (fail-open protects recall).
test('playwright network errors classify as transient, ambiguous signals stay other', () => {
  assert.equal(classifyRenderedCrawlerFailure(new Error('page.goto: net::ERR_EMPTY_RESPONSE at https://x.test')), 'TRANSIENT');
  assert.equal(classifyRenderedCrawlerFailure(new Error('page.goto: net::ERR_HTTP2_PROTOCOL_ERROR at https://x.test')), 'TRANSIENT');
  assert.equal(classifyRenderedCrawlerFailure(new Error('page.goto: net::ERR_CONNECTION_REFUSED at https://x.test')), 'TRANSIENT');
  assert.equal(classifyRenderedCrawlerFailure(new Error('page.goto: Timeout 15000ms exceeded.')), 'TRANSIENT');
  assert.equal(classifyRenderedCrawlerFailure(new Error('Request blocked - received 403 status code.')), 'BLOCKED');
  // Certificate and abort signals are ambiguous without raw-error retention:
  // they stay OTHER (retryable) rather than assuming a permanent block.
  assert.equal(classifyRenderedCrawlerFailure(new Error('page.goto: net::ERR_CERT_COMMON_NAME_INVALID at https://x.test')), 'OTHER');
  assert.equal(classifyRenderedCrawlerFailure(new Error('page.goto: net::ERR_ABORTED at https://x.test')), 'OTHER');
});

test('pure target blocks are terminal while mixed or ambiguous failures stay retryable', () => {
  const blocked = { ...zeroTelemetry(), requestsFailed: 3, blockedRequests: 3 };
  assert.equal(isPureTargetBlockOutcome({ timedOut: false, telemetry: blocked }), true);
  assert.equal(
    isPureTargetBlockOutcome({ timedOut: false, telemetry: { ...blocked, transientRequests: 1 } }),
    false,
  );
  assert.equal(
    isPureTargetBlockOutcome({ timedOut: false, telemetry: { ...blocked, navigationTimeouts: 1 } }),
    false,
  );
  assert.equal(isPureTargetBlockOutcome({ timedOut: true, telemetry: blocked }), false);
  assert.equal(isPureTargetBlockOutcome({ timedOut: false, telemetry: zeroTelemetry() }), false);
});

test('pure target block records failure without scheduling another bounded render', async () => {
  const blockedTelemetry = (): BrowserFallbackTelemetry => ({
    ...zeroTelemetry(),
    requestsStarted: 2,
    requestsFinished: 0,
    requestsFailed: 2,
    blockedRequests: 2,
  });
  // The stub returns exactly what the fixed fallback produces for pure-block
  // telemetry (complete:false, retryable:false); unit tests below pin the
  // predicate itself inside browserCommunityFallback.
  const result = await runChannelInspection({
    channelId: 'UCblocked000000000000000001',
    channelName: 'Blocked Channel',
    channelBio: 'Trading notes',
    channelLinks: ['https://blocked.example.com'],
    videoDescriptions: fillers,
    creatorLikelyTrading: true,
    externalFetchImpl: (async () => response(403, '', 'text/html')) as typeof fetch,
    renderedFallback: async (seedUrl) => ({
      foundInvite: null,
      foundLocation: seedUrl,
      candidates: [],
      inspectedPages: 0,
      scrolls: 0,
      clicks: 0,
      complete: false,
      retryable: false,
      telemetry: blockedTelemetry(),
      detail: 'all requests blocked by target',
    }),
  });
  const renderedObs = (result.acquisitionOutcomes || []).find(
    (item) => item.requestedUrl === 'https://blocked.example.com/' && item.required === true,
  );
  assert.ok(renderedObs);
  assert.equal(renderedObs?.outcome, 'ACQUISITION_FAILED');
  assert.equal(renderedObs?.retryable, false);
  assert.equal(result.retryDirective, undefined);
  assert.equal(result.acquisitionStatus, 'ACQUISITION_FAILED');
});

test('mixed block and transient failures preserve retryability', async () => {
  const result = await runChannelInspection({
    channelId: 'UCmixedfail0000000000000001',
    channelName: 'Mixed Failure Channel',
    channelBio: 'Trading notes',
    channelLinks: ['https://flaky.example.com'],
    videoDescriptions: fillers,
    creatorLikelyTrading: true,
    externalFetchImpl: (async () => response(500, '', 'text/html')) as typeof fetch,
    renderedFallback: async (seedUrl) => ({
      foundInvite: null,
      foundLocation: seedUrl,
      candidates: [],
      inspectedPages: 0,
      scrolls: 0,
      clicks: 0,
      complete: false,
      retryable: true,
      telemetry: { ...zeroTelemetry(), requestsStarted: 2, requestsFailed: 2, blockedRequests: 1, transientRequests: 1 },
      detail: 'mixed block and transient failures',
    }),
  });
  const renderedObs = (result.acquisitionOutcomes || []).find(
    (item) => item.requestedUrl === 'https://flaky.example.com/' && item.required === true,
  );
  assert.equal(renderedObs?.outcome, 'ACQUISITION_FAILED');
  assert.equal(renderedObs?.retryable, true);
  assert.equal(result.retryDirective?.retryReason, 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE');
});

test('a rejecting rendered fallback never blocks subsequent URLs', async () => {
  const renderedCalls: string[] = [];
  const result = await runChannelInspection({
    channelId: 'UCrejectfirst00000000000001',
    channelName: 'Reject First Channel',
    channelBio: 'Trading notes',
    channelLinks: ['https://reject.example.com', 'https://after.example.com'],
    videoDescriptions: fillers,
    creatorLikelyTrading: true,
    externalFetchImpl: noInviteHtml as typeof fetch,
    renderedFallback: async (seedUrl) => {
      renderedCalls.push(seedUrl);
      if (seedUrl.includes('reject.example.com')) throw new Error('browser crashed mid-seed');
      return processedStub()(seedUrl);
    },
  });
  assert.deepEqual(new Set(renderedCalls), new Set(['https://reject.example.com/', 'https://after.example.com/']));
  assert.equal(result.acquisitionStatus, 'PARTIALLY_INSPECTED');
  assert.ok(result.retryDirective);
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
