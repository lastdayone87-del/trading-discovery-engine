import assert from 'node:assert/strict';
import test from 'node:test';
import {
  runChannelInspection as runChannelInspectionImpl,
  isCommunityRelevantObservation,
  summarizeEffectiveLinkedWebsiteAcquisition,
  summarizeLinkedWebsiteAcquisition,
  normalizeExternalUrl,
} from './inspector';
import { runChannelInspectionForTest as runChannelInspection } from './testCrawlHelpers';
import { isAuxiliaryForOutcome, acquisitionOwnershipUrl } from './communitySurfacePolicy';
import {
  communityAcquisitionRetryDirective,
  hasRetryableCommunityAcquisitionFailure,
  isCommunityRetryableObservation,
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

async function inspect(
  channelLinks: string[],
  fetchImpl: typeof fetch,
  renderedFallback: typeof emptyRendered,
  historyLoader: never = noHistory,
) {
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
    urlFailureHistoryLoader: historyLoader,
    siteInspectionStore: isolatedStore(),
  } as never);
  return { result, renderedCalls };
}

const cappedHistoryFor = (url: string) =>
  Array.from({ length: 5 }, (_, index) => ({
    requestedUrl: url,
    failureClass: 'HTTP_ERROR',
    outcome: 'ACQUISITION_FAILED',
    observedAt: new Date(Date.UTC(2026, 8, 10 - index, 12)).toISOString(),
  }));

const relevant5 = [
  'https://creator.example.com/',
  'https://creator.example.com/downloads',
  'https://creator.example.com/free-trial',
  'https://creator.example.com/about',
  'https://creator.example.com/contact',
];

