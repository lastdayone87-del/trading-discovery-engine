import assert from 'node:assert/strict';
import test from 'node:test';
import {
  partitionRenderedClickTargets,
  isSkippableNavigableAnchorClick,
  resolveRenderedCompletionState,
} from './browserCommunityFallback';
import { hasConsecutiveTimeoutExhaustion } from './crawlUrlSkipPolicy';
import { communityAcquisitionRetryDirective } from './communityRetryPolicy';
import { runChannelInspection } from './inspector';
import type { BrowserFallbackResult } from './browserCommunityFallback';

const PAGE = 'https://creator.example.com/guide';
const anchor = (index: number, href: string) => ({ index, text: `community ${href}`, href });
const button = (index: number) => ({ index, text: 'join VIP group', href: null });

// Traversal: ordinary navigable same-host anchors passing the enqueue rule
// are skipped (discoverable via enqueueLinks, text retained pre-click);
// everything else keeps clicks.
test('acquisition: same-host navigable anchors skip clicks, buttons do not', () => {
  assert.equal(isSkippableNavigableAnchorClick({ href: '/community' }, PAGE), true);
  assert.equal(isSkippableNavigableAnchorClick({ href: 'https://creator.example.com/join' }, PAGE), true);
  assert.equal(isSkippableNavigableAnchorClick({ href: null }, PAGE), false);
  assert.equal(isSkippableNavigableAnchorClick({ href: '' }, PAGE), false);
  // Non-navigational hrefs where clicking may be necessary are preserved.
  assert.equal(isSkippableNavigableAnchorClick({ href: '#section' }, PAGE), false);
  assert.equal(isSkippableNavigableAnchorClick({ href: 'javascript:void(0)' }, PAGE), false);
  assert.equal(isSkippableNavigableAnchorClick({ href: 'mailto:a@b.com' }, PAGE), false);
  // Same-host anchors failing the enqueue rule must still be clicked:
  // otherwise they would be neither clicked nor enqueued and discovery
  // could be lost.
  assert.equal(isSkippableNavigableAnchorClick({ href: '/logo.png' }, PAGE), false);
  assert.equal(isSkippableNavigableAnchorClick({ href: '/plain-page' }, PAGE), false);
  // Cross-host navigation keeps current behavior (never silently dropped).
  assert.equal(isSkippableNavigableAnchorClick({ href: 'https://other.example.net/join' }, PAGE), false);
  // Unparseable hrefs fail open toward recall.
  assert.equal(isSkippableNavigableAnchorClick({ href: 'http://exa mple.com/' }, PAGE), false);
});

test('acquisition: mixed ordering reaches buttons past skipped anchors with locator indexes intact', () => {
  const controls = [
    anchor(0, '/community-1'),
    anchor(1, '/community-2'),
    anchor(2, '/community-3'),
    anchor(3, '/community-4'),
    anchor(4, '/community-5'),
    button(5),
    button(6),
  ];
  const plan = partitionRenderedClickTargets(controls, PAGE, 4);
  // Buttons are reached even though 5 anchors precede them; the 4-click
  // budget applies to attempted clicks only.
  assert.deepEqual(plan.toClick.map((c) => c.index), [5, 6]);
  assert.equal(plan.skippedNavigableAnchors, 5);
});

test('acquisition: click budget binds attempted clicks beyond the old take-12 window', () => {
  const anchors = Array.from({ length: 13 }, (_, i) => anchor(i, `/community-${i}`));
  const controls = [...anchors, button(13)];
  const plan = partitionRenderedClickTargets(controls, PAGE, 4);
  // Partitioning sees the complete bounded set first: the click-only button
  // at index 13 is never hidden behind skipped anchors.
  assert.deepEqual(plan.toClick.map((c) => c.index), [13]);
  assert.equal(plan.skippedNavigableAnchors, 13);
});

