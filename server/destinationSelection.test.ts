/**
 * P1 destination-selection regressions.
 *
 * Every case here is a confirmed defect from the 2026-10-19 pipeline
 * investigation: an evidenced cross-domain community destination was dropped
 * before fetch (hard host allowlist), a same-origin community path without a
 * keyword was dropped as score-zero, or exploration budget was spent on
 * duplicates/pagination while a distinct eligible target was starved.
 * The swingfish.trade/discord case is the named report regression.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldFollowDestination, selectDiverseNavigationQueue, createDestinationBudget, isKnownCommunityDestinationHost, destinationTemplate } from './destinationPolicy';
import { CRAWL_DROP_REASONS } from './crawlerTelemetry';
import { crawlExternalLinks } from './inspector';

const htmlResponse = (body: string) =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });

test('unknown cross-origin host with explicit community evidence is followed', () => {
  const decision = shouldFollowDestination({
    url: 'https://unknown-creator-space.example/join',
    currentUrl: 'https://creator.test/',
    anchorText: 'Join our Discord community',
  });
  assert.equal(decision.eligible, true);
  assert.equal(decision.reason, 'community-evidence');
  assert.ok(decision.score > 0, 'evidenced destination carries a positive score');
});

test('unknown cross-origin host with only generic labels is never opened', () => {
  for (const anchorText of ['About', 'Contact', 'Resources', 'Support']) {
    const decision = shouldFollowDestination({
      url: 'https://unrelated.example/about',
      currentUrl: 'https://creator.test/',
      anchorText,
    });
    assert.equal(decision.eligible, false, `${anchorText} alone must not open an unknown host`);
    assert.equal(decision.reason, 'no-community-evidence');
  }
});

test('paid/premium wording alone never opens an unknown host', () => {
  const decision = shouldFollowDestination({
    url: 'https://random-shop.example/premium',
    currentUrl: 'https://creator.test/',
    anchorText: 'Premium plan',
  });
  assert.equal(decision.eligible, false);
});

test('same-origin unfamiliar path keeps a nonzero floor (legacy score-zero leak)', () => {
  const decision = shouldFollowDestination({
    url: 'https://creator.test/our-space',
    currentUrl: 'https://creator.test/',
    anchorText: '/our-space',
    baseScore: 0,
  });
  assert.equal(decision.eligible, true);
  assert.equal(decision.reason, 'same-origin');
  assert.equal(decision.score, 1);
});

test('known community platform and link-hub hosts are followed without new evidence', () => {
  for (const url of ['https://whop.com/creator', 'https://www.skool.com/trading', 'https://linktr.ee/creator']) {
    const decision = shouldFollowDestination({ url, currentUrl: 'https://creator.test/' });
    assert.equal(decision.eligible, true, url);
    assert.equal(decision.reason, 'known-community-host');
  }
  assert.equal(isKnownCommunityDestinationHost('app.circle.so'), true);
  assert.equal(isKnownCommunityDestinationHost('notwhop.com'), false);
});

test('structured nominations are eligible without anchor evidence', () => {
  const decision = shouldFollowDestination({
    url: 'https://structured.example/community',
    currentUrl: 'https://creator.test/',
    structuredNominated: true,
    baseScore: 30,
  });
  assert.equal(decision.eligible, true);
  assert.equal(decision.reason, 'structured-nomination');
});

test('broker hosts and affiliate redirects are downranked, not admitted blindly', () => {
  const broker = shouldFollowDestination({
    url: 'https://www.binance.com/referral',
    currentUrl: 'https://creator.test/',
    anchorText: 'Join the community on Binance',
  });
  const plain = shouldFollowDestination({
    url: 'https://community.example/join',
    currentUrl: 'https://creator.test/',
    anchorText: 'Join the community',
  });
  assert.ok(broker.eligible && plain.eligible);
  assert.ok(broker.score < plain.score, 'broker destination ranks below an equivalent neutral host');
  const affiliate = shouldFollowDestination({
    url: 'https://community.example/join?ref=creator',
    currentUrl: 'https://creator.test/',
    anchorText: 'Join the community',
  });
  assert.ok(affiliate.score < plain.score, 'referral parameters are downranked');
});

test('admission boundary still rejects non-public destinations; anchor evidence remains eligible', () => {
  const localhost = shouldFollowDestination({ url: 'http://localhost/community', currentUrl: 'https://creator.test/', anchorText: 'Join our Discord' });
  assert.equal(localhost.eligible, false);
  assert.equal(localhost.reason, 'admission-rejected');
  const evidenced = shouldFollowDestination({ url: 'https://unrelated.example/join', currentUrl: 'https://creator.test/', anchorText: 'Join our Discord' });
  assert.equal(evidenced.eligible, true, 'the explicit community anchor is eligible on an unknown public host');
});

test('duplicate URLs never consume queue budget while unique eligible targets are dropped', () => {
  const items = [
    ...Array.from({ length: 12 }, (_, i) => ({ url: `https://paginated.example/page/${i}`, score: 100 - i })),
    { url: 'https://creator.example/community', score: 5 },
  ];
  const selection = selectDiverseNavigationQueue(items, 12);
  assert.equal(selection.selected.length, 12);
  assert.equal(selection.selected[11].url, 'https://creator.example/community', 'one slot is reserved for a distinct destination template');
  assert.equal(selection.diversitySelected, true);
  assert.equal(selection.dropped, 1);
  // Selection is still score-ordered: the diverse replacement takes the last slot.
  assert.ok(selection.selected[0].score >= selection.selected[1].score);
});

test('tracking query parameters are not community evidence', () => {
  assert.equal(shouldFollowDestination({
    url: 'https://unrelated.example/page?campaign=signal',
    currentUrl: 'https://creator.test/',
    anchorText: 'Read more',
  }).eligible, false);
  assert.equal(shouldFollowDestination({
    url: 'https://community.example/join',
    currentUrl: 'https://creator.test/',
    anchorText: 'Read more',
  }).eligible, true);
});

test('known community hosts accept trailing-dot aliases', () => {
  assert.equal(isKnownCommunityDestinationHost('linktr.ee.'), true);
  assert.equal(isKnownCommunityDestinationHost('www.whop.com.'), true);
});

test('destination templates collapse only complete numeric path segments', () => {
  assert.equal(destinationTemplate('https://creator.test/page/2'), 'creator.test/page/:n');
  assert.equal(destinationTemplate('https://creator.test/community2'), 'creator.test/community2');
  assert.notEqual(destinationTemplate('https://creator.test/community2'), destinationTemplate('https://creator.test/community3'));
});

test('external-host children count against the seed-origin-aware page budget', () => {
  const budget = createDestinationBudget({ seedUrl: 'https://creator.test/', maxCrossOriginHosts: 3, maxPagesPerHost: 2 });
  assert.deepEqual(budget.reserve('https://creator.test/about', 'https://creator.test/'), { admitted: true, reason: 'same-origin' });
  assert.deepEqual(budget.reserve('https://a.example/1', 'https://creator.test/'), { admitted: true, reason: 'admitted' });
  assert.deepEqual(budget.reserve('https://a.example/2', 'https://a.example/1'), { admitted: true, reason: 'admitted' });
  assert.deepEqual(budget.reserve('https://a.example/3', 'https://a.example/2'), { admitted: false, reason: 'page-budget' });
});

test('a redirected creator root origin stays exempt from the destination page budget', async () => {
  const fetched: string[] = [];
  const fetchedResponse = (body: string, url: string) => {
    const response = htmlResponse(body);
    Object.defineProperty(response, 'url', { value: url });
    return response;
  };
  const result = await crawlExternalLinks(
    ['https://creator.test/'],
    [],
    undefined,
    (async (input) => {
      const url = String(input);
      fetched.push(url);
      if (url === 'https://creator.test/') {
        return fetchedResponse(
          '<a href="/one">one</a><a href="/two">two</a><a href="/three">three</a>',
          'https://www.creator.test/',
        );
      }
      return fetchedResponse('<html><body>No invite here</body></html>', url);
    }) as typeof fetch,
  );
  assert.ok(fetched.includes('https://www.creator.test/one'), 'root redirect target keeps its own same-origin children free');
  assert.ok(fetched.includes('https://www.creator.test/two'));
  assert.ok(fetched.includes('https://www.creator.test/three'), 'the third same-origin child is not charged to the external-host page budget');
  assert.equal(result.outcome, 'INSPECTED_NO_MATCH');
});

test('per-seed destination budget bounds cross-origin fan-out but never blocks same-origin', () => {
  const budget = createDestinationBudget({ maxCrossOriginHosts: 3, maxPagesPerHost: 2 });
  assert.deepEqual(budget.reserve('https://a.example/1', 'https://creator.test/'), { admitted: true, reason: 'admitted' });
  assert.deepEqual(budget.reserve('https://a.example/2', 'https://creator.test/'), { admitted: true, reason: 'admitted' });
  assert.deepEqual(budget.reserve('https://a.example/3', 'https://creator.test/'), { admitted: false, reason: 'page-budget' });
  assert.deepEqual(budget.reserve('https://b.example/1', 'https://creator.test/'), { admitted: true, reason: 'admitted' });
  assert.deepEqual(budget.reserve('https://c.example/1', 'https://creator.test/'), { admitted: true, reason: 'admitted' });
  assert.deepEqual(budget.reserve('https://d.example/1', 'https://creator.test/'), { admitted: false, reason: 'host-budget' });
  assert.deepEqual(budget.reserve('https://creator.test/anything', 'https://creator.test/root'), { admitted: true, reason: 'same-origin' });
  // Repeated identical destination is idempotent, not a new page.
  assert.deepEqual(budget.reserve('https://a.example/1', 'https://creator.test/'), { admitted: true, reason: 'admitted' });
});

test('destination-budget is a first-class drop reason in the taxonomy', () => {
  assert.ok((CRAWL_DROP_REASONS as readonly string[]).includes('destination-budget'));
  assert.ok((CRAWL_DROP_REASONS as readonly string[]).includes('exploration-limit'));
});

/**
 * Named report regression: https://www.swingfish.trade/discord is a community
 * destination that does not use a familiar invite format. It must be reached
 * and yield the Discord invite in all three acquisition shapes.
 */