// 1. Five clean relevant pages + one retryably-failed affiliate URL (HTTP 500
// static, incomplete rendered) → clean, no channel retry. Non-vacuous: the
// raw auxiliary row stays a genuinely retryable failure, so only the
// auxiliary classifier can explain the clean channel outcome.
test('auxiliary outcome: affiliate-only failure cannot own the final Discord outcome', async () => {
  const fetched: string[] = [];
  const { result, renderedCalls } = await inspect(
    [...relevant5, 'https://investing-referral.com/elliottwaver'],
    (async (input) => {
      const url = String(input);
      fetched.push(url);
      if (url.includes('investing-referral.com')) return httpError(500)(input);
      return noInviteHtml();
    }) as typeof fetch,
    (async (seedUrl: string): Promise<BrowserFallbackResult> => {
      if (seedUrl.includes('investing-referral.com')) return timeoutRendered(seedUrl);
      return emptyRendered(seedUrl);
    }) as typeof emptyRendered,
  );
  assert.equal(result.acquisitionStatus, 'INSPECTED_NO_MATCH');
  assert.equal(result.steps.find((step) => step.step === 'CUSTOM_DOMAINS')?.status, 'NOT_FOUND');
  assert.equal(result.retryDirective, undefined);
  // Crawling/recall preserved: the affiliate URL was still attempted.
  assert.ok(fetched.some((url) => url.includes('investing-referral.com')));
  assert.ok(renderedCalls.some((url) => url.includes('investing-referral.com')));
  // The raw auxiliary failure is genuinely retryable at the observation
  // level — the test would be vacuous (pass without the guard) otherwise.
  const auxRows = (result.acquisitionOutcomes || []).filter((item) =>
    item.requestedUrl.includes('investing-referral.com'),
  );
  assert.ok(auxRows.length > 0, 'auxiliary telemetry must be preserved, not discarded');
  assert.ok(
    auxRows.some((item) => item.outcome === 'ACQUISITION_FAILED' && item.retryable),
    'fixture must hold a genuinely retryable auxiliary failure',
  );
  // …yet it owns neither retry nor outcome.
  assert.equal(
    hasRetryableCommunityAcquisitionFailure(auxRows as never),
    false,
    'auxiliary rows must never own retry regardless of stage flags',
  );
  assert.equal(
    communityAcquisitionRetryDirective(auxRows.filter((item) => item.required) as never),
    undefined,
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
      if (url.includes('shop.example.com')) return httpError(500)(input);
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

// 13. Real click failure/noise with processed pages is not a final failure.
// Clicks are opportunistic traversal, never acquisition evidence: 3 clicks
// attempted with 3 click-level failures on top of 3 successfully inspected
// pages must still resolve clean. If click outcomes ever fed the acquisition
// outcome, this fixture (clicksFailed > 0, complete) would flip to failure.
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
      scrolls: 1,
      clicks: 3,
      complete: true,
      retryable: false,
      telemetry: {
        clicksStarted: 5,
        clicksSucceeded: 2,
        clicksFailed: 3,
      } as never,
      detail: 'clean inspection with click-level noise elsewhere',
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

// 17. Query-only affiliate signal survives normalization: a bare `?ref=`
// link is auxiliary even though it carries no affiliate path or host
// segment, and its failure cannot own the outcome.
test('auxiliary outcome: query-only ref link stays auxiliary end to end', async () => {
  const refUrl = 'https://creator.example.com/?ref=BRANDON';
  assert.ok(normalizeExternalUrl(refUrl), 'bare-ref URL must still be admitted for crawling');
  assert.equal(isAuxiliaryForOutcome(refUrl), true, 'bare ?ref= must classify auxiliary');
  assert.equal(
    isCommunityRelevantObservation({ requestedUrl: refUrl }),
    false,
    'query-only affiliate observation must not be community-relevant',
  );
  const { result } = await inspect(
    [...relevant5.slice(0, 2), refUrl],
    (async (input) => {
      if (String(input).includes('ref=BRANDON')) return httpError(500)(input);
      return noInviteHtml();
    }) as typeof fetch,
    (async (seedUrl: string): Promise<BrowserFallbackResult> => {
      if (seedUrl.includes('ref=BRANDON')) return timeoutRendered(seedUrl);
      return emptyRendered(seedUrl);
    }) as typeof emptyRendered,
  );
  assert.equal(result.acquisitionStatus, 'INSPECTED_NO_MATCH');
  assert.equal(result.retryDirective, undefined);
});

// 18. Common affiliate query-key families (incl. Code/Id variants) classify
// auxiliary; unfamiliar keys fail open to required.
test('auxiliary outcome: affiliate query-key families classify deterministically', () => {
  for (const key of [
    'referralCode',
    'referral_code',
    'referralId',
    'aff_id',
    'affiliateCode',
    'partnerId',
    'partner_code',
    'campaignId',
    'campaignCode',
    'promoCode',
    'promo_id',
    'couponCode',
    'couponId',
    'promo-code',
    'partner-id',
    'ref',
    'REF',
  ]) {
    assert.equal(
      isAuxiliaryForOutcome(`https://creator.example.com/guide?${key}=BRANDON`),
      true,
      `${key} must classify auxiliary`,
    );
  }
  for (const key of ['id', 'code', 'cid', 'sid', 'utm_source', 'fbclid', 'sessionId', 'page']) {
    assert.equal(
      isAuxiliaryForOutcome(`https://creator.example.com/guide?${key}=BRANDON`),
      false,
      `${key} must fail open to required`,
    );
  }
});

// 19. referralCode end to end: genuinely retryable failure, no channel ownership.
test('auxiliary outcome: referralCode failure cannot own the outcome', async () => {
  const refUrl = 'https://creator.example.com/guide?referralCode=BRANDON';
  assert.equal(isAuxiliaryForOutcome(refUrl), true);
  const { result } = await inspect(
    [...relevant5.slice(0, 2), refUrl],
    (async (input) => {
      if (String(input).includes('referralCode=')) return httpError(500)(input);
      return noInviteHtml();
    }) as typeof fetch,
    (async (seedUrl: string): Promise<BrowserFallbackResult> => {
      if (seedUrl.includes('referralCode=')) return timeoutRendered(seedUrl);
      return emptyRendered(seedUrl);
    }) as typeof emptyRendered,
  );
  assert.equal(result.acquisitionStatus, 'INSPECTED_NO_MATCH');
  assert.equal(result.retryDirective, undefined);
  const auxRows = (result.acquisitionOutcomes || []).filter((item) =>
    item.requestedUrl.includes('referralCode='),
  );
  assert.ok(auxRows.length > 0, 'auxiliary telemetry must be retained');
  assert.equal(hasRetryableCommunityAcquisitionFailure(auxRows as never), false);
});

// 20. Retry and outcome share one URL-precedence rule: the fetched resource
// (requestedUrl) wins over seed provenance (rootUrl) on both paths.
test('auxiliary outcome: retry and outcome use identical URL precedence', () => {
  const auxRequested = {
    rootUrl: 'https://creator.example.com/guide',
    requestedUrl: 'https://investing-referral.com/x',
  };
  assert.equal(acquisitionOwnershipUrl(auxRequested), 'https://investing-referral.com/x');
  assert.equal(isCommunityRelevantObservation(auxRequested as never), false);
  assert.equal(
    isCommunityRetryableObservation({
      ...auxRequested,
      surface: 'CREATOR_WEBSITES',
      required: true,
      outcome: 'ACQUISITION_FAILED',
      retryable: true,
    } as never),
    false,
    'retry must agree with outcome: requested-auxiliary owns neither',
  );
  const relevantRequested = {
    rootUrl: 'https://investing-referral.com/x',
    requestedUrl: 'https://creator.example.com/guide',
  };
  assert.equal(acquisitionOwnershipUrl(relevantRequested), 'https://creator.example.com/guide');
  assert.equal(isCommunityRelevantObservation(relevantRequested as never), true);
  assert.equal(
    isCommunityRetryableObservation({
      ...relevantRequested,
      surface: 'CREATOR_WEBSITES',
      required: true,
      outcome: 'ACQUISITION_FAILED',
      retryable: true,
    } as never),
    true,
    'retry must agree with outcome: requested-relevant stays retryable',
  );
});

// 21. Auxiliary URL skipped by the repeat-failure cap cannot manufacture
// PARTIAL: skip telemetry is logged, but Step 4 and final status stay clean.
test('auxiliary outcome: auxiliary-only repeat skip resolves clean', async () => {
  const auxUrl = 'https://investing-referral.com/skip-me';
  const { result } = await inspect(
    [auxUrl],
    (async () => {
      throw new Error('must not fetch skipped auxiliary URL');
    }) as typeof fetch,
    emptyRendered,
    (async () => cappedHistoryFor(auxUrl)) as never,
  );
  assert.ok(
    !(result.acquisitionOutcomes || []).some((item) => item.requestedUrl === auxUrl),
    'skipped URL must not produce failure observations',
  );
  assert.equal(result.steps.find((step) => step.step === 'CUSTOM_DOMAINS')?.status, 'NOT_FOUND');
  assert.equal(result.acquisitionStatus, 'INSPECTED_NO_MATCH');
  assert.equal(result.retryDirective, undefined);
});

// 22. Relevant URL skipped by the repeat-failure cap keeps uncertainty:
// the PARTIAL contract for genuinely uninspected community surfaces is intact.
test('auxiliary outcome: relevant repeat skip keeps uncertainty', async () => {
  const deadUrl = 'https://dead.example/';
  const { result } = await inspect(
    [deadUrl],
    (async () => {
      throw new Error('must not fetch skipped URL');
    }) as typeof fetch,
    emptyRendered,
    (async () => cappedHistoryFor(deadUrl)) as never,
  );
  assert.equal(result.steps.find((step) => step.step === 'CUSTOM_DOMAINS')?.status, 'PARTIAL');
  assert.equal(result.acquisitionStatus, 'PARTIALLY_INSPECTED');
});

// 23. Genuine relevant HTTP 500 + failed rendered fallback owns channel retry
// (control for the non-vacuous auxiliary test above).
test('auxiliary outcome: relevant HTTP 500 with failed fallback owns channel retry', async () => {
  const { result } = await inspect(
    [...relevant5.slice(0, 2), 'https://flaky.example.com/'],
    (async (input) => {
      if (String(input).includes('flaky.example.com')) return httpError(500)(input);
      return noInviteHtml();
    }) as typeof fetch,
    (async (seedUrl: string): Promise<BrowserFallbackResult> => {
      if (seedUrl.includes('flaky.example.com')) return timeoutRendered(seedUrl);
      return emptyRendered(seedUrl);
    }) as typeof emptyRendered,
  );
  const relRows = (result.acquisitionOutcomes || []).filter((item) =>
    item.requestedUrl.includes('flaky.example.com'),
  );
  assert.ok(
    relRows.some((item) => item.outcome === 'ACQUISITION_FAILED' && item.retryable),
    'control fixture must hold a genuinely retryable relevant failure',
  );
  assert.ok(result.retryDirective, 'relevant failure must own channel retry');
  assert.equal(result.retryDirective?.retryReason, 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE');
});

// 24. Effective Step-4 summary excludes auxiliary ownership while the raw
// ledger retains it: clean relevant pages + auxiliary 500 → raw summary
// still counts the failure, effective summary and step status stay clean.
test('auxiliary outcome: effective Step-4 summary never contradicts the final outcome', async () => {
  const { result } = await inspect(
    [...relevant5.slice(0, 2), 'https://investing-referral.com/elliottwaver'],
    (async (input) => {
      if (String(input).includes('investing-referral.com')) return httpError(500)(input);
      return noInviteHtml();
    }) as typeof fetch,
    (async (seedUrl: string): Promise<BrowserFallbackResult> => {
      if (seedUrl.includes('investing-referral.com')) return timeoutRendered(seedUrl);
      return emptyRendered(seedUrl);
    }) as typeof emptyRendered,
  );
  const raw = summarizeLinkedWebsiteAcquisition((result.acquisitionOutcomes || []) as never);
  const effective = summarizeEffectiveLinkedWebsiteAcquisition((result.acquisitionOutcomes || []) as never);
  assert.ok(raw.retryableFailures > 0, 'raw telemetry must retain the auxiliary failure');
  assert.equal(effective.retryableFailures, 0, 'effective summary must exclude auxiliary ownership');
  assert.equal(effective.renderedFailed, 0);
  const step = result.steps.find((s) => s.step === 'CUSTOM_DOMAINS');
  assert.equal(step?.status, 'NOT_FOUND');
  assert.ok(
    JSON.stringify(step).includes('2 unique website URL(s)'),
    'step text must count the effective set (auxiliary excluded), not the raw ledger',
  );
  assert.ok(
    JSON.stringify(step).includes('0 retryable failure(s)'),
    'step text must show zero effective retryable failures despite the raw auxiliary failure',
  );
  assert.equal(result.acquisitionStatus, 'INSPECTED_NO_MATCH');
});

// 25. R6 admission intact: legitimate, trading-evidence, and messaging URLs
// admitted; malformed, asset, and infrastructure URLs rejected.
test('auxiliary outcome: existing R6 admission behavior remains intact', () => {
  for (const raw of [
    'https://creator.example.com/',
    'https://creator.example.com/day-trading-guide',
    'https://www.amazon.com/Gambler-Trader/dp/B0GVMN5ZNL',
    'https://t.me/tradingroom',
    'https://creator.example.com/?ref=BRANDON',
    'https://creator.example.com/guide?referralCode=BRANDON',
  ]) {
    assert.ok(normalizeExternalUrl(raw), `must admit: ${raw}`);
  }
  for (const raw of [
    'https://g/',
    'https://i.ytimg.com/vi/abc/hqdefault.jpg',
    'http://schema.org/Person',
    'https://creator.example.com/app.css.map',
  ]) {
    assert.equal(normalizeExternalUrl(raw), null, `must reject: ${raw}`);
  }
});

// 26. Query VALUE containing an affiliate-looking path does not demote a
// genuine creator URL: `?next=/referral` is navigation state, not affiliate
// function. The pathname-only AFFILIATE_HINT evaluation must ignore it,
// and `next` is not an affiliate query-key family member.
test('auxiliary outcome: affiliate-looking query value never demotes a creator URL', () => {
  assert.equal(
    isAuxiliaryForOutcome('https://creator.example.com/?next=/referral'),
    false,
    '?next=/referral must stay community-relevant',
  );
  assert.equal(
    isCommunityRelevantObservation({ requestedUrl: 'https://creator.example.com/?next=/referral' }),
    true,
  );
});

// 27. Query VALUE containing a transaction-looking URL does not demote a
// genuine creator URL: `?return=https://other.example/order` classifies the
// creator URL, not the referenced target. Pathname-only transaction
// evaluation must ignore it.
test('auxiliary outcome: transaction-looking query value never demotes a creator URL', () => {
  assert.equal(
    isAuxiliaryForOutcome('https://creator.example.com/?return=https://other.example/order'),
    false,
    '?return=.../order must stay community-relevant',
  );
  assert.equal(
    isCommunityRelevantObservation({
      requestedUrl: 'https://creator.example.com/?return=https://other.example/order',
    }),
    true,
  );
});

// 28. Genuine affiliate pathnames remain auxiliary (path-only detection intact).
test('auxiliary outcome: genuine affiliate pathnames stay auxiliary', () => {
  for (const path of ['/referral', '/referral/', '/affiliate', '/partner', '/promo', '/coupon']) {
    assert.equal(
      isAuxiliaryForOutcome(`https://creator.example.com${path}`),
      true,
      `${path} must classify auxiliary`,
    );
  }
});

// 29. Genuine transaction pathnames remain auxiliary (path-only detection intact).
test('auxiliary outcome: genuine transaction pathnames stay auxiliary', () => {
  for (const path of [
    '/checkout',
    '/cart',
    '/shop',
    '/product',
    '/products',
    '/buy',
    '/buy-now',
    '/purchase',
    '/order',
  ]) {
    assert.equal(
      isAuxiliaryForOutcome(`https://creator.example.com${path}`),
      true,
      `${path} must classify auxiliary`,
    );
  }
});

// 30. Affiliate query-key parameters remain auxiliary (parsed-key detection
// intact after the pathname-only AFFILIATE_HINT change).
test('auxiliary outcome: affiliate query parameters stay auxiliary', () => {
  for (const query of ['ref=x', 'referralCode=BRANDON', 'affiliateId=1', 'partner_id=2']) {
    assert.equal(
      isAuxiliaryForOutcome(`https://creator.example.com/guide?${query}`),
      true,
      `?${query} must classify auxiliary`,
    );
  }
});

// 31. Arbitrary/unknown query keys still fail open to required.
test('auxiliary outcome: unknown query keys still fail open', () => {
  for (const query of ['next=/referral', 'return=https://other.example/order', 'sessionId=abc', 'page=2']) {
    assert.equal(
      isAuxiliaryForOutcome(`https://creator.example.com/guide?${query}`),
      false,
      `?${query} must fail open to required`,
    );
  }
});