test('acquisition: click budget binds attempted clicks, slice remainder stays accurate', () => {
  const controls = [button(0), button(1), button(2), button(3), button(4), button(5)];
  const plan = partitionRenderedClickTargets(controls, PAGE, 4);
  assert.deepEqual(plan.toClick.map((c) => c.index), [0, 1, 2, 3]);
  assert.equal(plan.skippedNavigableAnchors, 0);
  assert.equal(controls.length - plan.toClick.length - plan.skippedNavigableAnchors, 2);
});

// Seed fan-out: bare/www duplicates collapse; distinct paths/tenants do not.
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

async function inspectLinks(channelLinks: string[]) {
  const fetched: string[] = [];
  const result = await runChannelInspection({
    channelId: `acq-${Math.random().toString(36).slice(2)}`,
    channelName: 'Acquisition Channel',
    channelBio: 'Trading notes',
    channelLinks,
    videoDescriptions: fillers,
    creatorLikelyTrading: false,
    externalFetchImpl: (async (input) => {
      fetched.push(String(input));
      return noInviteHtml();
    }) as typeof fetch,
    renderedFallback: emptyRendered,
  });
  return { fetched, result };
}

test('acquisition: bare/www duplicate seeds share one crawl', async () => {
  const { fetched, result } = await inspectLinks(['http://asenna.com.au/', 'http://www.asenna.com.au/']);
  assert.equal(fetched.filter((url) => url.includes('asenna.com.au')).length, 1);
  const trail = JSON.stringify(result.steps || []);
  assert.ok(trail.includes('Seed deduplicated (BARE_WWW_DUPLICATE)'));
});

test('acquisition: distinct same-host paths keep independent crawls', async () => {
  const paths = ['/downloads', '/free-trial', '/system-requirement', '/landing/20-years'];
  const { fetched } = await inspectLinks(paths.map((p) => `https://volfix.example.com${p}`));
  for (const p of paths) {
    assert.ok(fetched.some((url) => url.includes(p)), `path seed must still crawl: ${p}`);
  }
});

test('acquisition: path tenants and query variants never collapse', async () => {
  const { fetched } = await inspectLinks([
    'https://www.skool.com/manrewired',
    'https://www.skool.com/freedomalgo',
    'https://creator.example.com/guide?a=1',
    'https://creator.example.com/guide?a=2',
  ]);
  assert.ok(fetched.some((url) => url.includes('manrewired')));
  assert.ok(fetched.some((url) => url.includes('freedomalgo')));
  assert.ok(fetched.some((url) => url.includes('a=1')));
  assert.ok(fetched.some((url) => url.includes('a=2')));
});

test('acquisition: multiple invite URLs on one site are all retained', async () => {
  const fetched: string[] = [];
  const result = await runChannelInspection({
    channelId: 'acq-multi-invite',
    channelName: 'Multi Invite Channel',
    channelBio: 'Trading notes',
    channelLinks: ['https://creator.example.com/vip', 'https://creator.example.com/free'],
    videoDescriptions: fillers,
    creatorLikelyTrading: false,
    externalFetchImpl: (async (input) => {
      const url = String(input);
      fetched.push(url);
      if (url.includes('/vip')) return html('Join https://discord.gg/vip-room');
      if (url.includes('/free')) return html('Join https://discord.gg/free-room');
      return noInviteHtml();
    }) as typeof fetch,
    renderedFallback: emptyRendered,
  });
  const codes = (result.discordCandidates || []).map((c) => c.nativeInviteCode);
  assert.ok(codes.includes('vip-room') && codes.includes('free-room'), `both invites retained: ${codes}`);
});

// Completion semantics locked: timeout with healthy pages stays incomplete
// and retryable; drained clean coverage completes; terminal failure fails.
test('acquisition: completion contract distinguishes timeout, drain, and terminal failure', () => {
  const skool = resolveRenderedCompletionState({
    inspectedPages: 4,
    timedOut: true,
    telemetry: { requestsStarted: 4 } as never,
  });
  assert.equal(skool.complete, false);
  assert.equal(skool.retryable, true);
  const drained = resolveRenderedCompletionState({
    inspectedPages: 6,
    timedOut: false,
    telemetry: {} as never,
  });
  assert.equal(drained.complete, true);
  assert.equal(drained.retryable, false);
  const terminal = resolveRenderedCompletionState({
    inspectedPages: 2,
    timedOut: false,
    telemetry: { unresolvedFailedRequests: 1 } as never,
  });
  assert.equal(terminal.complete, false);
  assert.equal(terminal.retryable, true);
});

