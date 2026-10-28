import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import initSqlJs from 'sql.js';
import {
  partitionRenderedClickTargets,
  isSkippableNavigableAnchorClick,
  discoverRequiredSeedLinks,
  normalizeVisitUrl,
  visitIdentityKeys,
  classifyRequiredCoverage,
  resolveRenderedCompletionState,
} from './browserCommunityFallback';
import { hasConsecutiveTimeoutExhaustion } from './crawlUrlSkipPolicy';
import { communityAcquisitionRetryDirective } from './communityRetryPolicy';
import {
  shouldScheduleFoundGapAcquisitionRetry,
  shouldCompleteSuppressedRetryJob,
  enqueueCommunityAcquisitionRetry,
  projectNotFoundAfterInspection,
} from './queueManager';
import { buildSharedStaticRootRecord, crawlExternalLinks as crawlExternalLinksImpl, runChannelInspection as runChannelInspectionImpl, isReusableStaticRootLender } from './inspector';
import { crawlExternalLinksForTest as crawlExternalLinks, runChannelInspectionForTest as runChannelInspection } from './testCrawlHelpers';
import type { BrowserFallbackResult } from './browserCommunityFallback';

const PAGE = 'https://creator.example.com/guide';
const anchor = (index: number, href: string) => ({ index, text: `community ${href}`, href });
const button = (index: number) => ({ index, text: 'join VIP group', href: null });

// Traversal partition: same-host navigable anchors skip clicks (discoverable
// via enqueueLinks, text retained pre-click); everything else keeps clicks.
test('v2: same-host navigable anchors skip clicks, buttons do not', () => {
  assert.equal(isSkippableNavigableAnchorClick({ href: '/community' }, PAGE), true);
  assert.equal(isSkippableNavigableAnchorClick({ href: 'https://creator.example.com/join' }, PAGE), true);
  assert.equal(isSkippableNavigableAnchorClick({ href: null }, PAGE), false);
  assert.equal(isSkippableNavigableAnchorClick({ href: '' }, PAGE), false);
  assert.equal(isSkippableNavigableAnchorClick({ href: '#section' }, PAGE), false);
  assert.equal(isSkippableNavigableAnchorClick({ href: 'javascript:void(0)' }, PAGE), false);
  assert.equal(isSkippableNavigableAnchorClick({ href: 'mailto:a@b.com' }, PAGE), false);
  assert.equal(isSkippableNavigableAnchorClick({ href: 'https://other.example.net/join' }, PAGE), false);
  assert.equal(isSkippableNavigableAnchorClick({ href: 'http://exa mple.com/' }, PAGE), false);
});

test('v2: mixed ordering reaches buttons past skipped anchors with indexes intact', () => {
  const controls = [anchor(0, '/community-1'), anchor(1, '/community-2'), anchor(2, '/community-3'), anchor(3, '/community-4'), anchor(4, '/community-5'), button(5), button(6)];
  const plan = partitionRenderedClickTargets(controls, PAGE, 4);
  assert.deepEqual(plan.toClick.map((c) => c.index), [5, 6]);
  assert.equal(plan.skippedNavigableAnchors, 5);
});

test('v2: required-set discovery uses the enqueue predicate exactly', () => {
  const links = discoverRequiredSeedLinks(
    '<a href="/community">c</a><a href="/about">a</a><a href="https://other.example.net/join">x</a><a href="/logo.png">i</a>',
    PAGE,
  );
  assert.ok(links.includes('https://creator.example.com/community'));
  assert.ok(!links.some((url) => url.includes('other.example.net')));
  assert.ok(!links.some((url) => url.includes('logo.png')));
  assert.equal(normalizeVisitUrl('https://Example.COM/a/'), 'https://example.com/a');
  assert.equal(normalizeVisitUrl('not a url'), null);
});

// P1.5: static link resolution honors the document's first <base href>, so a
// relative community link is discovered where the page actually points.
test('v2: required-set discovery resolves relative hrefs against <base href>', () => {
  const links = discoverRequiredSeedLinks(
    '<base href="/community/"><a href="join">join the community</a>',
    PAGE,
  );
  assert.deepEqual(links, ['https://creator.example.com/community/join']);
});

// P1.5: a cross-host base makes relative links resolve off-host; they cannot
// become same-host required obligations, while absolute same-host links still
// work.
test('v2: cross-host <base href> cannot create same-host required links', () => {
  const links = discoverRequiredSeedLinks(
    '<base href="https://cdn.example.net/community/"><a href="join">join the community</a><a href="https://creator.example.com/community">c</a>',
    PAGE,
  );
  assert.deepEqual(links, ['https://creator.example.com/community']);
});

// Seed fan-out: bare/www duplicates collapse; distinct coverage never merges.
const html = (body: string) =>
  new Response(`<html><body>${body}</body></html>`, { status: 200, headers: { 'content-type': 'text/html' } });
const noInviteHtml = async () => html('No Discord invite here');
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
const fillers = ['one', 'two', 'three', 'four', 'five'];

// Isolated stores: no test may depend on ambient database state or test
// ordering. Every inspection below runs against fresh in-memory
// coverage/history unless the test explicitly provides its own rows.
const makeIsolatedStore = () => ({
  read: async () => [],
  write: async () => {},
  recordLinks: async () => {},
});

async function inspectLinks(channelLinks: string[], overrides: Record<string, unknown> = {}) {
  const fetched: string[] = [];
  const result = await runChannelInspection({
    channelId: `v2-${Math.random().toString(36).slice(2)}`,
    channelName: 'V2 Channel',
    channelBio: 'Trading notes',
    channelLinks,
    videoDescriptions: fillers,
    creatorLikelyTrading: false,
    externalFetchImpl: (async (input) => {
      fetched.push(String(input));
      return noInviteHtml();
    }) as typeof fetch,
    renderedFallback: emptyRendered,
    urlFailureHistoryLoader: (async () => []) as never,
    siteInspectionStore: makeIsolatedStore(),
    ...(overrides as Record<string, unknown>),
  } as never);
  return { fetched, result };
}

test('v2: bare/www duplicate seeds share one crawl', async () => {
  const { fetched, result } = await inspectLinks(['http://asenna.com.au/', 'http://www.asenna.com.au/']);
  assert.equal(fetched.filter((url) => url.includes('asenna.com.au')).length, 1);
  assert.ok(JSON.stringify(result.steps || []).includes('Seed deduplicated (BARE_WWW_DUPLICATE)'));
});

test('v2: distinct same-host paths and tenants keep independent crawls', async () => {
  const paths = ['/downloads', '/free-trial', '/system-requirement'];
  const { fetched } = await inspectLinks(paths.map((p) => `https://volfix.example.com${p}`));
  for (const p of paths) assert.ok(fetched.some((url) => url.includes(p)));
  const tenants = await inspectLinks(['https://www.skool.com/manrewired', 'https://www.skool.com/freedomalgo']);
  assert.ok(tenants.fetched.some((url) => url.includes('manrewired')));
  assert.ok(tenants.fetched.some((url) => url.includes('freedomalgo')));
  const queries = await inspectLinks(['https://creator.example.com/guide?a=1', 'https://creator.example.com/guide?a=2']);
  assert.ok(queries.fetched.some((url) => url.includes('a=1')));
  assert.ok(queries.fetched.some((url) => url.includes('a=2')));
});

