import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// Regression coverage for the intended crawl enqueue/filter policy and the
// compact drop instrumentation. Pure-policy units plus wiring assertions;
// budgets themselves are unchanged (rendered 6/5/4, 60s timeout).
import {
  COMMUNITY_HINTS,
  RENDERED_CONTROL_SELECTOR,
  resolveRenderedCompletionState,
} from './browserCommunityFallback';
import {
  communityNavigationScore,
} from './inspector';
import { shouldFollowDestination } from './destinationPolicy';
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

test('score-0 same-origin URL stays navigable via the evidence floor; unknown hosts stay closed', () => {
  // Scoring itself is unchanged: a generic path scores zero.
  assert.equal(communityNavigationScore('https://example.com/blog/market-recap', 'Weekly notes'), 0);
  assert.equal(communityNavigationScore('https://example.com/pricing', 'Plans'), 0);
  // Destination policy: same-origin pages keep a nonzero floor (the creator's
  // own site may use an unfamiliar path for its community page).
  const sameOrigin = shouldFollowDestination({ url: 'https://example.com/pricing', currentUrl: 'https://example.com/' });
  assert.equal(sameOrigin.eligible, true);
  assert.equal(sameOrigin.reason, 'same-origin');
  assert.ok(sameOrigin.score >= 1);
  // The same generic path on an unknown host never opens a new domain.
  const crossOrigin = shouldFollowDestination({ url: 'https://unrelated.test/pricing', currentUrl: 'https://example.com/', anchorText: 'Plans' });
  assert.equal(crossOrigin.eligible, false);
  assert.equal(crossOrigin.reason, 'no-community-evidence');
});

test('cross-origin destinations follow evidence, not a hard host allowlist', () => {
  // Known community/link-hub hosts are eligible without anchor evidence.
  assert.equal(shouldFollowDestination({ url: 'https://linktr.ee/somecreator', currentUrl: 'https://creator.test/' }).eligible, true);
  assert.equal(shouldFollowDestination({ url: 'https://whop.com/some-desk', currentUrl: 'https://creator.test/' }).eligible, true);
  // Unknown creators' domains with explicit community evidence are eligible
  // (the proven false-negative this policy fixes).
  const evidenced = shouldFollowDestination({ url: 'https://signal-provider.example/community', currentUrl: 'https://creator.test/', anchorText: 'Join our Discord' });
  assert.equal(evidenced.eligible, true);
  assert.equal(evidenced.reason, 'community-evidence');
  // Structured nominations (sitemap/navigation patterns) open a host too.
  assert.equal(shouldFollowDestination({ url: 'https://unknown.example/portal', currentUrl: 'https://creator.test/', structuredNominated: true }).eligible, true);
  // Admission-rejected and unparsable URLs are dropped at the shared boundary.
  assert.equal(shouldFollowDestination({ url: 'not a url', currentUrl: 'https://creator.test/' }).eligible, false);
  assert.equal(shouldFollowDestination({ url: 'not a url', currentUrl: 'https://creator.test/' }).reason, 'admission-rejected');
  assert.equal(shouldFollowDestination({ url: 'https://unknown.test/join', currentUrl: 'https://creator.test/', anchorText: 'Member area' }).eligible, true);
  assert.equal(shouldFollowDestination({ url: 'https://unknown.test/docs', currentUrl: 'https://creator.test/', anchorText: 'Docs' }).eligible, false);
});

test('rendered hint vocabulary covers community and paid-platform destinations', () => {
  for (const marker of ['discord', 'community', 'join', 'whop', 'skool', 'circle', 'patreon', 'premium', 'paid', 'subscribe', 'access']) {
    assert.ok(COMMUNITY_HINTS.test(`https://example.com/${marker}`), `hints must cover ${marker}`);
  }
  assert.ok(COMMUNITY_HINTS.test('https://example.com/membership'));
  assert.ok(COMMUNITY_HINTS.test('https://example.com/mentor'));
  assert.ok(!COMMUNITY_HINTS.test('https://example.com/blog/market-recap'));
  assert.ok(!COMMUNITY_HINTS.test('https://example.com/pricing'));
  // Interactive control enumeration/click selector is a single shared query.
  assert.equal(RENDERED_CONTROL_SELECTOR, 'a,button,[role="button"],[role="tab"],summary,[aria-expanded="false"]');
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
  assert.ok(isCrawlDropReason('destination-budget'));
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
  const stat = staticCrawlerTelemetry({ redirectsFollowed: 0, pagesInspected: 2, dropReasons: { 'score-zero': 2 } });
  assert.deepEqual(stat.dropReasons, { 'score-zero': 2 });
  const rendered = renderedCrawlerTelemetry({ inspectedPages: 2, clicks: 1, complete: true, scrollsUsed: 4, dropReasons: { 'hint-rejected': 1 } });
  assert.equal(rendered.scrollsUsed, 4);
  assert.deepEqual(rendered.dropReasons, { 'hint-rejected': 1 });
  const empty = renderedCrawlerTelemetry({ inspectedPages: 1, clicks: 0, complete: true });
  assert.equal(empty.scrollsUsed, undefined);
  assert.equal(empty.dropReasons, undefined);
});

