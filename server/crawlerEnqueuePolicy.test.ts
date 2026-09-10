import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// Regression coverage for the intended crawl enqueue/filter policy and the
// compact drop instrumentation. Pure-policy units plus wiring assertions;
// budgets themselves are unchanged (rendered 6/5/4, 60s timeout).
import {
  COMMUNITY_HINTS,
  resolveRenderedCompletionState,
} from './browserCommunityFallback';
import {
  communityNavigationScore,
  shouldFollowCommunityTarget,
} from './inspector';
import {
  CRAWL_DROP_REASONS,
  createDropCounter,
  isCrawlDropReason,
  renderedCrawlerTelemetry,
  safeCrawlerTelemetry,
  staticCrawlerTelemetry,
} from './crawlerTelemetry';

test('relevant same-host URL with a recognized community hint is enqueueable', () => {
  assert.ok(communityNavigationScore('https://example.com/community', 'Join us') > 0);
  assert.ok(communityNavigationScore('https://example.com/discord', '') >= 100);
  assert.ok(communityNavigationScore('https://example.com/contact', '') > 0);
  // Higher-signal pages sort first: community outranks contact.
  assert.ok(
    communityNavigationScore('https://example.com/community', '') >
    communityNavigationScore('https://example.com/contact', '')
  );
});

test('score-0 URL is dropped, never enqueued', () => {
  assert.equal(communityNavigationScore('https://example.com/blog/market-recap', 'Weekly notes'), 0);
  assert.equal(communityNavigationScore('https://example.com/pricing', 'Plans'), 0);
});

test('disallowed cross-origin URL is dropped; allowed hosts stay eligible', () => {
  assert.equal(shouldFollowCommunityTarget('https://example.com/community', ''), false);
  assert.equal(shouldFollowCommunityTarget('https://linktr.ee/somecreator', ''), true);
  assert.equal(shouldFollowCommunityTarget('https://whop.com/some-desk', ''), true);
  assert.equal(shouldFollowCommunityTarget('not a url', ''), false);
});

test('rendered hint vocabulary is unchanged (no widening without capacity)', () => {
  assert.equal(
    COMMUNITY_HINTS.source,
    'discord|community|join|chat|member|membership|vip|group|private|trading.?room|links?|social|contact|about'
  );
  assert.ok(COMMUNITY_HINTS.test('https://example.com/community'));
  assert.ok(!COMMUNITY_HINTS.test('https://example.com/blog/market-recap'));
  assert.ok(!COMMUNITY_HINTS.test('https://example.com/pricing'));
});

test('drop counter tallies taxonomy reasons only', () => {
  const drops = createDropCounter();
  drops.count('score-zero');
  drops.count('score-zero');
  drops.count('queue-cap');
  drops.count('bogus-reason' as never);
  drops.count('duplicate', 0);
  drops.count('duplicate', -2);
  assert.deepEqual(drops.snapshot(), { 'score-zero': 2, 'queue-cap': 1 });
  assert.ok(isCrawlDropReason('score-zero'));
  assert.ok(!isCrawlDropReason('bogus-reason'));
  assert.ok(!isCrawlDropReason('cross-origin-allowed'));
});

test('per-link drops are deduped across extraction passes', () => {
  const drops = createDropCounter();
  drops.countUnique('score-zero', 'https://example.com/blog');
  drops.countUnique('score-zero', 'https://example.com/blog');
  drops.countUnique('score-zero', 'https://example.com/pricing');
  assert.deepEqual(drops.snapshot(), { 'score-zero': 2 });
});

test('sanitizer keeps compact counters, strips unknown and non-positive values', () => {
  const kept = safeCrawlerTelemetry({
    mode: 'STATIC',
    redirectsFollowed: 0,
    pagesInspected: 3,
    budgetExhausted: false,
    dropReasons: { 'score-zero': 4, 'bogus': 9, 'duplicate': -1 } as never,
  });
  assert.deepEqual(kept?.dropReasons, { 'score-zero': 4 });
  assert.equal(kept?.scrollsUsed, undefined);
  const scrolled = safeCrawlerTelemetry({
    mode: 'RENDERED',
    redirectsFollowed: 0,
    pagesInspected: 2,
    budgetExhausted: false,
    scrollsUsed: 5,
    dropReasons: { 'control-slice': 8, 'hint-rejected': 3 },
  });
  assert.equal(scrolled?.scrollsUsed, 5);
  assert.deepEqual(scrolled?.dropReasons, { 'control-slice': 8, 'hint-rejected': 3 });
});

