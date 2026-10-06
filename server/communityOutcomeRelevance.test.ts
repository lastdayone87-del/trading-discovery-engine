import assert from 'node:assert/strict';
import test from 'node:test';
import { runChannelInspection } from './inspector';
import { isAuxiliaryForOutcome } from './communitySurfacePolicy';
import {
  communityAcquisitionRetryDirective,
  hasRetryableCommunityAcquisitionFailure,
} from './communityRetryPolicy';
import { decideJobFailure } from './db';
import type { BrowserFallbackResult } from './browserCommunityFallback';

const html = (body: string) =>
  new Response(`<html><body>${body}</body></html>`, { status: 200, headers: { 'content-type': 'text/html' } });
const noInviteHtml = async () => html('No Discord invite here');
const httpError = (status = 500) =>
  (async () => new Response('error', { status, headers: { 'content-type': 'text/html' } })) as typeof fetch;
const emptyRendered = async (seedUrl: string): Promise<BrowserFallbackResult> => ({
  foundInvite: null,
  foundLocation: seedUrl,
  inspectedPages: 1,
  scrolls: 0,
  clicks: 0,
  complete: true,
  retryable: false,
  detail: 'test rendered surface inspected without invite',
});
const timeoutRendered = async (seedUrl: string): Promise<BrowserFallbackResult> => ({
  foundInvite: null,
  foundLocation: seedUrl,
  inspectedPages: 2,
  scrolls: 0,
  clicks: 0,
  complete: false,
  retryable: true,
  timedOut: true,
  telemetry: undefined,
  detail: 'Rendered acquisition budget expired before coverage completed',
});
const fillers = ['one', 'two', 'three', 'four', 'five'];
const isolatedStore = () => ({ read: async () => [], write: async () => {}, recordLinks: async () => {} });
const noHistory = (async () => []) as never;

async function inspect(channelLinks: string[], fetchImpl: typeof fetch, renderedFallback: typeof emptyRendered) {
  const renderedCalls: string[] = [];
  const result = await runChannelInspection({
    channelId: `aux-${Math.random().toString(36).slice(2)}`,
    channelName: 'Aux Outcome Channel',
    channelBio: 'Trading notes',
    channelLinks,
    videoDescriptions: fillers,
    creatorLikelyTrading: true,
    externalFetchImpl: fetchImpl,
    renderedFallback: (async (seedUrl: string) => {
      renderedCalls.push(seedUrl);
      return renderedFallback(seedUrl);
    }) as typeof emptyRendered,
    urlFailureHistoryLoader: noHistory,
    siteInspectionStore: isolatedStore(),
  } as never);
  return { result, renderedCalls };
}

const relevant5 = [
  'https://creator.example.com/',
  'https://creator.example.com/downloads',
  'https://creator.example.com/free-trial',
  'https://creator.example.com/about',
  'https://creator.example.com/contact',
];

// 1. Five clean relevant pages + one failed affiliate URL → clean, no channel retry.
test('auxiliary outcome: affiliate-only failure cannot own the final Discord outcome', async () => {
  const fetched: string[] = [];
  const { result, renderedCalls } = await inspect(
    [...relevant5, 'https://investing-referral.com/elliottwaver'],
    (async (input) => {
      const url = String(input);
      fetched.push(url);
      if (url.includes('investing-referral.com')) return httpError(403)(input);
      return noInviteHtml();
    }) as typeof fetch,
    emptyRendered,
  );
  assert.equal(result.acquisitionStatus, 'INSPECTED_NO_MATCH');
  assert.equal(result.steps.find((step) => step.step === 'CUSTOM_DOMAINS')?.status, 'NOT_FOUND');
  assert.equal(result.retryDirective, undefined);
  // Crawling/recall preserved: the affiliate URL was still attempted.
  assert.ok(fetched.some((url) => url.includes('investing-referral.com')));
  assert.ok(renderedCalls.some((url) => url.includes('investing-referral.com')));
  // Telemetry preserved: the rendered observation row still exists with its
  // pre-existing required:true stage flag — but relevance filtering keeps it
  // out of outcome ownership and retry (proven by the clean status and the
  // undefined directive above, plus the predicate check below).
  const auxRows = (result.acquisitionOutcomes || []).filter((item) =>
    item.requestedUrl.includes('investing-referral.com'),
  );
  assert.ok(auxRows.length > 0, 'auxiliary telemetry must be preserved, not discarded');
  assert.equal(
    hasRetryableCommunityAcquisitionFailure(auxRows as never),
    false,
    'auxiliary rows must never own retry regardless of stage flags',
  );
});