test('static exploration bound is 12 with destination-budget drop accounting', () => {
  const source = readFileSync(new URL('./inspector.ts', import.meta.url), 'utf8');
  assert.match(source, /while\(queue\.length&&explored<12\)/);
  for (const marker of [
    "countUnique('invalid-protocol'",
    "shouldFollowDestination(",
    'createDestinationBudget()',
    "drops.count('destination-budget')",
    "seedCeiling??='exploration-limit'",
    "drops.count('duplicate'",
    "drops.count('queue-cap'",
    "drops.count('depth-limit'",
    "drops.count('already-visited')",
    "drops.count('exploration-limit'",
    'dropReasons:drops.snapshot()',
  ]) {
    assert.ok(source.includes(marker), `missing static wiring: ${marker}`);
  }
  assert.equal(CRAWL_DROP_REASONS.length, 16, 'destination-budget extends the closed taxonomy additively');
  assert.ok(CRAWL_DROP_REASONS.includes('destination-budget'));
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
    source.indexOf('let pagesInspected=0,redirectsFollowed=0,seedCeiling:CeilingKind|undefined;')
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
    dropReasons: { 'queue-cap': 1e12 } as never,
  });
  assert.deepEqual(dirtyStatic.dropReasons, { 'queue-cap': 999999 });
});

test('evidenced cross-origin community link is navigated; unevidenced outbound link is dropped', async () => {
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
        '<a href="https://outside.test/prices">Pricing plans</a>'
      );
    return htmlResponse('<p>Leaf page without invite.</p>');
  }) as typeof fetch;
  const result = await crawlExternalLinks(['https://creator.test/'], [], undefined, fakeFetch);
  // The known community host is eligible and fetched…
  assert.ok(calls.includes('https://linktr.ee/creator'), 'known community host must be navigated');
  // …while an outbound link with no community evidence is neither fetched nor
  // silently ignored.
  assert.ok(!calls.includes('https://outside.test/prices'), 'unevidenced cross-origin link must not be fetched');
  const seed = result.observations.find(item => item.requestedUrl === 'https://creator.test/');
  const drops = (seed?.telemetry as { dropReasons?: Record<string, number> } | undefined)?.dropReasons || {};
  assert.equal(drops['cross-origin-allowed'], undefined);
  assert.equal(drops['cross-origin-disallowed'], 1);
});

test('fragment variants of one dropped URL count as a single drop', async () => {
  const { crawlExternalLinks } = await import('./inspector');
  const htmlResponse = (html: string) =>
    new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  const fakeFetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === 'https://creator.test/')
      return htmlResponse(
        '<a href="https://outside.test/docs#top">Product docs</a>' +
        '<a href="https://outside.test/docs#install">Product docs</a>'
      );
    return htmlResponse('<p>Leaf page without invite.</p>');
  }) as typeof fetch;
  const result = await crawlExternalLinks(['https://creator.test/'], [], undefined, fakeFetch);
  const seed = result.observations.find(item => item.requestedUrl === 'https://creator.test/');
  const drops = (seed?.telemetry as { dropReasons?: Record<string, number> } | undefined)?.dropReasons || {};
  // Both fragments target the same fetched resource: one candidate, one drop.
  assert.equal(drops['cross-origin-disallowed'], 1);
});

test('depth-limit ceiling is named on the partial seed without touching terminal failures', async () => {
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
  const seed = result.observations.find(
    item => item.requestedUrl === 'https://depth.test/' && item.outcome === 'PARTIALLY_INSPECTED'
  );
  assert.ok(seed, 'expected a partial seed summary observation');
  assert.equal(seed?.telemetry?.budgetExhausted, true);
  assert.deepEqual((seed?.telemetry as { ceiling?: unknown })?.ceiling, { kind: 'depth-limit' });
});