test('telemetry constructors carry drops and scroll usage', () => {
  const stat = staticCrawlerTelemetry({ redirectsFollowed: 0, pagesInspected: 2, budgetExhausted: false, dropReasons: { 'score-zero': 2 } });
  assert.deepEqual(stat.dropReasons, { 'score-zero': 2 });
  const rendered = renderedCrawlerTelemetry({ inspectedPages: 2, clicks: 1, complete: true, scrollsUsed: 4, dropReasons: { 'hint-rejected': 1 } });
  assert.equal(rendered.scrollsUsed, 4);
  assert.deepEqual(rendered.dropReasons, { 'hint-rejected': 1 });
  const empty = renderedCrawlerTelemetry({ inspectedPages: 1, clicks: 0, complete: true });
  assert.equal(empty.scrollsUsed, undefined);
  assert.equal(empty.dropReasons, undefined);
});

test('static exploration bound is 12 with drop accounting at every rule', () => {
  const source = readFileSync(new URL('./inspector.ts', import.meta.url), 'utf8');
  assert.match(source, /while\(queue\.length&&explored<12\)/);
  for (const marker of [
    "countUnique('invalid-protocol'",
    "countUnique('cross-origin-disallowed'",
    "countUnique('score-zero'",
    "drops.count('duplicate'",
    "drops.count('queue-cap'",
    "drops.count('depth-limit'",
    "drops.count('already-visited')",
    "drops.count('exploration-limit'",
    'dropReasons:drops.snapshot()',
  ]) {
    assert.ok(source.includes(marker), `missing static wiring: ${marker}`);
  }
  // Accepted cross-origin links are navigated, never counted as drops.
  assert.ok(!source.includes("drops.count('cross-origin-allowed')"));
  assert.equal(CRAWL_DROP_REASONS.length, 12);
});

test('rendered control-slice, hint-reject, scroll, and stop accounting are wired', () => {
  const source = readFileSync(new URL('./browserCommunityFallback.ts', import.meta.url), 'utf8');
  assert.ok(source.includes("drops.count('control-slice'"));
  assert.ok(source.includes("drops.count('hint-rejected')"));
  assert.ok(source.includes("drops.count('page-budget')"));
  assert.ok(source.includes("drops.count('queue-exhausted')"));
  assert.ok(source.includes('dropReasons:drops.snapshot()'));
  const inspector = readFileSync(new URL('./inspector.ts', import.meta.url), 'utf8');
  assert.ok(inspector.includes('scrollsUsed:rendered.scrolls'));
});

test('direct Discord invite in URL is captured without crawling', () => {
  const source = readFileSync(new URL('./inspector.ts', import.meta.url), 'utf8');
  const direct = source.slice(
    source.indexOf('const seedLocators=extractDiscordCandidates(url,surface,url)'),
    source.indexOf('let pagesInspected=0,redirectsFollowed=0,budgetExhausted=false;')
  );
  assert.match(direct, /if\(direct\.length\)/);
  assert.match(direct, /outcome:'FOUND'/);
});

test('depth-two unvisited children are counted as depth-limit drops', async () => {
  const { crawlExternalLinks } = await import('./inspector');
  const htmlResponse = (html: string) =>
    new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  const fakeFetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === 'https://depth.test/') return htmlResponse('<a href="/level1">Community hub</a>');
    if (url === 'https://depth.test/level1') return htmlResponse('<a href="/level2">Members area</a>');
    if (url === 'https://depth.test/level2')
      return htmlResponse('<a href="/deep-a">Join chat</a><a href="/deep-b">Community group</a><a href="/deep-c">VIP room</a>');
    return htmlResponse('<p>Leaf page without invite.</p>');
  }) as typeof fetch;
  const result = await crawlExternalLinks(['https://depth.test/'], [], undefined, fakeFetch);
  assert.equal(result.outcome, 'PARTIALLY_INSPECTED');
  const seed = result.observations.find(
    item => item.requestedUrl === 'https://depth.test/' && item.outcome === 'PARTIALLY_INSPECTED'
  );
  assert.ok(seed, 'expected a partial seed summary observation');
  // Three eligible depth-3 links were discarded at the depth boundary without
  // ever entering the queue — all three must be counted, not just noted.
  assert.deepEqual(seed?.telemetry?.dropReasons?.['depth-limit'], 3);
});