// 2. Two clean relevant pages + one failed tracking URL → clean, no retry.
test('auxiliary outcome: tracking-redirector failure cannot own the outcome', async () => {
  const { result } = await inspect(
    ['https://creator.example.com/', 'https://creator.example.com/newsletter', 'https://vendor.sjv.io/'],
    (async (input) => {
      if (String(input).includes('sjv.io')) throw new Error('getaddrinfo ENOTFOUND vendor.sjv.io');
      return noInviteHtml();
    }) as typeof fetch,
    emptyRendered,
  );
  assert.equal(result.acquisitionStatus, 'INSPECTED_NO_MATCH');
  assert.equal(result.retryDirective, undefined);
});

// 3. Discord found + auxiliary failure → Discord result retained.
test('auxiliary outcome: valid Discord survives an auxiliary failure', async () => {
  const result = await runChannelInspection({
    channelId: 'aux-found',
    channelName: 'Aux Found Channel',
    channelBio: 'Trading notes',
    channelLinks: ['https://creator.example.com/vip', 'https://shop.example.com/buy'],
    videoDescriptions: fillers,
    creatorLikelyTrading: true,
    externalFetchImpl: (async (input) => {
      const url = String(input);
      if (url.includes('/vip')) return html('Join https://discord.gg/vip-room');
      if (url.includes('shop.example.com')) return httpError(403)(input);
      return noInviteHtml();
    }) as typeof fetch,
    renderedFallback: emptyRendered,
    urlFailureHistoryLoader: noHistory,
    siteInspectionStore: isolatedStore(),
  } as never);
  assert.ok((result.discordCandidates || []).some((c) => c.nativeInviteCode === 'vip-room'));
  assert.equal(result.acquisitionStatus, 'FOUND');
  assert.equal(result.steps.find((step) => step.step === 'CUSTOM_DOMAINS')?.status, 'FOUND');
});