test('swingfish regression: evidenced second-hop cross-domain /discord page is fetched and yields the invite', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url === 'https://creator.test/') return htmlResponse('<a href="https://www.swingfish.trade/discord">Join our Discord</a>');
    if (url === 'https://www.swingfish.trade/discord') return htmlResponse('<html><body>Community invite: https://discord.gg/swingfish</body></html>');
    return htmlResponse('<p>leaf</p>');
  }) as typeof fetch;
  const result = await crawlExternalLinks(['https://creator.test/'], [], undefined, fetchImpl);
  assert.ok(calls.includes('https://www.swingfish.trade/discord'), 'the evidenced cross-domain /discord page is fetched');
  assert.equal(result.outcome, 'FOUND');
  assert.deepEqual(result.candidates.map(candidate => candidate.nativeInviteCode), ['swingfish']);
});

test('swingfish regression: /discord that redirects into a Discord invite URL is captured', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url === 'https://creator.test/') return htmlResponse('<a href="https://www.swingfish.trade/discord">Discord</a>');
    if (url === 'https://www.swingfish.trade/discord') {
      const response = new Response('<html><body>Welcome to the community</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
      Object.defineProperty(response, 'url', { value: 'https://discord.gg/swingfish' });
      return response;
    }
    return htmlResponse('<p>leaf</p>');
  }) as typeof fetch;
  const result = await crawlExternalLinks(['https://creator.test/'], [], undefined, fetchImpl);
  assert.equal(result.outcome, 'FOUND');
  assert.deepEqual(result.candidates.map(candidate => candidate.nativeInviteCode), ['swingfish']);
});