test('v2: multiple invite URLs on one site are all retained', async () => {
  const result = await runChannelInspection({
    channelId: 'v2-multi-invite',
    channelName: 'Multi Invite Channel',
    channelBio: 'Trading notes',
    siteInspectionStore: makeIsolatedStore(),
    channelLinks: ['https://creator.example.com/vip', 'https://creator.example.com/free'],
    videoDescriptions: fillers,
    creatorLikelyTrading: false,
    externalFetchImpl: (async (input) => {
      const url = String(input);
      if (url.includes('/vip')) return html('Join https://discord.gg/vip-room');
      if (url.includes('/free')) return html('Join https://discord.gg/free-room');
      return noInviteHtml();
    }) as typeof fetch,
    renderedFallback: emptyRendered,
  });
  const codes = (result.discordCandidates || []).map((c) => c.nativeInviteCode);
  assert.ok(codes.includes('vip-room') && codes.includes('free-room'));
});

// Completion contract: timeout with healthy pages stays incomplete and
// retryable; drained clean coverage completes; terminal failure fails.
test('v2: completion contract distinguishes timeout, drain, and terminal failure', () => {
  const skool = resolveRenderedCompletionState({ inspectedPages: 4, timedOut: true, telemetry: { requestsStarted: 4 } as never });
  assert.equal(skool.complete, false);
  assert.equal(skool.retryable, true);
  const drained = resolveRenderedCompletionState({ inspectedPages: 6, timedOut: false, telemetry: {} as never });
  assert.equal(drained.complete, true);
  const terminal = resolveRenderedCompletionState({
    inspectedPages: 2,
    timedOut: false,
    telemetry: { unresolvedFailedRequests: 1 } as never,
  });
  assert.equal(terminal.complete, false);
});

// REQUIRED_UNVISITED_BUDGET_GAP: first-class, bounded, tail-suppressed.
const timeoutRenderedWithGap = (gap: Record<string, string[]>) => async (seedUrl: string): Promise<BrowserFallbackResult> => ({
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
  visitedUrls: [seedUrl],
  requiredTotal: 3,
  requiredUnvisited: gap.unvisited || [],
  requiredTransientFailures: gap.transient || [],
  requiredPermanentFailures: gap.permanent || [],
});

test('v2: required-unvisited budget gap owns bounded recovery without hiding status', async () => {
  const result = await runChannelInspection({
    channelId: 'v2-budget-gap',
    channelName: 'Budget Gap Channel',
    channelBio: 'Trading notes',
    siteInspectionStore: makeIsolatedStore(),
    channelLinks: ['https://gap.example.com/'],
    videoDescriptions: fillers,
    creatorLikelyTrading: true,
    externalFetchImpl: (async () => {
      throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    }) as typeof fetch,
    renderedFallback: timeoutRenderedWithGap({ unvisited: ['https://gap.example.com/community'] }),
    urlFailureHistoryLoader: (async () => []) as never,
  });
  assert.equal(result.acquisitionStatus, 'PARTIALLY_INSPECTED');
  const gapObs = (result.acquisitionOutcomes || []).find(
    (item) => item.requestedUrl === 'https://gap.example.com/' && item.failureClass === 'REQUIRED_UNVISITED_BUDGET_GAP',
  );
  assert.ok(gapObs, 'budget gap must be an explicit failure class');
  assert.ok(result.retryDirective, 'first budget gap owns bounded recovery');
  assert.equal(result.retryDirective?.retryReason, 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE');
});

test('v2: deterministic budget-gap tail stops re-owning retries visibly', async () => {
  const history = [4, 3].map((day) => ({
    requestedUrl: 'https://gap.example.com/',
    failureClass: 'REQUIRED_UNVISITED_BUDGET_GAP',
    outcome: 'PARTIALLY_INSPECTED',
    observedAt: new Date(Date.UTC(2026, 9, day, 12)).toISOString(),
  }));
  const result = await runChannelInspection({
    channelId: 'v2-budget-gap-tail',
    channelName: 'Budget Gap Tail Channel',
    channelBio: 'Trading notes',
    siteInspectionStore: makeIsolatedStore(),
    channelLinks: ['https://gap.example.com/'],
    videoDescriptions: fillers,
    creatorLikelyTrading: true,
    externalFetchImpl: (async () => {
      throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    }) as typeof fetch,
    renderedFallback: timeoutRenderedWithGap({ unvisited: ['https://gap.example.com/community'] }),
    urlFailureHistoryLoader: (async () => history) as never,
  });
  assert.equal(result.acquisitionStatus, 'PARTIALLY_INSPECTED');
  assert.equal(result.retryDirective, undefined);
  assert.deepEqual(result.retrySuppressedUrls, ['https://gap.example.com/']);
  assert.ok(JSON.stringify(result.steps || []).includes('Retry suppressed (consecutive identical budget/timeout tail)'));
});

// FOUND must never erase outstanding obligations: Invite A stays retained
// and displayed while Invite B's required gap keeps bounded recovery.
test('v2: FOUND with required gap retains invites and keeps bounded recovery', async () => {
  const fetched: string[] = [];
  const result = await runChannelInspection({
    channelId: 'v2-found-gap',
    channelName: 'Found Gap Channel',
    channelBio: 'Trading notes',
    siteInspectionStore: makeIsolatedStore(),
    channelLinks: ['https://creator.example.com/hub'],
    videoDescriptions: fillers,
    creatorLikelyTrading: true,
    externalFetchImpl: (async () => {
      throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    }) as typeof fetch,
    renderedFallback: (async (seedUrl: string): Promise<BrowserFallbackResult> => {
      fetched.push(seedUrl);
      return {
        foundInvite: 'room-a',
        foundLocation: seedUrl,
        candidates: [],
        inspectedPages: 2,
        scrolls: 0,
        clicks: 0,
        complete: false,
        retryable: true,
        timedOut: true,
        telemetry: undefined,
        detail: 'invite retained with required gap outstanding',
        visitedUrls: [seedUrl],
        requiredTotal: 2,
        requiredUnvisited: ['https://creator.example.com/community'],
      };
    }),
    urlFailureHistoryLoader: (async () => []) as never,
  });
  assert.equal(result.foundInvite, 'room-a');
  assert.equal(result.acquisitionStatus, 'FOUND');
  const foundObs = (result.acquisitionOutcomes || []).find(
    (item) => item.requestedUrl === 'https://creator.example.com/hub' && item.outcome === 'FOUND',
  );
  assert.ok(foundObs, 'FOUND observation recorded');
  assert.equal(foundObs?.failureClass, 'REQUIRED_UNVISITED_BUDGET_GAP');
  assert.equal(foundObs?.retryable, true);
  assert.ok(result.retryDirective, 'outstanding required gap keeps bounded recovery');
  const trail = JSON.stringify(result.steps || []);
  assert.ok(trail.includes('retained invite surface(s) still have outstanding required evidence'));
});

// Shared rendered evidence: a fully covered seed skips its browser run;
// static-only evidence never satisfies a rendered need (tier refusal).
test('v2: fully covered seeds reuse rendered evidence without refetch', async () => {
  const renderedCalls: string[] = [];
  const lenderHtml = '<a href="/shared">shared community hub</a>';
  const result = await runChannelInspection({
    channelId: 'v2-shared-rendered',
    channelName: 'Shared Rendered Channel',
    channelBio: 'Trading notes',
    siteInspectionStore: makeIsolatedStore(),
    channelLinks: ['https://share.example.com/', 'https://share.example.com/shared'],
    videoDescriptions: fillers,
    creatorLikelyTrading: true,
    externalFetchImpl: (async (input) => {
      const url = String(input);
      if (url === 'https://share.example.com/') return html(lenderHtml);
      return noInviteHtml();
    }) as typeof fetch,
    renderedFallback: (async (seedUrl: string): Promise<BrowserFallbackResult> => {
      renderedCalls.push(seedUrl);
      const visited = seedUrl === 'https://share.example.com/'
        ? ['https://share.example.com/', 'https://share.example.com/shared']
        : [seedUrl];
      return {
        foundInvite: null,
        foundLocation: seedUrl,
        candidates: [],
        inspectedPages: visited.length,
        scrolls: 0,
        clicks: 0,
        complete: true,
        retryable: false,
        timedOut: false,
        telemetry: undefined,
        detail: 'shared lender run',
        visitedUrls: visited,
        requiredTotal: visited.length,
        pageHintLinks: { 'https://share.example.com/': ['https://share.example.com/shared'] },
      };
    }),
    urlFailureHistoryLoader: (async () => []) as never,
  });
  assert.ok(renderedCalls.includes('https://share.example.com/'));
  assert.ok(!renderedCalls.includes('https://share.example.com/shared'), 'covered seed must not launch a second browser run');
  assert.ok(JSON.stringify(result.steps || []).includes('[Shared evidence] https://share.example.com/shared reuses rendered inspection'));
});

// Consecutive-tail helper covers budget-gap tails identically to timeouts.
test('v2: Skool-shaped healthy timeout with required coverage resolves sufficient', async () => {
  const result = await runChannelInspection({
    channelId: 'v2-skool-sufficient',
    channelName: 'Skool Sufficient Channel',
    channelBio: 'Trading notes',
    siteInspectionStore: makeIsolatedStore(),
    channelLinks: ['https://skool.example.com/freedomalgo'],
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
      scrolls: 4,
      clicks: 16,
      complete: false,
      retryable: true,
      timedOut: true,
      telemetry: undefined,
      detail: 'Rendered acquisition budget expired before coverage completed',
      visitedUrls: [seedUrl],
      requiredTotal: 4,
    })),
    urlFailureHistoryLoader: (async () => []) as never,
  });
  const cleanObs = (result.acquisitionOutcomes || []).find(
    (item) => item.requestedUrl === 'https://skool.example.com/freedomalgo' && item.outcome === 'INSPECTED_NO_MATCH',
  );
  assert.ok(cleanObs, 'required-covered timeout must resolve clean, not partial');
  assert.equal(result.retryDirective, undefined);
  assert.equal(result.steps.find((step) => step.step === 'CUSTOM_DOMAINS')?.status, 'NOT_FOUND');
});