// Retry suppression: two prior identical timeouts exhaust deterministic
// re-execution (0% observed recovery); anything else still retries.
test('acquisition: consecutive identical timeouts exhaust retry ownership', () => {
  const priors = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      requestedUrl: 'https://creator.example.com/guide',
      failureClass: 'RENDERED_TIMEOUT',
      outcome: 'PARTIALLY_INSPECTED',
      observedAt: new Date(Date.UTC(2026, 9, 4 - i, 12)).toISOString(),
    }));
  assert.equal(hasConsecutiveTimeoutExhaustion(priors(2), 'https://creator.example.com/guide'), true);
  assert.equal(hasConsecutiveTimeoutExhaustion(priors(1), 'https://creator.example.com/guide'), false);
  assert.equal(hasConsecutiveTimeoutExhaustion([], 'https://creator.example.com/guide'), false);
  const recovered = [
    ...priors(1),
    {
      requestedUrl: 'https://creator.example.com/guide',
      failureClass: null,
      outcome: 'INSPECTED_NO_MATCH',
      observedAt: new Date(Date.UTC(2026, 9, 1, 12)).toISOString(),
    },
    ...priors(1).map((row) => ({ ...row, observedAt: new Date(Date.UTC(2026, 8, 20, 12)).toISOString() })),
  ];
  assert.equal(hasConsecutiveTimeoutExhaustion(recovered, 'https://creator.example.com/guide'), false);
  const drifted = priors(2).map((row, i) =>
    i === 0 ? { ...row, failureClass: 'TRANSIENT_HTTP' } : row,
  );
  assert.equal(hasConsecutiveTimeoutExhaustion(drifted, 'https://creator.example.com/guide'), false);
});

test('acquisition: suppressed timeouts lose retry ownership but keep status', async () => {
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
  const history = [4, 3].map((day) => ({
    requestedUrl: 'https://timeout.example.com/',
    failureClass: 'RENDERED_TIMEOUT',
    outcome: 'PARTIALLY_INSPECTED',
    observedAt: new Date(Date.UTC(2026, 9, day, 12)).toISOString(),
  }));
  const result = await runChannelInspection({
    channelId: 'acq-timeout-suppressed',
    channelName: 'Timeout Suppressed Channel',
    channelBio: 'Trading notes',
    channelLinks: ['https://timeout.example.com/'],
    videoDescriptions: fillers,
    creatorLikelyTrading: true,
    externalFetchImpl: (async () => {
      throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    }) as typeof fetch,
    renderedFallback: timeoutRendered,
    urlFailureHistoryLoader: (async () => history) as never,
  });
  assert.equal(result.acquisitionStatus, 'PARTIALLY_INSPECTED');
  assert.equal(result.retryDirective, undefined);
  assert.deepEqual(result.retrySuppressedUrls, ['https://timeout.example.com/']);
});

test('acquisition: first timeout still owns its recovery retry', async () => {
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
  const result = await runChannelInspection({
    channelId: 'acq-timeout-first',
    channelName: 'Timeout First Channel',
    channelBio: 'Trading notes',
    channelLinks: ['https://timeout2.example.com/'],
    videoDescriptions: fillers,
    creatorLikelyTrading: true,
    externalFetchImpl: (async () => {
      throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    }) as typeof fetch,
    renderedFallback: timeoutRendered,
    urlFailureHistoryLoader: (async () => []) as never,
  });
  assert.ok(result.retryDirective, 'first deterministic timeout keeps its recovery retry');
  assert.equal(result.retryDirective?.retryReason, 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE');
  assert.deepEqual(result.retrySuppressedUrls, []);
});