test('swingfish regression: a direct /discord seed is inspected without a familiar invite format', async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === 'https://www.swingfish.trade/discord') return htmlResponse('<html><body>Join us: https://discord.gg/swingfish</body></html>');
    return htmlResponse('<p>leaf</p>');
  }) as typeof fetch;
  const result = await crawlExternalLinks(['https://www.swingfish.trade/discord'], [], undefined, fetchImpl);
  assert.equal(result.outcome, 'FOUND');
  assert.deepEqual(result.candidates.map(candidate => candidate.nativeInviteCode), ['swingfish']);
});

test('evidenced cross-domain destination that exhausts the per-seed budget keeps the ceiling visible', async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === 'https://creator.test/') {
      return htmlResponse(
        '<a href="https://hop-one.example/join">Join our Discord</a>' +
        '<a href="https://hop-two.example/join">Join our Discord</a>' +
        '<a href="https://hop-three.example/join">Join our Discord</a>' +
        '<a href="https://hop-four.example/join">Join our Discord</a>',
      );
    }
    return htmlResponse('<p>no invite here</p>');
  }) as typeof fetch;
  const result = await crawlExternalLinks(['https://creator.test/'], [], undefined, fetchImpl);
  const seed = result.observations.find(item => item.requestedUrl === 'https://creator.test/');
  assert.ok(seed, 'seed observation exists');
  assert.equal(seed?.outcome, 'PARTIALLY_INSPECTED', 'budget skips are never a clean absence');
  assert.deepEqual((seed?.telemetry as { ceiling?: unknown })?.ceiling, { kind: 'exploration-limit' });
  assert.ok((seed?.telemetry?.dropReasons?.['destination-budget'] || 0) >= 1, 'the skipped evidenced destination is accounted');
});