test('v2: consecutive budget-gap tails suppress like timeout tails', () => {
  const rows = (cls: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      requestedUrl: 'https://gap.example.com/',
      failureClass: cls,
      outcome: 'PARTIALLY_INSPECTED',
      observedAt: new Date(Date.UTC(2026, 9, 4 - i, 12)).toISOString(),
    }));
  assert.equal(
    hasConsecutiveTimeoutExhaustion(rows('REQUIRED_UNVISITED_BUDGET_GAP', 2), 'https://gap.example.com/', 2, ['RENDERED_TIMEOUT', 'REQUIRED_UNVISITED_BUDGET_GAP']),
    true,
  );
  assert.equal(
    communityAcquisitionRetryDirective(
      [
        {
          requestedUrl: 'https://gap.example.com/',
          surface: 'CREATOR_WEBSITES',
          required: true,
          outcome: 'PARTIALLY_INSPECTED',
          retryable: true,
          failureClass: 'REQUIRED_UNVISITED_BUDGET_GAP',
        },
      ] as never,
      ['https://gap.example.com/'],
    ),
    undefined,
  );
});

// REVIEW: redirect-safe visit identities keep closure correct.
test('v2 review: visit identities unify request and final page evidence', () => {
  assert.deepEqual(visitIdentityKeys('https://redir.example.com/go', 'https://redir.example.com/go'), [
    'https://redir.example.com/go',
  ]);
  assert.deepEqual(visitIdentityKeys('https://redir.example.com/go', 'https://redir.example.com/landing'), [
    'https://redir.example.com/go',
    'https://redir.example.com/landing',
  ]);
  assert.ok(visitIdentityKeys('', '').length === 0);
});

// REVIEW: shared-covered members satisfy required items; fresh terminal
// failures always win over borrowed success.
test('v2 review: coverage classifier honors shared evidence without hiding fresh failures', () => {
  const base = {
    requiredKeys: ['https://x.example/a', 'https://x.example/b', 'https://x.example/c'],
    succeededKeys: ['https://x.example/a'],
    failedClassesByKey: new Map(),
  };
  assert.deepEqual(classifyRequiredCoverage({ ...base, sharedCoveredKeys: ['https://x.example/b'] }), {
    unvisited: ['https://x.example/c'],
    transientFailures: [],
    permanentFailures: [],
  });
  assert.deepEqual(
    classifyRequiredCoverage({
      ...base,
      sharedCoveredKeys: ['https://x.example/b'],
      failedClassesByKey: new Map([['https://x.example/b', 'TRANSIENT']]),
    }),
    {
      unvisited: ['https://x.example/c'],
      transientFailures: ['https://x.example/b'],
      permanentFailures: [],
    },
  );
  assert.deepEqual(
    classifyRequiredCoverage({
      ...base,
      failedClassesByKey: new Map([['https://x.example/b', 'BLOCKED']]),
    }).permanentFailures,
    ['https://x.example/b'],
  );
});

// REVIEW: required BLOCKED-only failure is visible but never retryable.
test('v2 review: required permanent failure owns no retry', async () => {
  const result = await runChannelInspection({
    channelId: 'v2-blocked-permanent',
    channelName: 'Blocked Permanent Channel',
    channelBio: 'Trading notes',
    siteInspectionStore: makeIsolatedStore(),
    channelLinks: ['https://blocked.example.com/'],
    videoDescriptions: fillers,
    creatorLikelyTrading: true,
    externalFetchImpl: (async () => {
      throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    }) as typeof fetch,
    renderedFallback: (async (seedUrl: string): Promise<BrowserFallbackResult> => ({
      foundInvite: null,
      foundLocation: seedUrl,
      candidates: [],
      inspectedPages: 1,
      scrolls: 0,
      clicks: 0,
      complete: false,
      retryable: true,
      timedOut: false,
      telemetry: undefined,
      detail: 'walled garden',
      visitedUrls: [seedUrl],
      requiredTotal: 1,
      requiredPermanentFailures: [seedUrl],
    })),
    urlFailureHistoryLoader: (async () => []) as never,
  });
  assert.notEqual(result.acquisitionStatus, 'INSPECTED_NO_MATCH');
  const permObs = (result.acquisitionOutcomes || []).find(
    (item) => item.requestedUrl === 'https://blocked.example.com/' && item.required === true,
  );
  assert.ok(permObs, 'permanent required failure stays visible');
  assert.equal(permObs?.retryable, false);
  assert.equal(result.retryDirective, undefined);
});