test('oversized navigation queue names queue-cap on the partial seed', async () => {
  const { crawlExternalLinks } = await import('./inspector');
  const links = Array.from({ length: 14 }, (_, index) => `<a href="/hub-${index}">Community hub ${index}</a>`).join('');
  const htmlResponse = (html: string) =>
    new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  const rootFetch = (async (input: RequestInfo | URL) => {
    if (String(input) === 'https://wide.test/') return htmlResponse(links);
    return htmlResponse('<p>Leaf page without invite.</p>');
  }) as typeof fetch;
  const result = await crawlExternalLinks(['https://wide.test/'], [], undefined, rootFetch);
  const seed = result.observations.find(
    item => item.requestedUrl === 'https://wide.test/' && item.outcome === 'PARTIALLY_INSPECTED'
  );
  assert.ok(seed, 'expected a partial seed summary observation');
  assert.deepEqual((seed?.telemetry as { ceiling?: unknown })?.ceiling, { kind: 'queue-cap' });
});

test('first ceiling wins when a crawl trips several caps', async () => {
  const { crawlExternalLinks } = await import('./inspector');
  const links = Array.from({ length: 13 }, (_, index) => `<a href="/hub-${index}">Community hub ${index}</a>`).join('');
  const htmlResponse = (html: string) =>
    new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  const fakeFetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === 'https://multi.test/') return htmlResponse(links);
    if (url === 'https://multi.test/hub-0') return htmlResponse('<a href="/hub-0/deep">Join the Discord community room</a>');
    if (url === 'https://multi.test/hub-0/deep') return htmlResponse('<a href="/hub-0/deep/deeper">VIP inner circle</a>');
    return htmlResponse('<p>Leaf page without invite.</p>');
  }) as typeof fetch;
  const result = await crawlExternalLinks(['https://multi.test/'], [], undefined, fakeFetch);
  const seed = result.observations.find(
    item => item.requestedUrl === 'https://multi.test/' && item.outcome === 'PARTIALLY_INSPECTED'
  );
  assert.ok(seed, 'expected a partial seed summary observation');
  // Queue-cap trips at dedup time, before the loop reaches depth-limit territory.
  assert.deepEqual((seed?.telemetry as { ceiling?: unknown })?.ceiling, { kind: 'queue-cap' });
  assert.ok((seed?.telemetry?.dropReasons?.['queue-cap'] || 0) > 0);
  assert.ok((seed?.telemetry?.dropReasons?.['depth-limit'] || 0) > 0, 'later caps stay counted in dropReasons');
});

test('later response-cap truncation is counted even when another ceiling claimed the label', async () => {
  const { crawlExternalLinks } = await import('./inspector');
  const { MAX_CRAWL_RESPONSE_CHARS } = await import('./crawlResponseBounds');
  const padding = 'v '.repeat(MAX_CRAWL_RESPONSE_CHARS / 2 + 50_000);
  const bigHtml = `<html><body>${padding}</body></html>`;
  assert.ok(bigHtml.length > MAX_CRAWL_RESPONSE_CHARS);
  const htmlResponse = (html: string) =>
    new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  const links = Array.from({ length: 13 }, (_, index) => `<a href="/hub-${index}">Community hub ${index}</a>`).join('');
  const fakeFetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === 'https://multi.test/') return htmlResponse(links);
    if (url === 'https://multi.test/hub-0') return htmlResponse(bigHtml);
    return htmlResponse('<p>Leaf page without invite.</p>');
  }) as typeof fetch;
  const result = await crawlExternalLinks(['https://multi.test/'], [], undefined, fakeFetch);
  const seed = result.observations.find(
    item => item.requestedUrl === 'https://multi.test/' && item.outcome === 'PARTIALLY_INSPECTED'
  );
  assert.ok(seed, 'expected a partial seed summary observation');
  assert.deepEqual((seed?.telemetry as { ceiling?: unknown })?.ceiling, { kind: 'queue-cap' });
  assert.ok((seed?.telemetry?.dropReasons?.['queue-cap'] || 0) > 0);
  assert.ok((seed?.telemetry?.dropReasons?.['response-cap'] || 0) > 0, 'child truncation survives alongside the primary label');
});
