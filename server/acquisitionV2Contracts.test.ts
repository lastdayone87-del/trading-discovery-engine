import assert from 'node:assert/strict';
import test from 'node:test';
import {
  partitionRenderedClickTargets,
  isSkippableNavigableAnchorClick,
  discoverRequiredSeedLinks,
  normalizeVisitUrl,
  resolveRenderedCompletionState,
} from './browserCommunityFallback';
import { hasConsecutiveTimeoutExhaustion } from './crawlUrlSkipPolicy';
import { communityAcquisitionRetryDirective } from './communityRetryPolicy';
import { runChannelInspection } from './inspector';
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
  const controls = [anchor(0, '/a1'), anchor(1, '/a2'), anchor(2, '/a3'), anchor(3, '/a4'), anchor(4, '/a5'), button(5), button(6)];
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