// REVIEW: FOUND rows carrying gap classes accumulate tails; plain FOUND breaks them.
test('v2 review: FOUND+gap history accumulates, plain FOUND breaks the tail', () => {
  const at = (day: number) => new Date(Date.UTC(2026, 9, day, 12)).toISOString();
  const gapRow = (day: number) => ({
    requestedUrl: 'https://gap.example.com/',
    failureClass: 'REQUIRED_UNVISITED_BUDGET_GAP',
    outcome: 'FOUND',
    observedAt: at(day),
  });
  assert.equal(
    hasConsecutiveTimeoutExhaustion(
      [gapRow(4), gapRow(3)],
      'https://gap.example.com/',
      2,
      ['RENDERED_TIMEOUT', 'REQUIRED_UNVISITED_BUDGET_GAP'],
    ),
    true,
  );
  const brokenByCleanFound = [
    gapRow(4),
    {
      requestedUrl: 'https://gap.example.com/',
      failureClass: null,
      outcome: 'FOUND',
      observedAt: at(3),
    },
    gapRow(2),
  ];
  assert.equal(
    hasConsecutiveTimeoutExhaustion(brokenByCleanFound, 'https://gap.example.com/', 2, [
      'RENDERED_TIMEOUT',
      'REQUIRED_UNVISITED_BUDGET_GAP',
    ]),
    false,
  );
});

// REVIEW: tail ordering uses acquisition-attempt order — a static companion
// sharing an exact acquisition timestamp never breaks a genuine rendered
// tail, while drift at any other timestamp still breaks it.
test('v2 review: static companions do not break rendered tails, drift does', () => {
  const stamp = new Date(Date.UTC(2026, 9, 4, 12)).toISOString();
  const older = new Date(Date.UTC(2026, 9, 3, 12)).toISOString();
  const companion = [
    { requestedUrl: 'https://tail.example.com/', failureClass: 'TIMEOUT', outcome: 'ACQUISITION_FAILED', observedAt: stamp },
    { requestedUrl: 'https://tail.example.com/', failureClass: 'RENDERED_TIMEOUT', outcome: 'PARTIALLY_INSPECTED', observedAt: stamp },
    { requestedUrl: 'https://tail.example.com/', failureClass: 'RENDERED_TIMEOUT', outcome: 'PARTIALLY_INSPECTED', observedAt: older },
  ];
  assert.equal(hasConsecutiveTimeoutExhaustion(companion, 'https://tail.example.com/'), true);
  const drifted = [
    { requestedUrl: 'https://tail.example.com/', failureClass: 'RENDERED_TIMEOUT', outcome: 'PARTIALLY_INSPECTED', observedAt: stamp },
    { requestedUrl: 'https://tail.example.com/', failureClass: 'HTTP_ERROR', outcome: 'ACQUISITION_FAILED', observedAt: older },
  ];
  assert.equal(hasConsecutiveTimeoutExhaustion(drifted, 'https://tail.example.com/'), false);
});

// REVIEW: static L1 root-share avoids the duplicate root fetch while the
// borrower still acquires its own children; rendered needs never consult it.
test('v2 review: shared static roots skip refetch but still acquire children', async () => {
  const rootHtml = '<a href="/community-page">community page</a>';
  const lenderFetched: string[] = [];
  const lender = await crawlExternalLinks(
    ['https://dup.example.com/'],
    [],
    undefined,
    (async (input) => {
      lenderFetched.push(String(input));
      const url = String(input);
      if (url === 'https://dup.example.com/') return html(rootHtml);
      return noInviteHtml();
    }) as typeof fetch,
  );
  assert.ok(lender.rootNavigation?.some((item) => item.url === 'https://dup.example.com/community-page'));
  const rootKey = normalizeVisitUrl('https://dup.example.com/');
  assert.ok(rootKey);
  // Lender discovered the child but only terminally inspected the root
  // itself: the borrower must skip the duplicate root fetch yet still
  // acquire the undiscovered child on its own.
  const inventory = {
    visitedKeys: ['https://dup.example.com/'],
    roots: new Map([
      [rootKey as string, { bySeed: 'https://dup.example.com/', finalUrl: 'https://dup.example.com/', childLinks: lender.rootNavigation || [], terminalSuccess: true }],
    ]),
  };
  const borrowerFetched: string[] = [];
  const borrowerLog: string[] = [];
  const borrower = await crawlExternalLinks(
    ['https://dup.example.com/'],
    borrowerLog,
    undefined,
    (async (input) => {
      borrowerFetched.push(String(input));
      return noInviteHtml();
    }) as typeof fetch,
    'CREATOR_WEBSITES',
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    inventory,
  );
  assert.ok(!borrowerFetched.includes('https://dup.example.com/'), 'shared root must not be refetched');
  assert.ok(
    borrowerFetched.includes('https://dup.example.com/community-page'),
    'borrower still acquires its own children',
  );
  assert.ok(borrowerLog.some((line) => line.includes('[Shared static evidence]')));
  // Exactly one per-seed record for the shared root: the seed rollup carries
  // the lender attribution (no duplicate upfront row) with borrower-own page
  // accounting (no pagesInspected inflation for lender bytes).
  const rootRows = borrower.observations.filter((item) => item.requestedUrl === 'https://dup.example.com/');
  assert.equal(rootRows.length, 1);
  assert.equal(rootRows[0].sharedEvidenceFrom, 'https://dup.example.com/');
  assert.equal(rootRows[0].telemetry?.pagesInspected, 1);
});

// P1.5: static navigation must resolve anchors against the document's
// <base href>, not just the response URL, or a relative invite page is never
// scanned.
test('v2 review: static crawl resolves anchors against the document base href', async () => {
  const fetched: string[] = [];
  const result = await crawlExternalLinks(
    ['https://base.example.com/guide'],
    [],
    undefined,
    (async (input) => {
      const url = String(input);
      fetched.push(url);
      if (url === 'https://base.example.com/guide') {
        return html('<base href="/community/"><a href="join">join the community</a>');
      }
      return noInviteHtml();
    }) as typeof fetch,
  );
  assert.ok(
    result.rootNavigation?.some((item) => item.url === 'https://base.example.com/community/join'),
    'root navigation resolves the relative join link against <base href>',
  );
  assert.ok(
    fetched.includes('https://base.example.com/community/join'),
    'the static crawler fetches the base-resolved invite page',
  );
});

test('v2 review: static crawl resolves dynamic targets against the document base href', async () => {
  const fetched: string[] = [];
  await crawlExternalLinks(
    ['https://base.example.com/guide'],
    [],
    undefined,
    (async (input) => {
      const url = String(input);
      fetched.push(url);
      if (url === 'https://base.example.com/guide') {
        return html('<base href="/community/"><div data-href="members">members area</div>');
      }
      return noInviteHtml();
    }) as typeof fetch,
  );
  assert.ok(
    fetched.includes('https://base.example.com/community/members'),
    'the static crawler fetches the base-resolved dynamic target',
  );
});

test('v2 review: base-button elements keep their dynamic community targets', async () => {
  const fetched: string[] = [];
  await crawlExternalLinks(
    ['https://base.example.com/guide'],
    [],
    undefined,
    (async (input) => {
      const url = String(input);
      fetched.push(url);
      if (url === 'https://base.example.com/guide') {
        return html('<base href="community/"><base-button data-href="members">members area</base-button>');
      }
      return noInviteHtml();
    }) as typeof fetch,
  );
  assert.ok(
    fetched.includes('https://base.example.com/community/members'),
    'a base-prefixed custom element is not mistaken for a base tag',
  );
});