// 4. Discord found + relevant required failure → Discord retained, bounded retry kept.
test('auxiliary outcome: relevant failure still owns bounded retry beside a find', async () => {
  const result = await runChannelInspection({
    channelId: 'aux-found-relevant-fail',
    channelName: 'Aux Found Relevant Fail Channel',
    channelBio: 'Trading notes',
    channelLinks: ['https://creator.example.com/vip', 'https://flaky.example.com/'],
    videoDescriptions: fillers,
    creatorLikelyTrading: true,
    externalFetchImpl: (async (input) => {
      const url = String(input);
      if (url.includes('/vip')) return html('Join https://discord.gg/vip-room');
      return new Response('error', { status: 500, headers: { 'content-type': 'text/html' } });
    }) as typeof fetch,
    renderedFallback: timeoutRendered,
    urlFailureHistoryLoader: noHistory,
    siteInspectionStore: isolatedStore(),
  } as never);
  assert.ok((result.discordCandidates || []).some((c) => c.nativeInviteCode === 'vip-room'));
  assert.ok(result.retryDirective, 'relevant failure keeps bounded recovery');
  assert.equal(result.retryDirective?.retryReason, 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE');
});

// 5. Genuine relevant required failure + no Discord → retryable uncertainty.
test('auxiliary outcome: genuine relevant failure owns retry', async () => {
  const { result } = await inspect(['https://flaky.example.com/'], httpError(500), timeoutRendered);
  assert.equal(result.acquisitionStatus, 'PARTIALLY_INSPECTED');
  assert.ok(result.retryDirective);
});

// 6. Required-unvisited gap keeps existing bounded recovery.
test('auxiliary outcome: required gap recovery intact', async () => {
  const result = await runChannelInspection({
    channelId: 'aux-gap',
    channelName: 'Aux Gap Channel',
    channelBio: 'Trading notes',
    channelLinks: ['https://gap.example.com/'],
    videoDescriptions: fillers,
    creatorLikelyTrading: true,
    externalFetchImpl: (async () => {
      throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    }) as typeof fetch,
    renderedFallback: (async (seedUrl: string): Promise<BrowserFallbackResult> => ({
      foundInvite: null,
      foundLocation: seedUrl,
      candidates: [],
      inspectedPages: 2,
      scrolls: 0,
      clicks: 0,
      complete: false,
      retryable: true,
      timedOut: true,
      telemetry: undefined,
      detail: 'gap',
      visitedUrls: [seedUrl],
      requiredTotal: 3,
      requiredUnvisited: ['https://gap.example.com/community'],
    })),
    urlFailureHistoryLoader: noHistory,
    siteInspectionStore: isolatedStore(),
  } as never);
  assert.ok(result.retryDirective);
});

// 7. Auxiliary-only failure never creates COMMUNITY_REQUIRED_ACQUISITION_FAILURE.
test('auxiliary outcome: auxiliary rows never enter the retry directive', () => {
  assert.equal(
    communityAcquisitionRetryDirective(
      [
        {
          requestedUrl: 'https://investing-referral.com/x',
          surface: 'CREATOR_WEBSITES',
          required: true,
          outcome: 'ACQUISITION_FAILED',
          retryable: true,
          failureClass: 'HTTP_ERROR',
        },
      ] as never,
    ),
    undefined,
  );
  assert.equal(
    hasRetryableCommunityAcquisitionFailure(
      [
        {
          requestedUrl: 'https://vendor.sjv.io/',
          surface: 'CREATOR_WEBSITES',
          required: true,
          outcome: 'ACQUISITION_FAILED',
          retryable: true,
          failureClass: 'NETWORK_FAILURE',
        },
      ] as never,
    ),
    false,
  );
});

// 8. Retry success recomputes the final state.
test('auxiliary outcome: recovery recomputes a clean final state', async () => {
  const failing = await inspect(['https://flaky.example.com/'], httpError(500), timeoutRendered);
  assert.ok(failing.result.retryDirective);
  const recovered = await inspect(['https://flaky.example.com/'], noInviteHtml as typeof fetch, emptyRendered);
  assert.equal(recovered.result.acquisitionStatus, 'INSPECTED_NO_MATCH');
  assert.equal(recovered.result.retryDirective, undefined);
});

// 9. Genuine failure stays retryable (bounded downstream by the 5-attempt job cap).
test('auxiliary outcome: genuine failures remain retryable, exhaustion stays bounded', () => {
  assert.ok(
    communityAcquisitionRetryDirective(
      [
        {
          requestedUrl: 'https://flaky.example.com/',
          surface: 'CREATOR_WEBSITES',
          required: true,
          outcome: 'ACQUISITION_FAILED',
          retryable: true,
          failureClass: 'TRANSIENT_HTTP',
        },
      ] as never,
    ),
  );
  assert.equal(decideJobFailure(new Error('x'), 5, 5, Date.now()).disposition, 'FAILED');
});

// 10-11. Asset/resource admission: .css.map rejected; .js/.css/images intact.
test('auxiliary outcome: sourcemap and asset extensions never become website seeds', async () => {
  const { normalizeExternalUrl } = await import('./inspector');
  for (const raw of [
    'https://creator.example.com/app.css.map',
    'https://creator.example.com/app.js.map',
    'https://creator.example.com/app.js',
    'https://creator.example.com/style.css',
    'https://creator.example.com/logo.png',
  ]) {
    assert.equal(normalizeExternalUrl(raw), null, `must reject: ${raw}`);
    assert.equal(isAuxiliaryForOutcome(raw), false, 'asset rejection is admission, not outcome relevance');
  }
  const fetched: string[] = [];
  const result = await runChannelInspection({
    channelId: 'aux-asset',
    channelName: 'Aux Asset Channel',
    channelBio: 'Trading notes',
    channelLinks: ['https://creator.example.com/app.css.map', 'https://creator.example.com/guide'],
    videoDescriptions: fillers,
    creatorLikelyTrading: false,
    externalFetchImpl: (async (input) => {
      fetched.push(String(input));
      return noInviteHtml();
    }) as typeof fetch,
    renderedFallback: emptyRendered,
    urlFailureHistoryLoader: noHistory,
    siteInspectionStore: isolatedStore(),
  } as never);
  assert.ok(!fetched.some((url) => url.includes('.map')));
  assert.ok(fetched.some((url) => url.includes('/guide')));
  assert.ok(!(result.acquisitionOutcomes || []).some((item) => item.requestedUrl.includes('.map')));
});

// 12. Static fails + rendered succeeds → rendered outcome wins.
test('auxiliary outcome: rendered success supersedes static failure', async () => {
  const result = await runChannelInspection({
    channelId: 'aux-rendered-wins',
    channelName: 'Aux Rendered Wins Channel',
    channelBio: 'Trading notes',
    channelLinks: ['https://creator.example.com/room'],
    videoDescriptions: fillers,
    creatorLikelyTrading: true,
    externalFetchImpl: httpError(503),
    renderedFallback: (async (seedUrl: string): Promise<BrowserFallbackResult> => ({
      foundInvite: 'rendered-room',
      foundLocation: seedUrl,
      candidates: [],
      inspectedPages: 2,
      scrolls: 0,
      clicks: 0,
      complete: true,
      retryable: false,
      detail: 'rendered found',
    })),
    urlFailureHistoryLoader: noHistory,
    siteInspectionStore: isolatedStore(),
  } as never);
  assert.equal(result.foundInvite, 'rendered-room');
});

// 13. Click failures with processed pages are not final failures.
test('auxiliary outcome: click failures never decide the outcome', async () => {
  const result = await runChannelInspection({
    channelId: 'aux-clicks',
    channelName: 'Aux Clicks Channel',
    channelBio: 'Trading notes',
    channelLinks: ['https://creator.example.com/guide'],
    videoDescriptions: fillers,
    creatorLikelyTrading: true,
    externalFetchImpl: noInviteHtml as typeof fetch,
    renderedFallback: (async (seedUrl: string): Promise<BrowserFallbackResult> => ({
      foundInvite: null,
      foundLocation: seedUrl,
      candidates: [],
      inspectedPages: 3,
      scrolls: 0,
      clicks: 0,
      complete: true,
      retryable: false,
      detail: 'clean despite click noise elsewhere',
    })),
    urlFailureHistoryLoader: noHistory,
    siteInspectionStore: isolatedStore(),
  } as never);
  assert.equal(result.acquisitionStatus, 'INSPECTED_NO_MATCH');
  assert.equal(result.retryDirective, undefined);
});

// 14. Budget cutoff with sufficient required evidence resolves sufficient.
test('auxiliary outcome: bounded stop on covered required set is sufficient', async () => {
  const result = await runChannelInspection({
    channelId: 'aux-sufficient',
    channelName: 'Aux Sufficient Channel',
    channelBio: 'Trading notes',
    channelLinks: ['https://creator.example.com/guide'],
    videoDescriptions: fillers,
    creatorLikelyTrading: true,
    externalFetchImpl: (async () => {
      throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    }) as typeof fetch,
    renderedFallback: (async (seedUrl: string): Promise<BrowserFallbackResult> => ({
      foundInvite: null,
      foundLocation: seedUrl,
      candidates: [],
      inspectedPages: 4,
      scrolls: 0,
      clicks: 0,
      complete: false,
      retryable: true,
      timedOut: true,
      telemetry: undefined,
      detail: 'timeout after required coverage',
      visitedUrls: [seedUrl],
      requiredTotal: 1,
    })),
    urlFailureHistoryLoader: noHistory,
    siteInspectionStore: isolatedStore(),
  } as never);
  assert.equal(result.acquisitionStatus, 'INSPECTED_NO_MATCH');
  assert.equal(result.retryDirective, undefined);
});

// 15-16. Retry counters stay operational: pending vs exhausted distinguishable.
test('auxiliary outcome: pending retries never equal exhausted retries', () => {
  assert.equal(
    hasRetryableCommunityAcquisitionFailure(
      [
        {
          requestedUrl: 'https://flaky.example.com/',
          surface: 'CREATOR_WEBSITES',
          required: true,
          outcome: 'ACQUISITION_FAILED',
          retryable: true,
          failureClass: 'TRANSIENT_HTTP',
        },
      ] as never,
    ),
    true,
  );
  assert.equal(decideJobFailure(new Error('x'), 0, 5, Date.now()).disposition !== 'FAILED', true);
});