test('measured page-budget cutoff marks otherwise-clean crawls incomplete', () => {
  const telemetry = {
    requestsStarted: 6,
    requestsFinished: 6,
    requestsFailed: 0,
    unresolvedFailedRequests: 0,
  } as never;
  const clean = resolveRenderedCompletionState({ inspectedPages: 6, timedOut: false, telemetry });
  assert.equal(clean.complete, true);
  assert.equal(clean.retryable, false);
  const cut = resolveRenderedCompletionState({
    inspectedPages: 6,
    timedOut: false,
    telemetry,
    pageBudgetExhausted: true,
  });
  // A successful final response is not coverage proof while eligible
  // requests remained queued: incomplete and retryable, with no failure
  // class (nothing failed — coverage is what is missing).
  assert.equal(cut.complete, false);
  assert.equal(cut.retryable, true);
  assert.equal(cut.failureClass, undefined);
});

test('page-budget cutoff is measured from the isolated queue, not inferred', () => {
  const source = readFileSync(new URL('./browserCommunityFallback.ts', import.meta.url), 'utf8');
  assert.ok(source.includes('getInfo'), 'supported queue-info API must be read after the crawl');
  assert.ok(source.includes('pendingRequestCount'), 'pending eligible requests come from queue info');
  assert.ok(!source.includes('getPendingCount'), 'heuristic pending count must not be used');
  assert.ok(source.includes('pageBudgetExhausted'), 'measured flag must flow into completion');
  assert.ok(source.includes("drops.count('page-budget')"));
});

test('constructors sanitize drop reasons and scroll usage at construction time', () => {
  const dirty = renderedCrawlerTelemetry({
    inspectedPages: 1,
    clicks: 0,
    complete: true,
    dropReasons: { 'bogus-reason': 5, 'score-zero': 2.7, duplicate: -3 } as never,
    scrollsUsed: NaN,
  });
  assert.deepEqual(dirty.dropReasons, { 'score-zero': 2 });
  assert.equal(dirty.scrollsUsed, undefined);
  const dirtyStatic = staticCrawlerTelemetry({
    redirectsFollowed: 0,
    pagesInspected: 1,
    budgetExhausted: false,
    dropReasons: { 'queue-cap': 1e12 } as never,
  });
  assert.deepEqual(dirtyStatic.dropReasons, { 'queue-cap': 999999 });
});

test('allowed cross-origin community link is navigated without drop counting', async () => {
  const { crawlExternalLinks } = await import('./inspector');
  const htmlResponse = (html: string) =>
    new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  const calls: string[] = [];
  const fakeFetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url === 'https://creator.test/')
      return htmlResponse(
        '<a href="https://linktr.ee/creator">Linktree community</a>' +
        '<a href="https://evil.test/community">External community</a>'
      );
    return htmlResponse('<p>Leaf page without invite.</p>');
  }) as typeof fetch;
  const result = await crawlExternalLinks(['https://creator.test/'], [], undefined, fakeFetch);
  // The allowlisted cross-origin link is eligible and fetched…
  assert.ok(calls.includes('https://linktr.ee/creator'), 'allowlisted cross-origin link must be navigated');
  // …while the disallowed one is neither fetched nor silently ignored.
  assert.ok(!calls.includes('https://evil.test/community'), 'disallowed cross-origin link must not be fetched');
  const seed = result.observations.find(item => item.requestedUrl === 'https://creator.test/');
  const drops = (seed?.telemetry as { dropReasons?: Record<string, number> } | undefined)?.dropReasons || {};
  assert.equal(drops['cross-origin-allowed'], undefined);
  assert.equal(drops['cross-origin-disallowed'], 1);
});

test('fragment variants of one disallowed URL count as a single drop', async () => {
  const { crawlExternalLinks } = await import('./inspector');
  const htmlResponse = (html: string) =>
    new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  const fakeFetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === 'https://creator.test/')
      return htmlResponse(
        '<a href="https://outside.test/community#top">External community</a>' +
        '<a href="https://outside.test/community#join">External community</a>'
      );
    return htmlResponse('<p>Leaf page without invite.</p>');
  }) as typeof fetch;
  const result = await crawlExternalLinks(['https://creator.test/'], [], undefined, fakeFetch);
  const seed = result.observations.find(item => item.requestedUrl === 'https://creator.test/');
  const drops = (seed?.telemetry as { dropReasons?: Record<string, number> } | undefined)?.dropReasons || {};
  // Both fragments target the same fetched resource: one candidate, one drop.
  assert.equal(drops['cross-origin-disallowed'], 1);
});