test('v2 review: a button sharing the base value is not filtered out', async () => {
  const fetched: string[] = [];
  await crawlExternalLinks(
    ['https://base.example.com/guide'],
    [],
    undefined,
    (async (input) => {
      const url = String(input);
      fetched.push(url);
      if (url === 'https://base.example.com/guide') {
        return html('<base href="/community/"><button data-href="/community/">Join</button>');
      }
      return noInviteHtml();
    }) as typeof fetch,
  );
  assert.ok(
    fetched.includes('https://base.example.com/community/'),
    'removing the base element must not remove a real target with the same value',
  );
});

test('v2 review: base-resolved relative Discord anchor is retained without a navigation fetch', async () => {
  const fetched: string[] = [];
  const result = await crawlExternalLinks(
    ['https://base.example.com/guide'],
    [],
    undefined,
    (async (input) => {
      const url = String(input);
      fetched.push(url);
      if (url === 'https://base.example.com/guide') {
        return new Response(
          '<html><head><base href="https://discord.gg/"></head><body><a href="Abc123">join</a></body></html>',
          { status: 200, headers: { 'content-type': 'text/html' } },
        );
      }
      return new Response('forbidden', { status: 403 });
    }) as typeof fetch,
  );
  assert.equal(result.foundInvite, 'Abc123');
  assert.ok(result.candidates.some((candidate) => candidate.nativeInviteCode === 'Abc123'));
  assert.equal(
    fetched.includes('https://discord.gg/Abc123'),
    false,
    'the resolved invite is retained from the page, not fetched as navigation',
  );
});

test('v2 review: base-resolved relative dynamic Discord target is retained directly', async () => {
  const result = await crawlExternalLinks(
    ['https://base.example.com/guide'],
    [],
    undefined,
    (async (input) => {
      const url = String(input);
      if (url === 'https://base.example.com/guide') {
        return new Response(
          '<html><head><base href="https://discord.gg/"></head><body><div data-href="Dyn123">join</div></body></html>',
          { status: 200, headers: { 'content-type': 'text/html' } },
        );
      }
      return new Response('forbidden', { status: 403 });
    }) as typeof fetch,
  );
  assert.equal(result.foundInvite, 'Dyn123');
});

test('v2 review: dynamic-target scan does not queue the base href as a target', async () => {
  const fetched: string[] = [];
  await crawlExternalLinks(
    ['https://base.example.com/guide'],
    [],
    undefined,
    (async (input) => {
      const url = String(input);
      fetched.push(url);
      if (url === 'https://base.example.com/guide') {
        return html('<base href="community/"><div data-href="members">members area</div>');
      }
      return noInviteHtml();
    }) as typeof fetch,
  );
  assert.equal(
    fetched.includes('https://base.example.com/community/community/'),
    false,
    'the base element is a resolution rule, not a navigation target',
  );
  assert.ok(fetched.includes('https://base.example.com/community/members'));
});

test('v2 review: shared static root replay carries lender community intent to the borrower', async () => {
  const lenderIntent = {
    communityPlatform: 'WHOP' as const,
    communityUrl: 'https://www.whop.com/creator',
    intent: 'UNKNOWN' as const,
    paidSignals: [],
    privateSignals: [],
    observedAt: '2026-10-20T00:00:00.000Z',
    sourcePageUrl: 'https://intent.example.com/',
    extractionConfidence: 'EXPLICIT' as const,
  };
  const record = buildSharedStaticRootRecord('https://intent.example.com/', {
    outcome: 'INSPECTED_NO_MATCH',
    visitedUrls: ['https://intent.example.com/'],
    rootNavigation: [],
    communityIntent: [lenderIntent],
  });
  assert.ok(record, 'terminal-success lender record is built');
  const key = normalizeVisitUrl('https://intent.example.com/');
  assert.ok(key);
  const borrowerFetched: string[] = [];
  const borrower = await crawlExternalLinks(
    ['https://intent.example.com/'],
    [],
    undefined,
    (async (input) => {
      borrowerFetched.push(String(input));
      return noInviteHtml();
    }) as typeof fetch,
    'CREATOR_WEBSITES',
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { visitedKeys: ['https://intent.example.com/'], roots: new Map([[key as string, record]]) },
  );
  assert.equal(borrowerFetched.length, 0, 'the shared root is not refetched');
  assert.ok(
    borrower.communityIntent?.some(item => item.communityPlatform === 'WHOP' && item.intent === 'UNKNOWN'),
    'lender root community intent survives the borrow',
  );
});

// REVIEW: bare/www collapse is port-aware.
test('v2 review: collapse requires equal normalized ports', async () => {
  const samePort = await inspectLinks(['https://port.example.com:8443/a', 'https://www.port.example.com:8443/a']);
  assert.equal(samePort.fetched.filter((url) => url.includes('port.example.com')).length, 1);
  const diffPort = await inspectLinks(['https://port.example.com:8443/a', 'https://www.port.example.com/a']);
  assert.equal(diffPort.fetched.filter((url) => url.includes('port.example.com')).length, 2);
});

// REVIEW: HTML entities decode to the enqueue-visible identity.
test('v2 review: encoded href entities resolve to normalized identities', () => {
  assert.deepEqual(discoverRequiredSeedLinks('<a href="/community?x=1&amp;y=2">join us</a>', PAGE), [
    'https://creator.example.com/community?x=1&y=2',
  ]);
});

// REVIEW: scheduler decision helper for FOUND+gap acquisition recovery.
test('v2 review: scheduler helper targets FOUND+gap directives only', () => {
  const gapDirective = { retryReason: 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE' };
  assert.equal(
    shouldScheduleFoundGapAcquisitionRetry({
      acquisitionOutcomes: [
        { outcome: 'FOUND', retryable: true, failureClass: 'REQUIRED_UNVISITED_BUDGET_GAP' },
      ],
      retryDirective: gapDirective,
    }),
    true,
  );
  assert.equal(
    shouldScheduleFoundGapAcquisitionRetry({
      acquisitionOutcomes: [{ outcome: 'FOUND', retryable: false }],
      retryDirective: undefined,
    }),
    false,
  );
  assert.equal(
    shouldScheduleFoundGapAcquisitionRetry({
      acquisitionOutcomes: [{ outcome: 'FOUND', retryable: true, failureClass: 'REQUIRED_UNVISITED_BUDGET_GAP' }],
      retryDirective: undefined,
    }),
    false,
  );
  assert.equal(shouldScheduleFoundGapAcquisitionRetry(null), false);
});

// REVIEW: suppressed retry jobs complete instead of re-executing.
test('v2 review: suppressed retry ownership completes the job normally', () => {
  assert.equal(shouldCompleteSuppressedRetryJob({ retryDirective: undefined, retrySuppressedUrls: ['https://x.example/'] }, 'FAILED'), true);
  assert.equal(
    shouldCompleteSuppressedRetryJob({ retryDirective: undefined, retrySuppressedUrls: ['https://x.example/'] }, 'FAILED_PERMANENT'),
    true,
  );
  assert.equal(
    shouldCompleteSuppressedRetryJob({ retryDirective: { retryReason: 'X' }, retrySuppressedUrls: ['https://x.example/'] }, 'FAILED'),
    false,
  );
  assert.equal(shouldCompleteSuppressedRetryJob({ retryDirective: undefined, retrySuppressedUrls: [] }, 'FAILED'), false);
  assert.equal(
    shouldCompleteSuppressedRetryJob({ retryDirective: undefined, retrySuppressedUrls: ['https://x.example/'] }, 'COMPLETED'),
    false,
  );
});

// REVIEW: redirect-shared rendered evidence satisfies final-identity borrowers.
test('v2 review: redirect identities share rendered evidence correctly', async () => {
  const renderedCalls: string[] = [];
  const result = await runChannelInspection({
    channelId: 'v2-redirect-share',
    channelName: 'Redirect Share Channel',
    channelBio: 'Trading notes',
    siteInspectionStore: makeIsolatedStore(),
    channelLinks: ['https://redir.example.com/go', 'https://redir.example.com/landing'],
    videoDescriptions: fillers,
    creatorLikelyTrading: true,
    externalFetchImpl: (async () => noInviteHtml()) as typeof fetch,
    renderedFallback: (async (seedUrl: string): Promise<BrowserFallbackResult> => {
      renderedCalls.push(seedUrl);
      if (seedUrl === 'https://redir.example.com/go') {
        return {
          foundInvite: null,
          foundLocation: seedUrl,
          candidates: [],
          inspectedPages: 2,
          scrolls: 0,
          clicks: 0,
          complete: true,
          retryable: false,
          timedOut: false,
          telemetry: undefined,
          detail: 'lender with redirect',
          visitedUrls: ['https://redir.example.com/go', 'https://redir.example.com/landing'],
          requiredTotal: 2,
          pageHintLinks: {
            'https://redir.example.com/go': [],
            'https://redir.example.com/landing': [],
          },
        };
      }
      return {
        foundInvite: null,
        foundLocation: seedUrl,
        candidates: [],
        inspectedPages: 1,
        scrolls: 0,
        clicks: 0,
        complete: true,
        retryable: false,
        timedOut: false,
        telemetry: undefined,
        detail: 'must not run for covered borrower',
      };
    }),
    urlFailureHistoryLoader: (async () => []) as never,
  });
  assert.deepEqual(renderedCalls, ['https://redir.example.com/go']);
  assert.ok(
    JSON.stringify(result.steps || []).includes(
      '[Shared evidence] https://redir.example.com/landing reuses rendered inspection',
    ),
  );
});

// REVIEW: wiring contracts pinned at the call sites (repo source-assertion pattern).
test('v2 review: scheduler and worker wiring call sites are pinned', () => {
  const queue = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
  assert.match(queue, /shouldScheduleFoundGapAcquisitionRetry\(inspection\)/);
  assert.match(queue, /shouldCompleteSuppressedRetryJob\(inspectionResult,refreshed\?\.scan_status\)/);
  const fallback = readFileSync(new URL('./browserCommunityFallback.ts', import.meta.url), 'utf8');
  // Capture the original page's anchors before any control click can navigate
  // the document away; the post-click enqueue then covers JS-revealed links.
  const enqueuePos = fallback.indexOf("await enqueueLinks({ strategy: 'same-hostname'");
  const clickPos = fallback.indexOf('const clickLoop = await runRenderedClickLoop({');
  const postClickEnqueuePos = fallback.indexOf("await enqueueLinks({strategy:'same-hostname'", clickPos);
  assert.ok(enqueuePos !== -1 && clickPos !== -1 && enqueuePos < clickPos, 'anchors enqueue before navigating clicks');
  assert.ok(postClickEnqueuePos > clickPos, 'JS-revealed anchors enqueue after clicks');
});

// REVIEW e2e: a FOUND+required-gap inspection actually creates the durable
// acquisition retry job through the real enqueue path (sql.js-backed jobs
// table; only the transport is swapped — SQL, idempotency, metadata shape,
// and row assertions all execute for real).
test('v2 review e2e: FOUND+gap inspection creates the durable retry job', async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      type TEXT NOT NULL,
      payload TEXT,
      priority INTEGER DEFAULT 0,
      max_attempts INTEGER DEFAULT 3,
      run_after TEXT,
      idempotency_key TEXT UNIQUE,
      catalog_version_id TEXT,
      catalog_policy_version TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING',
      attempts INTEGER NOT NULL DEFAULT 0,
      locked_by TEXT,
      locked_at TEXT,
      last_error TEXT,
      completed_at TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      // This SQL.js fake exercises job creation, not PostgreSQL JSONB math.
      // The monotonic click-offset merge is covered by the real PostgreSQL
      // regression in communityRetryClickOffsets.postgres.test.ts.
      if (sql.includes('UPDATE jobs SET payload=CASE')) return { rows: [], rowCount: 1 };
      let processed = sql.replace(/::jsonb/gi, '').replace(/now\(\)/gi, `datetime('now')`);
      try {
        const stmt = db.prepare(processed);
        if (params && params.length) stmt.bind(params as never);
        const rows: Record<string, unknown>[] = [];
        while (stmt.step()) rows.push(stmt.getAsObject() as Record<string, unknown>);
        stmt.free();
        return { rows, rowCount: rows.length || db.getRowsModified() };
      } catch (err) {
        db.run(processed, params as never);
        return { rows: [], rowCount: db.getRowsModified() };
      }
    },
  };
  const channelId = 'UCe2efoundgap000000000001';
  const inspection = await runChannelInspection({
    channelId,
    channelName: 'E2E Found Gap Channel',
    channelBio: 'Trading notes',
    siteInspectionStore: makeIsolatedStore(),
    channelLinks: ['https://creator.example.com/hub'],
    videoDescriptions: fillers,
    creatorLikelyTrading: true,
    externalFetchImpl: (async () => {
      throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    }) as typeof fetch,
    renderedFallback: (async (seedUrl: string): Promise<BrowserFallbackResult> => ({
      foundInvite: 'room-a',
      foundLocation: seedUrl,
      candidates: [],
      inspectedPages: 2,
      scrolls: 0,
      clicks: 0,
      complete: false,
      retryable: true,
      timedOut: true,
      telemetry: undefined,
      detail: 'invite retained with required gap outstanding',
      visitedUrls: [seedUrl],
      requiredTotal: 2,
      requiredUnvisited: ['https://creator.example.com/community'],
    })),
    urlFailureHistoryLoader: (async () => []) as never,
  });
  assert.equal(inspection.foundInvite, 'room-a');
  assert.ok(inspection.retryDirective, 'FOUND+gap must own a retry directive');
  // Scheduler decision on the real inspection result.
  assert.equal(shouldScheduleFoundGapAcquisitionRetry(inspection), true);
  // Durable job creation through the real enqueue function.
  await enqueueCommunityAcquisitionRetry(channelId, inspection.retryDirective, 'INSPECTION', client as never);
  const check = db.prepare(`SELECT type, status, payload, idempotency_key FROM jobs WHERE idempotency_key = ?`);
  check.bind([`community-acquisition-retry:${channelId}`]);
  assert.ok(check.step(), 'expected the durable retry job row to exist');
  const row = check.getAsObject() as Record<string, unknown>;
  check.free();
  assert.equal(row.type, 'RETRY_COMMUNITY_ACQUISITION');
  assert.equal(row.status, 'PENDING');
  const payload = JSON.parse(String(row.payload)) as Record<string, unknown>;
  assert.equal(payload.channelId, channelId);
  assert.equal(payload.retryReason, 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE');
  db.close();
});

// REVIEW P1: only terminal-success static roots enter the shared inventory.
test('v2 review: incomplete lender roots are never reusable', () => {
  const nav = [{ url: 'https://lender.example.com/child', score: 50 }];
  const visited = ['https://lender.example.com/'];
  assert.equal(
    isReusableStaticRootLender({ outcome: 'INSPECTED_NO_MATCH', visitedUrls: visited, rootNavigation: nav }),
    true,
  );
  assert.equal(isReusableStaticRootLender({ outcome: 'FOUND', visitedUrls: visited, rootNavigation: nav }), true);
  assert.equal(
    isReusableStaticRootLender({ outcome: 'PARTIALLY_INSPECTED', visitedUrls: visited, rootNavigation: nav }),
    false,
  );
  assert.equal(
    isReusableStaticRootLender({ outcome: 'ACQUISITION_FAILED', visitedUrls: visited, rootNavigation: nav }),
    false,
  );
  assert.equal(isReusableStaticRootLender({ outcome: 'INSPECTED_NO_MATCH', visitedUrls: [], rootNavigation: nav }), false);
  assert.equal(
    isReusableStaticRootLender({ outcome: 'INSPECTED_NO_MATCH', visitedUrls: visited, rootNavigation: undefined }),
    false,
  );
});

// REVIEW P1: a PARTIAL (truncated) lender never feeds the shared inventory,
// so a later borrower refetches instead of inheriting cut coverage.
test('v2 review: truncated lender roots force borrower refetch', async () => {
  const sixteen = Array.from({ length: 16 }, (_, i) => `<a href="/community-${i}">community ${i}</a>`).join('');
  const lenderFetched: string[] = [];
  const lender = await crawlExternalLinks(
    ['https://cap.example.com/'],
    [],
    undefined,
    (async (input) => {
      lenderFetched.push(String(input));
      if (String(input) === 'https://cap.example.com/') return html(sixteen);
      return noInviteHtml();
    }) as typeof fetch,
  );
  assert.equal(lender.outcome, 'PARTIALLY_INSPECTED');
  assert.equal(isReusableStaticRootLender(lender), false);
});

// REVIEW P2: admission-rejected hint links never enter the required set and
// therefore never create REQUIRED_UNVISITED gaps or retry ownership.
test('v2 review: required set excludes admission-rejected URLs', () => {
  const links = discoverRequiredSeedLinks(
    '<a href="/community">c</a><a href="/community-help.js">j</a><a href="/track.css">t</a>',
    PAGE,
  );
  assert.deepEqual(links, ['https://creator.example.com/community']);
});

// REVIEW P1 (round 3): shared evidence stays authoritative in collapse — a
// terminal-success shared row defeats vacuous (zero-evidence) failures for
// the same URL, while evidenced signals still dominate normally.
test('v2 review: shared evidence survives zero-evidence failures in collapse', async () => {
  const { effectiveAcquisitionOutcomes } = await import('./communitySurfacePolicy');
  const shared = {
    requestedUrl: 'https://shared.example.com/',
    surface: 'CREATOR_WEBSITES',
    outcome: 'INSPECTED_NO_MATCH',
    required: false,
    retryable: false,
    sharedEvidenceFrom: 'https://lender.example.com/',
    observedAt: '2026-10-04T12:00:00.000Z',
  };
  const zeroPageFailure = {
    requestedUrl: 'https://shared.example.com/',
    surface: 'CREATOR_WEBSITES',
    outcome: 'ACQUISITION_FAILED',
    required: true,
    retryable: true,
    failureClass: 'NO_PAGE_PROCESSED',
    telemetry: { pagesInspected: 0, requestsStarted: 0, redirectsFollowed: 0 },
    observedAt: '2026-10-04T12:01:00.000Z',
  };
  const collapsed = effectiveAcquisitionOutcomes([shared, zeroPageFailure] as never);
  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0].outcome, 'INSPECTED_NO_MATCH');
  assert.equal((collapsed[0] as { sharedEvidenceFrom?: unknown }).sharedEvidenceFrom, 'https://lender.example.com/');
  // No false retry is owned: the surviving row is non-required.
  const { communityAcquisitionRetryDirective } = await import('./communityRetryPolicy');
  assert.equal(communityAcquisitionRetryDirective(collapsed as never), undefined);
  // ...while an evidenced failure still dominates the shared row.
  const evidencedFailure = { ...zeroPageFailure, telemetry: { pagesInspected: 2 } };
  const collapsed2 = effectiveAcquisitionOutcomes([shared, evidencedFailure] as never);
  assert.equal(collapsed2.length, 1);
  assert.equal(collapsed2[0].outcome, 'ACQUISITION_FAILED');
});

// REVIEW P1 (round 3): truncated/incomplete lender roots are not reusable,
// and borrowers of partial lenders refetch instead of inheriting cuts.
test('v2 review: lender reuse requires terminal success', () => {
  const nav = [{ url: 'https://lender.example.com/child', score: 50 }];
  const visited = ['https://lender.example.com/'];
  assert.equal(isReusableStaticRootLender({ outcome: 'INSPECTED_NO_MATCH', visitedUrls: visited, rootNavigation: nav }), true);
  assert.equal(isReusableStaticRootLender({ outcome: 'FOUND', visitedUrls: visited, rootNavigation: nav }), true);
  assert.equal(isReusableStaticRootLender({ outcome: 'PARTIALLY_INSPECTED', visitedUrls: visited, rootNavigation: nav }), false);
  assert.equal(isReusableStaticRootLender({ outcome: 'ACQUISITION_FAILED', visitedUrls: visited, rootNavigation: nav }), false);
  assert.equal(isReusableStaticRootLender({ outcome: 'INSPECTED_NO_MATCH', visitedUrls: [], rootNavigation: nav }), false);
  assert.equal(isReusableStaticRootLender({ outcome: 'INSPECTED_NO_MATCH', visitedUrls: visited, rootNavigation: undefined }), false);
});

test('v2 review: partial-lender inventory never suppresses borrower refetch', async () => {
  const sixteen = Array.from({ length: 16 }, (_, i) => `<a href="/community-${i}">community ${i}</a>`).join('');
  const lenderFetched: string[] = [];
  const lender = await crawlExternalLinks(
    ['https://captrunc.example.com/'],
    [],
    undefined,
    (async (input) => {
      lenderFetched.push(String(input));
      if (String(input) === 'https://captrunc.example.com/') return html(sixteen);
      return noInviteHtml();
    }) as typeof fetch,
  );
  // Queue-cap truncation makes the lender PARTIAL: not reusable by construction.
  assert.equal(lender.outcome, 'PARTIALLY_INSPECTED');
  assert.equal(isReusableStaticRootLender(lender), false);
});

// REVIEW P2 (round 3): admission-rejected hint links never enter the required set.
test('v2 review: required set admits only crawl-eligible URLs', () => {
  const links = discoverRequiredSeedLinks(
    '<a href="/community">c</a><a href="/community-help.js">j</a><a href="/track.css">t</a><a href="https://other.example.net/join">x</a>',
    PAGE,
  );
  assert.deepEqual(links, ['https://creator.example.com/community']);
});

// REVIEW P3 (round 4): a truncated-lender record never suppresses borrower
// acquisition — the borrower refetches the root itself and acquires the
// complete evidence available to it.
test('v2 review: non-terminal lender records do not suppress borrower refetch', async () => {
  const rootHtml = '<a href="/community-page">community page</a>';
  const truncatedInventory = {
    // Keyed by the exact normalized identity production uses
    // (normalizeVisitUrl): a hand-written literal could drift from the
    // lookup rule and pass vacuously, so the test derives it identically.
    ...(() => {
      const cutKey = normalizeVisitUrl('https://cut.example.com/');
      assert.ok(cutKey, 'normalized fixture key must parse');
      return {
        visitedKeys: [] as string[],
        roots: new Map([
          [cutKey as string, { bySeed: 'https://cut.example.com/', finalUrl: 'https://cut.example.com/', childLinks: [{ url: 'https://cut.example.com/community-page', score: 50 }], terminalSuccess: false }],
        ]),
      };
    })(),
  };
  const fetched: string[] = [];
  const borrowerLog: string[] = [];
  const borrower = await crawlExternalLinks(
    ['https://cut.example.com/'],
    borrowerLog,
    undefined,
    (async (input) => {
      fetched.push(String(input));
      const url = String(input);
      if (url === 'https://cut.example.com/') return html(rootHtml);
      return noInviteHtml();
    }) as typeof fetch,
    'CREATOR_WEBSITES',
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    truncatedInventory,
  );
  assert.ok(fetched.includes('https://cut.example.com/'), 'borrower must fetch the root itself');
  assert.ok(fetched.includes('https://cut.example.com/community-page'), 'borrower acquires complete evidence');
  assert.ok(!borrowerLog.some((line) => line.includes('[Shared static evidence]')));
  assert.ok(borrower.observations.some((item) => item.requestedUrl === 'https://cut.example.com/'));
});

// Ashish path, executed for real: FOUND + retryable required gap, but no
// admitted/discovered invite, so flow reaches the final NOT_FOUND branch.
// The outstanding gap directive must still schedule exactly one durable
// retry job there instead of being silently discarded alongside the
// unadmitted candidates — while status projection stays exactly as before.
test('found-gap retry survives the no-admission NOT_FOUND branch', async () => {
  const gapDirective = {
    attemptFree: true,
    code: 'COMMUNITY_ACQUISITION_CAPACITY_UNAVAILABLE',
    reason: 'REQUIRED_UNVISITED_BUDGET_GAP',
    retryReason: 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE',
  };
  const inspection = {
    acquisitionStatus: 'FOUND',
    acquisitionOutcomes: [
      {
        requestedUrl: 'https://linktr.example.com/creator',
        surface: 'CREATOR_WEBSITES',
        required: true,
        outcome: 'FOUND',
        retryable: true,
        failureClass: 'REQUIRED_UNVISITED_BUDGET_GAP',
      },
    ],
    retryDirective: gapDirective,
  };
  const blankChannel = () => ({
    channel_id: 'UCashish0000000000000001',
    discord_discovery_status: 'NOT_DISCOVERED',
    discord_status: 'UNCERTAIN',
    discord_candidate_locator: null,
    discord_resolution_status: 'NOT_ATTEMPTED',
    discord_liveness_status: 'NOT_CHECKED',
    discord_relevance_status: 'NOT_CHECKED',
    discord_validation_status: 'NOT_STARTED',
    scan_status: 'ENRICHING',
    scan_attempts: 3,
  });
  const calls: Array<{ channelId: string; directive: unknown }> = [];
  const stubEnqueue = (async (channelId: string, directive?: unknown) => {
    calls.push({ channelId, directive });
  }) as (channelId: string, directive?: import('./communityRetryPolicy').CommunityRetryDirective) => Promise<void>;
  const channel = blankChannel() as never;
  await projectNotFoundAfterInspection(
    channel,
    inspection as never,
    { discordCandidates: [], foundInvite: null, steps: [] } as never,
    true,
    stubEnqueue,
  );
  assert.equal(calls.length, 1, 'exactly one durable retry job must be scheduled');
  assert.equal(calls[0].channelId, 'UCashish0000000000000001');
  assert.equal(calls[0].directive, gapDirective, 'the queued job must contain inspection.retryDirective');
  // E7 pending-work guard: a FOUND inspection with an outstanding retryable
  // required gap is not a clean absence. It projects operational failure +
  // RETRY_PENDING instead of COMPLETED/NOT_FOUND, and the durable retry job
  // still survives the branch.
  assert.equal((channel as { scan_status?: unknown }).scan_status, 'FAILED');
  assert.equal((channel as { discord_status?: unknown }).discord_status, 'UNCERTAIN');
  assert.equal((channel as { discord_validation_status?: unknown }).discord_validation_status, 'RETRY_PENDING');
  assert.equal((channel as { discord_discovery_status?: unknown }).discord_discovery_status, 'NOT_DISCOVERED');
  // FOUND_COMPLETE (directive absent) schedules nothing; status identical.
  // The clean fixture carries a real retryable FOUND+required-gap outcome so
  // the missing-directive case is exercised meaningfully rather than
  // vacuously: gap rows alone must never schedule without their directive.
  const cleanCalls: unknown[] = [];
  const cleanChannel = blankChannel() as never;
  await projectNotFoundAfterInspection(
    cleanChannel,
    {
      acquisitionOutcomes: [
        {
          requestedUrl: 'https://linktr.example.com/creator',
          surface: 'CREATOR_WEBSITES',
          required: true,
          outcome: 'FOUND',
          retryable: true,
          failureClass: 'REQUIRED_UNVISITED_BUDGET_GAP',
        },
      ],
      retryDirective: undefined,
    } as never,
    { discordCandidates: [], foundInvite: null, steps: [] } as never,
    true,
    (async (_channelId: string, directive?: unknown) => {
      cleanCalls.push(directive);
    }) as never,
  );
  // Pending work always owns a durable job (E7): a missing inspection
  // directive gets a bounded, attempt-consuming fallback rather than
  // stranding RETRY_PENDING state. It is not labeled a capacity deferral:
  // the backing inspection already ran real acquisition work.
  assert.equal(cleanCalls.length, 1);
  assert.equal((cleanCalls[0] as { attemptFree?: unknown }).attemptFree, false);
  assert.equal((cleanCalls[0] as { code?: unknown }).code, 'COMMUNITY_ACQUISITION_REQUIRED');
  // The retryable required gap still blocks a clean completion even without an
  // inspection directive: the channel never claims COMPLETED.
  assert.equal((cleanChannel as { scan_status?: unknown }).scan_status, 'FAILED');
  // The gap-only scheduler still refuses to schedule by itself without a
  // directive; the durable fallback above is the explicit pending-work path.
  assert.equal(
    shouldScheduleFoundGapAcquisitionRetry({ acquisitionOutcomes: [], retryDirective: undefined }),
    false,
  );
  // No-gap-class guard with a real directive present: a FOUND outcome that is
  // neither retryable nor gap-classed must not schedule, proving the guard
  // evaluated is the gap class itself rather than directive presence.
  assert.equal(
    shouldScheduleFoundGapAcquisitionRetry({
      acquisitionOutcomes: [
        {
          outcome: 'FOUND',
          retryable: false,
        },
      ],
      retryDirective: {
        attemptFree: true,
        code: 'COMMUNITY_ACQUISITION_CAPACITY_UNAVAILABLE',
        reason: 'unrelated recovery',
        retryReason: 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE',
      },
    }),
    false,
  );
});
