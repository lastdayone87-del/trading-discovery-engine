import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SITE_PROFILER_POLICY_VERSION,
  MAX_SITEMAP_INDEX_FILES,
  MAX_SITEMAP_URLS_ADMITTED,
  MAX_FEEDS_PER_SITE,
  MAX_FEED_ENTRIES,
  MAX_PROFILER_REDIRECT_HOPS,
  parseRobotsTxt,
  evaluateRobotsForPath,
  parseSitemapXml,
  parseFeedXml,
  extractHeadDiscovery,
  classifyPageType,
  classifyCanonicalHref,
  isSiteProfilerEnabled,
  fetchProfilerUrl,
  runSiteProfiler,
} from './siteProfiler';

test('robots parser handles groups, rules, sitemaps, and malformed lines leniently', () => {
  const parsed = parseRobotsTxt([
    'User-agent: *',
    'Disallow: /private/',
    'Allow: /private/public',
    'Crawl-delay: 2',
    '',
    'User-agent: trading-discovery-engine',
    'Disallow: /',
    'Sitemap: https://example.com/sitemap.xml',
    'this line has no colon and is malformed',
    'X-Custom-Thing: ignored without breaking anything',
  ].join('\n'));
  assert.equal(parsed.groups.length, 2);
  assert.equal(parsed.sitemaps.length, 1);
  assert.equal(parsed.malformed, true);
});

test('robots evaluation applies longest-match wins with agent scoping', () => {
  const parsed = parseRobotsTxt([
    'User-agent: *',
    'Disallow: /private/',
    'Allow: /private/public',
    'User-agent: trading-discovery-engine',
    'Disallow: /',
  ].join('\n'));
  assert.deepEqual(evaluateRobotsForPath(parsed, 'trading-discovery-engine', '/x'), {
    allowed: false, crawlDelaySeconds: null, matchedRule: 'Disallow: /',
  });
  assert.deepEqual(evaluateRobotsForPath(parsed, 'other-bot', '/private/public/page'), {
    allowed: true, crawlDelaySeconds: null, matchedRule: 'Allow: /private/public',
  });
  assert.deepEqual(evaluateRobotsForPath(parsed, 'other-bot', '/private/secret'), {
    allowed: false, crawlDelaySeconds: null, matchedRule: 'Disallow: /private/',
  });
  assert.deepEqual(evaluateRobotsForPath(parsed, 'other-bot', '/open'), {
    allowed: true, crawlDelaySeconds: null, matchedRule: null,
  });
  assert.deepEqual(evaluateRobotsForPath({ groups: [], sitemaps: [], malformed: false }, 'x', '/y'), {
    allowed: null, crawlDelaySeconds: null, matchedRule: null,
  }, 'no applicable group is unknown, never a negative');
});

test('sitemap index expansion is bounded and same-host enforced', () => {
  const entries = Array.from({ length: MAX_SITEMAP_INDEX_FILES + 5 }, (_, i) => `<sitemap><loc>https://example.com/s${i}.xml</loc></sitemap>`).join('');
  const parsed = parseSitemapXml(
    `<?xml version="1.0"?><sitemapindex>${entries}<sitemap><loc>https://evil.example.net/s9.xml</loc></sitemap></sitemapindex>`,
    'https://example.com/sitemap.xml',
  );
  assert.equal(parsed.kind, 'index');
  assert.equal(parsed.nestedSitemaps.length, MAX_SITEMAP_INDEX_FILES);
  assert.equal(parsed.droppedOffHost, 1, 'off-host entries dropped, never followed');
  assert.equal(parsed.droppedOverCap, 5, 'over-cap entries counted, never silently kept');
});

test('sitemap urlsets admit capped same-host URLs with lastmod preserved', () => {
  const items = Array.from({ length: MAX_SITEMAP_URLS_ADMITTED + 3 }, (_, i) =>
    `<url><loc>https://example.com/p${i}</loc><lastmod>2026-01-0${(i % 9) + 1}</lastmod></url>`).join('');
  const parsed = parseSitemapXml(
    `<?xml version="1.0"?><urlset>${items}<url><loc>https://other.example.net/p</loc></url></urlset>`,
    'https://example.com/sitemap.xml',
  );
  assert.equal(parsed.kind, 'urlset');
  assert.equal(parsed.urls.length, MAX_SITEMAP_URLS_ADMITTED);
  assert.equal(parsed.droppedOffHost, 1);
  assert.equal(parsed.droppedOverCap, 3);
  assert.equal(parsed.urls[0].lastmod, '2026-01-01');
  assert.deepEqual(parseSitemapXml('not xml at all {{{', 'https://example.com/sitemap.xml').kind, 'unknown');
  assert.deepEqual(parseSitemapXml('<html><body>hi</body></html>', 'https://example.com/sitemap.xml').kind, 'unknown');
});

test('feeds parse RSS, Atom, and JSON with bounded entries', () => {
  const rssItems = Array.from({ length: MAX_FEED_ENTRIES + 10 }, (_, i) =>
    `<item><title>T${i}</title><link>https://example.com/a${i}</link><pubDate>Mon, 01 Jan 2026 00:00:00 GMT</pubDate></item>`).join('');
  const rss = parseFeedXml(
    `<?xml version="1.0"?><rss version="2.0"><channel><title>Blog</title>${rssItems}</channel></rss>`,
    'https://example.com/feed',
  );
  assert.equal(rss.format, 'rss');
  assert.equal(rss.title, 'Blog');
  assert.equal(rss.entries.length, MAX_FEED_ENTRIES);
  assert.equal(rss.truncated, true);
  assert.equal(rss.entries[0].title, 'T0');

  const atom = parseFeedXml(
    `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>A</title>` +
    `<link rel="self" href="https://example.com/atom"/><entry><title>E</title>` +
    `<link rel="alternate" href="https://example.com/e1"/><published>2026-02-01T00:00:00Z</published></entry></feed>`,
    'https://example.com/atom',
  );
  assert.equal(atom.format, 'atom');
  assert.equal(atom.selfLink, 'https://example.com/atom');
  assert.deepEqual(atom.entries, [{ url: 'https://example.com/e1', title: 'E', published: '2026-02-01T00:00:00Z' }]);
  assert.equal(atom.truncated, false);

  const json = parseFeedXml(
    JSON.stringify({
      version: 'https://jsonfeed.org/version/1.1', title: 'J',
      items: [{ url: 'https://example.com/j1', title: 'J1', date_published: '2026-03-01T00:00:00Z' }, { title: 'no-url' }],
    }),
    'https://example.com/feed.json',
  );
  assert.equal(json.format, 'json');
  assert.equal(json.entries.length, 1);

  assert.equal(parseFeedXml('<html><body>no feed here</body></html>', 'https://example.com/').format, 'unknown');
  assert.equal(parseFeedXml('{{{', 'https://example.com/').format, 'unknown');
});

test('head discovery inventories canonicals, feeds, robots meta, and structured data', () => {
  const head = extractHeadDiscovery(
    `<html><head>
      <link rel="canonical" href="https://example.com/a">
      <link rel="canonical" href="https://example.com/a">
      <link rel="alternate" type="application/rss+xml" href="/feed">
      <link rel="alternate" type="application/atom+xml" href="https://example.com/atom">
      <meta name="robots" content="noindex, follow">
      <script type="application/ld+json">{"@type": "NewsArticle", "author": {"@type": "Person"}, "sameAs": ["https://shop.example.com/brand", "/relative-sameas"]}</script>
      <script type="application/ld+json">{"@graph": [{"@type": "Organization"}, {"@type": "WebSite"}]}</script>
      <script type="application/ld+json">not json {{{</script>
    </head><body>
      <header><a href="/about">About</a><a href="https://other.example.net/x">Out</a></header>
      <div itemscope itemtype="https://schema.org/Product"></div>
      <div vocab="https://schema.org/" typeof="Blog"></div>
    </body></html>`,
    'https://example.com/a',
  );
  assert.deepEqual(head.canonicalHrefs, ['https://example.com/a'], 'canonicals deduped, recorded unresolved');
  assert.equal(head.feedLinks.length, 2);
  assert.equal(head.robotsMeta, 'noindex, follow');
  assert.ok(head.jsonLdTypes.includes('NewsArticle'));
  assert.ok(head.jsonLdTypes.includes('Person'));
  assert.ok(head.jsonLdTypes.includes('Organization'));
  assert.deepEqual(head.jsonLdSameAs, ['https://shop.example.com/brand', 'https://example.com/relative-sameas']);
  assert.equal(head.jsonLdUnparsable, 1);
  assert.equal(head.microdataItems, 1);
  assert.equal(head.rdfaItems, 1);
  assert.equal(head.navSameHostLinks, 1, 'only same-host header/nav/main anchors counted');
});

test('canonical classification never merges: self, upward, cross-host, unresolvable', () => {
  assert.equal(classifyCanonicalHref('https://example.com/a', 'https://example.com/a'), 'self');
  assert.equal(classifyCanonicalHref('/root', 'https://example.com/a/b'), 'upward');
  assert.equal(classifyCanonicalHref('https://other.example.net/a', 'https://example.com/a'), 'cross-host');
  assert.equal(classifyCanonicalHref('https://exa mple.com/%', 'https://example.com/a'), 'unresolvable');
});

test('page-type prior is deterministic with UNKNOWN default', () => {
  const base = { sitemapUrls: 0, hasFeed: false, navSameHostLinks: 0, pathDepth: 0 };
  assert.equal(classifyPageType({ ...base, jsonLdTypes: ['NewsArticle'] }), 'ARTICLE');
  assert.equal(classifyPageType({ ...base, jsonLdTypes: ['Person'], pathDepth: 2 }), 'PROFILE');
  assert.equal(classifyPageType({ ...base, jsonLdTypes: ['ItemList'] }), 'LISTING');
  assert.equal(classifyPageType({ ...base, jsonLdTypes: [], sitemapUrls: 500 }), 'LISTING');
  assert.equal(classifyPageType({ ...base, jsonLdTypes: ['Organization'], navSameHostLinks: 12 }), 'HUB');
  assert.equal(classifyPageType({ ...base, jsonLdTypes: [] }), 'UNKNOWN');
  assert.equal(
    classifyPageType({ ...base, jsonLdTypes: ['NewsArticle'] }),
    classifyPageType({ ...base, jsonLdTypes: ['NewsArticle'] }),
    'deterministic',
  );
});

test('profiler stays disabled by default and fetches nothing when off', async () => {
  assert.equal(await isSiteProfilerEnabled(async () => 'false'), false);
  assert.equal(await isSiteProfilerEnabled(async () => 'true'), true);
  let fetched = 0;
  const result = await runSiteProfiler(
    { siteIdentity: 'example.com', identityTier: 'A', seedUrl: 'https://example.com/' },
    { fetchImpl: (async () => { fetched += 1; throw new Error('must not fetch'); }) as typeof fetch },
    async () => false,
  );
  assert.deepEqual(result, { status: 'DISABLED', profile: null });
  assert.equal(fetched, 0);
});

function makeFetch(routes: Record<string, { status: number; body: string; contentType?: string; url?: string }>) {
  const calls: string[] = [];
  const fetchImpl = (async (url: unknown) => {
    const target = String(url);
    calls.push(target);
    const route = routes[target];
    if (!route) return new Response('missing', { status: 404, headers: { 'content-type': 'text/plain' } });
    const response = new Response(route.body, {
      status: route.status,
      headers: { 'content-type': route.contentType || 'text/html' },
    });
    if (route.url) Object.defineProperty(response, 'url', { value: route.url });
    return response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const HOMEPAGE = `<html><head>
<link rel="canonical" href="https://example.com/">
<link rel="alternate" type="application/rss+xml" href="/feed">
<script type="application/ld+json">{"@type": "Organization"}</script>
</head><body><header><a href="/about">About</a></header></body></html>`;
const SITEMAP = `<?xml version="1.0"?><urlset><url><loc>https://example.com/about</loc></url></urlset>`;
const FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>B</title><item><title>I</title><link>https://example.com/i1</link></item></channel></rss>`;
const ROBOTS = `User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap.xml\n`;

test('profiler assembles a provenance-complete inventory from bounded fetches', async () => {
  const { fetchImpl, calls } = makeFetch({
    'https://example.com/robots.txt': { status: 200, body: ROBOTS, contentType: 'text/plain' },
    'https://example.com/': { status: 200, body: HOMEPAGE },
    'https://example.com/sitemap.xml': { status: 200, body: SITEMAP, contentType: 'application/xml' },
    'https://example.com/feed': { status: 200, body: FEED, contentType: 'application/rss+xml' },
  });
  const result = await runSiteProfiler(
    { siteIdentity: 'example.com', identityTier: 'A', seedUrl: 'https://example.com/' },
    { fetchImpl, now: () => '2026-10-01T00:00:00.000Z' },
    async () => true,
  );
  assert.equal(result.status, 'PROFILED');
  const profile = result.profile!;
  assert.equal(profile.policyVersion, SITE_PROFILER_POLICY_VERSION);
  assert.deepEqual(profile.robotsFetch, { state: 'FETCHED', status: 200, fetchedAt: '2026-10-01T00:00:00.000Z' });
  assert.equal(profile.robotsEvaluation.allowed, true);
  assert.deepEqual(profile.robotsSitemaps, ['https://example.com/sitemap.xml']);
  assert.equal(profile.sitemaps.length, 1);
  assert.equal(profile.sitemaps[0].urls.length, 1);
  assert.equal(profile.feeds.length, 1);
  assert.equal(profile.feeds[0].entries.length, 1);
  assert.deepEqual(profile.canonicalConflicts, [{
    declaredHref: 'https://example.com/',
    source: 'link-tag',
    kind: 'self',
    agreesWithObserved: null,
  }], 'canonical recorded with null agreement, never resolved here');
  assert.equal(profile.pageType, 'HUB');
  for (const [field, proof] of Object.entries(profile.provenance)) {
    assert.ok(proof.sourceUrl && proof.fetchedAt && proof.method, `provenance complete for ${field}`);
  }
  assert.ok(calls.length <= 8, `bounded inventory fetches, got ${calls.length}`);
});

test('profiler records robots fetch states without turning failures into negatives', async () => {
  const states: Array<[number | 'throw', string]> = [
    [404, 'UNAVAILABLE_4XX'],
    [500, 'UNREACHABLE'],
    [429, 'RATE_LIMITED'],
    ['throw', 'UNREACHABLE'],
  ];
  for (const [status, expected] of states) {
    const fetchImpl = (async (url: unknown) => {
      if (String(url).endsWith('/robots.txt')) {
        if (status === 'throw') throw new Error('down');
        return new Response('x', { status: status as number, headers: { 'content-type': 'text/plain' } });
      }
      return new Response('<html><body>hi</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    }) as typeof fetch;
    const result = await runSiteProfiler(
      { siteIdentity: 'example.com', identityTier: 'A', seedUrl: 'https://example.com/' },
      { fetchImpl, now: () => '2026-10-01T00:00:00.000Z' },
      async () => true,
    );
    assert.equal(result.profile!.robotsFetch.state, expected, `robots ${status} -> ${expected}`);
    assert.equal(result.profile!.robotsEvaluation.allowed, null, 'no policy evaluated means unknown, never negative');
  }
});

test('migration 135 creates the additive site_profiles table only', () => {
  const raw = readFileSync(new URL('./db/migrations/135_site_profiler.sql', import.meta.url), 'utf8');
  const ddl = raw.split('\n').filter(line => !line.trim().startsWith('--')).join('\n');
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS site_profiles/);
  assert.match(ddl, /site_identity TEXT PRIMARY KEY/);
  assert.doesNotMatch(ddl, /DROP TABLE|ALTER TABLE|BACKFILL|UPDATE\s+\w+\s+SET/i);
});

test('robots group selection prefers the most specific matching token', () => {
  const parsed = parseRobotsTxt([
    'User-agent: trade',
    'Disallow: /everything',
    'User-agent: trading-discovery-engine',
    'Disallow: /nothing-here',
    'User-agent: *',
    'Disallow: /fallback',
  ].join('\n'));
  assert.deepEqual(evaluateRobotsForPath(parsed, 'trading-discovery-engine', '/nothing-here/deep').matchedRule, 'Disallow: /nothing-here');
  assert.deepEqual(evaluateRobotsForPath(parsed, 'trading-discovery-engine', '/everything'), {
    allowed: true, crawlDelaySeconds: null, matchedRule: null,
  }, 'specific group wins: the shorter token group must not govern this agent');
  assert.deepEqual(evaluateRobotsForPath(parsed, 'trade-winds', '/everything').matchedRule, 'Disallow: /everything');
  assert.deepEqual(evaluateRobotsForPath(parsed, 'unrelated-bot', '/fallback').matchedRule, 'Disallow: /fallback');
});

test('robots wildcards constrain the suffix and honor end anchors', () => {
  const parsed = parseRobotsTxt(['User-agent: *', 'Allow: /public/*.html', 'Disallow: /public/', 'Disallow: /exact$'].join('\n'));
  assert.equal(evaluateRobotsForPath(parsed, 'x', '/public/page.html').allowed, true);
  assert.equal(evaluateRobotsForPath(parsed, 'x', '/public/secret').allowed, false, 'suffix after wildcard still constrains');
  assert.equal(evaluateRobotsForPath(parsed, 'x', '/exact').allowed, false);
  assert.equal(evaluateRobotsForPath(parsed, 'x', '/exact/more').allowed, true, 'end anchor respected');
});

test('bare wildcards never override explicit allows of any length', () => {
  const parsed = parseRobotsTxt(['User-agent: *', 'Disallow: /*', 'Allow: /public/page'].join('\n'));
  const verdict = evaluateRobotsForPath(parsed, 'x', '/public/page');
  assert.equal(verdict.allowed, true, 'concrete allow outranks spanning disallow');
  assert.equal(verdict.matchedRule, 'Allow: /public/page');
  assert.equal(evaluateRobotsForPath(parsed, 'x', '/other').allowed, false, 'wildcard still governs unmatched paths');
  const tied = parseRobotsTxt(['User-agent: *', 'Disallow: /x', 'Allow: /x'].join('\n'));
  assert.equal(evaluateRobotsForPath(tied, 'x', '/x').allowed, true, 'exact ties resolve to Allow');
});

test('wildcard disallow with literal suffix outranks a generic allow', () => {
  // Regression pin: `/*a` carries two constraining octets (`/a`) against
  // `/`'s one, so the disallow governs `/x/y/z/a`. Literal specificity —
  // not spanned text length — orders the match.
  const parsed = parseRobotsTxt(['User-agent: *', 'Disallow: /*a', 'Allow: /'].join('\n'));
  const verdict = evaluateRobotsForPath(parsed, 'x', '/x/y/z/a');
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.matchedRule, 'Disallow: /*a');
  assert.equal(evaluateRobotsForPath(parsed, 'x', '/x/y/z/b').allowed, true, 'non-matching suffix stays allowed');
});

test('profiler fetch identity is single-sourced for requests and evaluation', async () => {
  const { PROFILER_USER_AGENT, profilerFetchHeaders } = await import('./siteProfiler');
  assert.ok(PROFILER_USER_AGENT.includes('Mozilla'));
  assert.equal(profilerFetchHeaders()['User-Agent'], PROFILER_USER_AGENT);
});

test('feed autolinks resolve against the fetched final URL after redirects', async () => {
  const fetched: string[] = [];
  const fetchImpl = (async (url: unknown) => {
    const target = String(url);
    fetched.push(target);
    if (target === 'https://short.example/x') {
      const response = new Response('<html><head><link rel="alternate" type="application/rss+xml" href="/feed"></head><body>hi</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
      Object.defineProperty(response, 'url', { value: 'https://dest.example/landing' });
      return response;
    }
    return new Response('missing', { status: 404, headers: { 'content-type': 'text/plain' } });
  }) as typeof fetch;
  const result = await runSiteProfiler(
    { siteIdentity: 'short.example', identityTier: 'A', seedUrl: 'https://short.example/x' },
    { fetchImpl, now: () => '2026-10-01T00:00:00.000Z', resolveHost: async () => ['93.184.216.1'] },
    async () => true,
  );
  assert.ok(fetched.includes('https://dest.example/feed'), 'relative feed resolved against the destination, not the seed');
  assert.ok(!fetched.includes('https://short.example/feed'), 'seed-host feed never requested after a cross-host redirect');
  assert.deepEqual(result.profile!.feeds, [], 'unparseable/missing feeds yield no inventory, not errors');
});

test('feed fetch attempts are bounded even when every candidate fails', async () => {
  const { MAX_FEEDS_PER_SITE } = await import('./siteProfiler');
  let attempts = 0;
  const fetchImpl = (async (url: unknown) => {
    const target = String(url);
    if (target.endsWith('/robots.txt')) {
      return new Response('User-agent: *\nAllow: /', { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    if (target === 'https://example.com/') {
      const links = Array.from({ length: 10 }, (_, i) => `<link rel="alternate" type="application/rss+xml" href="/f${i}">`).join('');
      return new Response(`<html><head>${links}</head><body>hi</body></html>`, { status: 200, headers: { 'content-type': 'text/html' } });
    }
    if (/\/f\d+$/.test(target)) attempts += 1;
    return new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } });
  }) as typeof fetch;
  const result = await runSiteProfiler(
    { siteIdentity: 'example.com', identityTier: 'A', seedUrl: 'https://example.com/' },
    { fetchImpl, now: () => '2026-10-01T00:00:00.000Z', resolveHost: async () => ['93.184.216.1'] },
    async () => true,
  );
  assert.ok(attempts <= MAX_FEEDS_PER_SITE + 1, `feed attempts bounded, got ${attempts}`);
  assert.equal(result.profile!.feeds.length, 0);
});

test('guard-rejected feed candidates consume budget instead of looping unbounded', async () => {
  const { MAX_FEEDS_PER_SITE } = await import('./siteProfiler');
  let guardChecks = 0;
  const fetchImpl = (async (url: unknown) => {
    const target = String(url);
    if (target.endsWith('/robots.txt')) {
      return new Response('User-agent: *\nAllow: /', { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    if (target === 'https://example.com/') {
      // Ten autolinked feeds, every one aimed at a private address: without
      // budget accounting the profiler would DNS-check all ten.
      const links = Array.from({ length: 10 }, (_, i) => `<link rel="alternate" type="application/rss+xml" href="http://10.0.0.${i + 1}/feed${i}">`).join('');
      return new Response(`<html><head>${links}</head><body>hi</body></html>`, { status: 200, headers: { 'content-type': 'text/html' } });
    }
    return new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } });
  }) as typeof fetch;
  const result = await runSiteProfiler(
    { siteIdentity: 'example.com', identityTier: 'A', seedUrl: 'https://example.com/' },
    {
      fetchImpl,
      now: () => '2026-10-01T00:00:00.000Z',
      resolveHost: async (host: string) => {
        if (host === 'example.com') return ['93.184.216.1'];
        guardChecks += 1;
        return ['10.9.9.9'];
      },
    },
    async () => true,
  );
  assert.ok(guardChecks <= MAX_FEEDS_PER_SITE + 1, `guard checks bounded, got ${guardChecks}`);
  assert.equal(result.profile!.feeds.length, 0, 'no private feed ever inventoried');
});

test('destination robots policy governs destination feeds after a cross-host redirect', async () => {
  const fetched: string[] = [];
  const fetchImpl = (async (url: unknown) => {
    const target = String(url);
    fetched.push(target);
    if (target === 'https://short.example/robots.txt') {
      return new Response('User-agent: *\nAllow: /', { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    if (target === 'https://short.example/x') {
      const response = new Response('<html><head><link rel="alternate" type="application/rss+xml" href="/feed"></head><body>hi</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
      Object.defineProperty(response, 'url', { value: 'https://dest.example/landing' });
      return response;
    }
    if (target === 'https://dest.example/robots.txt') {
      return new Response('User-agent: *\nDisallow: /feed\nDisallow: /rss.xml\nDisallow: /atom.xml\n', { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    return new Response('missing', { status: 404, headers: { 'content-type': 'text/plain' } });
  }) as typeof fetch;
  const result = await runSiteProfiler(
    { siteIdentity: 'short.example', identityTier: 'A', seedUrl: 'https://short.example/x' },
    { fetchImpl, now: () => '2026-10-01T00:00:00.000Z', resolveHost: async () => ['93.184.216.1'] },
    async () => true,
  );
  assert.ok(fetched.includes('https://dest.example/robots.txt'), 'destination policy resolved before probing its feeds');
  assert.ok(!fetched.includes('https://dest.example/feed'), 'disallowed destination feed never requested');
  assert.deepEqual(result.profile!.feeds, [], 'policy-blocked feeds yield no inventory, not errors');
});

test('unreachable destination policy fails closed for destination probes only', async () => {
  const fetched: string[] = [];
  const fetchImpl = (async (url: unknown) => {
    const target = String(url);
    fetched.push(target);
    if (target === 'https://short.example/robots.txt') {
      return new Response('User-agent: *\nAllow: /', { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    if (target === 'https://short.example/x') {
      const response = new Response('<html><head><link rel="alternate" type="application/rss+xml" href="/feed"></head><body>hi</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
      Object.defineProperty(response, 'url', { value: 'https://dest.example/landing' });
      return response;
    }
    if (target === 'https://dest.example/robots.txt') throw new Error('destination policy unreachable');
    return new Response('missing', { status: 404, headers: { 'content-type': 'text/plain' } });
  }) as typeof fetch;
  const result = await runSiteProfiler(
    { siteIdentity: 'short.example', identityTier: 'A', seedUrl: 'https://short.example/x' },
    { fetchImpl, now: () => '2026-10-01T00:00:00.000Z', resolveHost: async () => ['93.184.216.1'] },
    async () => true,
  );
  assert.ok(!fetched.includes('https://dest.example/feed'), 'unknown destination policy means no destination probing');
  assert.ok(result.profile!.head !== null, 'seed inventory itself still recorded');
});

test('robots disallow, rate limit, and unreachable states stop further fetching', async () => {
  const gated = async (robotsBody: string | null, robotsStatus: number | 'throw') => {
    const fetched: string[] = [];
    const fetchImpl = (async (url: unknown) => {
      const target = String(url);
      fetched.push(target);
      if (target.endsWith('/robots.txt')) {
        if (robotsStatus === 'throw') throw new Error('down');
        return new Response(robotsBody || '', { status: robotsStatus as number, headers: { 'content-type': 'text/plain' } });
      }
      return new Response('<html><body>hi</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    }) as typeof fetch;
    const result = await runSiteProfiler(
      { siteIdentity: 'example.com', identityTier: 'A', seedUrl: 'https://example.com/' },
      { fetchImpl, now: () => '2026-10-01T00:00:00.000Z', resolveHost: async () => ['93.184.216.1'] },
      async () => true,
    );
    return { profile: result.profile!, fetched };
  };
  const disallowed = await gated('User-agent: *\nDisallow: /', 200);
  assert.deepEqual(disallowed.fetched, ['https://example.com/robots.txt'], 'disallowed seed stops everything else');
  assert.equal(disallowed.profile.head, null);
  assert.equal(disallowed.profile.sitemaps.length, 0);
  assert.deepEqual(disallowed.profile.robotsSitemaps, [], 'no sitemap records advertised, none recorded');
  const limited = await gated('User-agent: *\nAllow: /', 429);
  assert.equal(limited.profile.robotsFetch.state, 'RATE_LIMITED');
  assert.deepEqual(limited.fetched, ['https://example.com/robots.txt'], 'rate limit yields instead of hammering on');
  const down = await gated(null, 'throw');
  assert.equal(down.profile.robotsFetch.state, 'UNREACHABLE');
  assert.deepEqual(down.fetched, ['https://example.com/robots.txt']);
});

test('destination guard blocks private targets while passing public ones', async () => {
  const { isPublicIpAddress, isPublicInternetUrl } = await import('./siteProfiler');
  for (const privateIp of ['127.0.0.1', '10.0.0.5', '172.16.0.9', '172.31.255.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', '::', 'fe80::1', 'fc00::9', 'ff02::1', '::ffff:10.1.2.3', '224.0.0.1', '999.1.1.1']) {
    assert.equal(isPublicIpAddress(privateIp), false, `${privateIp} is not public`);
  }
  for (const publicIp of ['93.184.216.1', '8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
    assert.equal(isPublicIpAddress(publicIp), true, `${publicIp} is public`);
  }
  const resolve = async (host: string) => {
    if (host === 'internal.example') return ['10.9.9.9'];
    if (host === 'dead.example') throw new Error('NXDOMAIN');
    return ['93.184.216.1'];
  };
  assert.equal(await isPublicInternetUrl('https://public.example/x', resolve), true);
  assert.equal(await isPublicInternetUrl('https://internal.example/x', resolve), false, 'resolving private fails closed');
  assert.equal(await isPublicInternetUrl('https://dead.example/x', resolve), false, 'resolution failure fails closed');
  assert.equal(await isPublicInternetUrl('http://127.0.0.1/latest/meta-data', resolve), false, 'literal metadata address blocked');
  assert.equal(await isPublicInternetUrl('ftp://public.example/x', resolve), false, 'non-http schemes rejected');
  assert.equal(await isPublicInternetUrl('not a url', resolve), false);
});

test('guard-skipped sitemaps are never fetched; private landings are discarded', async () => {
  const fetched: string[] = [];
  const fetchImpl = (async (url: unknown) => {
    const target = String(url);
    fetched.push(target);
    if (target.endsWith('/robots.txt')) {
      return new Response('User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap.xml\n', { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    if (target.includes('sitemap.xml')) {
      const response = new Response(`<?xml version="1.0"?><urlset><url><loc>https://example.com/a</loc></url></urlset>`, { status: 200, headers: { 'content-type': 'application/xml' } });
      Object.defineProperty(response, 'url', { value: 'http://169.254.169.254/stolen' });
      return response;
    }
    return new Response('<html><body>hi</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
  }) as typeof fetch;
  const result = await runSiteProfiler(
    { siteIdentity: 'example.com', identityTier: 'A', seedUrl: 'https://example.com/' },
    { fetchImpl, now: () => '2026-10-01T00:00:00.000Z', resolveHost: async () => ['93.184.216.1'] },
    async () => true,
  );
  assert.equal(result.profile!.sitemaps.length, 0, 'private-landing sitemap discarded, never inventoried');
  assert.ok(!fetched.some(url => url.includes('169.254')), 'no request ever addressed the metadata service');
});

test('sitemap worklist caps total fetches and reports skipped locations', async () => {
  const advertised = Array.from({ length: MAX_SITEMAP_INDEX_FILES + 6 }, (_, i) => `https://example.com/s${i}.xml`);
  const fetchImpl = (async (url: unknown) => {
    const target = String(url);
    if (target.endsWith('/robots.txt')) {
      return new Response(`User-agent: *\nAllow: /\n${advertised.map(location => `Sitemap: ${location}`).join('\n')}\n`, { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    if (target.endsWith('.xml')) {
      return new Response(`<?xml version="1.0"?><urlset><url><loc>https://example.com/a</loc></url></urlset>`, { status: 200, headers: { 'content-type': 'application/xml' } });
    }
    return new Response('<html><body>hi</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
  }) as typeof fetch;
  const result = await runSiteProfiler(
    { siteIdentity: 'example.com', identityTier: 'A', seedUrl: 'https://example.com/' },
    { fetchImpl, now: () => '2026-10-01T00:00:00.000Z', resolveHost: async () => ['93.184.216.1'] },
    async () => true,
  );
  const profile = result.profile!;
  assert.ok(profile.sitemaps.length <= MAX_SITEMAP_INDEX_FILES + 1, 'fetch budget binding');
  assert.ok(profile.sitemapLocationsSkipped > 0, 'unreached locations counted, never silently absent');
  assert.equal(profile.sitemaps.length + profile.sitemapLocationsSkipped, advertised.length + 1, 'every advertised location accounted for');
});

test('truncation flags survive from fetch bytes to inventory records', async () => {
  const { parseSitemapXml, parseFeedXml, extractHeadDiscovery } = await import('./siteProfiler');
  assert.equal(parseSitemapXml(`<?xml version="1.0"?><urlset></urlset>`, 'https://example.com/s.xml', true).bodyTruncated, true);
  assert.equal(parseFeedXml(`<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>`, 'https://example.com/f', true).truncated, true);
  assert.equal(parseFeedXml(`<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>`, 'https://example.com/f', false).truncated, false);
  assert.equal(extractHeadDiscovery('<html><head></head><body></body></html>', 'https://example.com/', true).bodyTruncated, true);
  assert.equal(extractHeadDiscovery('<html><head></head><body></body></html>', 'https://example.com/').bodyTruncated, false);
});

/** Redirect-destination SSRF guard: redirects are followed manually with
 * each hop validated by the public-destination guard BEFORE contact.
 * Injected fetch + DNS only; no real network access. */
function makeRedirectHarness(routes: Record<string, { status: number; body?: string; headers?: Record<string, string> }>) {
  const requested: string[] = [];
  const fetchImpl = (async (url: unknown) => {
    const target = String(url);
    requested.push(target);
    const route = routes[target];
    if (!route) return new Response('missing', { status: 404, headers: { 'content-type': 'text/plain' } });
    return new Response(route.body ?? '', { status: route.status, headers: route.headers ?? { 'content-type': 'text/html' } });
  }) as typeof fetch;
  const resolveHost = async (host: string): Promise<string[]> => {
    if (host === 'public.example' || host === 'cdn.example') return ['93.184.216.1'];
    if (host === 'private.example') return ['10.9.9.9'];
    throw new Error(`NXDOMAIN ${host}`);
  };
  return { fetchImpl, requested, resolveHost };
}

test('direct public fetch succeeds with single-URL provenance', async () => {
  const { fetchImpl, requested, resolveHost } = makeRedirectHarness({
    'https://public.example/feed': { status: 200, body: 'hello' },
  });
  const fetched = await fetchProfilerUrl('https://public.example/feed', fetchImpl, 1000, 10_000, resolveHost);
  assert.equal(fetched!.status, 200);
  assert.equal(fetched!.text, 'hello');
  assert.equal(fetched!.finalUrl, 'https://public.example/feed');
  assert.deepEqual(fetched!.redirectsFollowed, ['https://public.example/feed']);
  assert.equal(fetched!.redirectRejected, false);
  assert.deepEqual(requested, ['https://public.example/feed']);
});

test('public redirect to public destination is followed to the final URL', async () => {
  const { fetchImpl, requested, resolveHost } = makeRedirectHarness({
    'https://public.example/feed': { status: 302, headers: { location: 'https://cdn.example/asset' } },
    'https://cdn.example/asset': { status: 200, body: 'final' },
  });
  const fetched = await fetchProfilerUrl('https://public.example/feed', fetchImpl, 1000, 10_000, resolveHost);
  assert.equal(fetched!.status, 200);
  assert.equal(fetched!.text, 'final');
  assert.equal(fetched!.finalUrl, 'https://cdn.example/asset');
  assert.deepEqual(fetched!.redirectsFollowed, ['https://public.example/feed', 'https://cdn.example/asset']);
  assert.equal(fetched!.redirectRejected, false);
  assert.deepEqual(requested, ['https://public.example/feed', 'https://cdn.example/asset']);
});

test('relative redirect Location resolves against the current URL', async () => {
  const { fetchImpl, requested, resolveHost } = makeRedirectHarness({
    'https://public.example/old': { status: 301, headers: { location: '/new' } },
    'https://public.example/new': { status: 200, body: 'moved' },
  });
  const fetched = await fetchProfilerUrl('https://public.example/old', fetchImpl, 1000, 10_000, resolveHost);
  assert.equal(fetched!.status, 200);
  assert.equal(fetched!.finalUrl, 'https://public.example/new');
  assert.equal(fetched!.redirectRejected, false);
  assert.deepEqual(requested, ['https://public.example/old', 'https://public.example/new']);
});

test('redirect to loopback is rejected before contact', async () => {
  const { fetchImpl, requested, resolveHost } = makeRedirectHarness({
    'https://public.example/feed': { status: 302, headers: { location: 'http://127.0.0.1:9000/admin' } },
  });
  const fetched = await fetchProfilerUrl('https://public.example/feed', fetchImpl, 1000, 10_000, resolveHost);
  assert.equal(fetched!.redirectRejected, true);
  assert.equal(fetched!.rejectedRedirect, 'http://127.0.0.1:9000/admin');
  assert.equal(fetched!.status, 302, 'typed limitation status preserved, not rewritten to NOT_FOUND');
  assert.deepEqual(requested, ['https://public.example/feed'], 'private destination never contacted');
});

test('redirect to RFC1918 private IPv4 is rejected before contact', async () => {
  const { fetchImpl, requested, resolveHost } = makeRedirectHarness({
    'https://public.example/feed': { status: 302, headers: { location: 'http://192.168.10.9/internal' } },
  });
  const fetched = await fetchProfilerUrl('https://public.example/feed', fetchImpl, 1000, 10_000, resolveHost);
  assert.equal(fetched!.redirectRejected, true);
  assert.deepEqual(requested, ['https://public.example/feed'], 'private destination never contacted');
});

test('redirect to link-local and reserved destinations is rejected', async () => {
  for (const destination of [
    'http://169.254.169.254/latest/meta-data',
    'http://[fe80::1]/x',
    'http://10.0.0.7/y',
  ]) {
    const { fetchImpl, requested, resolveHost } = makeRedirectHarness({
      'https://public.example/feed': { status: 302, headers: { location: destination } },
    });
    const fetched = await fetchProfilerUrl('https://public.example/feed', fetchImpl, 1000, 10_000, resolveHost);
    assert.equal(fetched!.redirectRejected, true, `${destination} rejected`);
    assert.deepEqual(requested, ['https://public.example/feed'], `${destination} never contacted`);
  }
});

test('redirect to DNS-resolving-private hostname is rejected before contact', async () => {
  const { fetchImpl, requested, resolveHost } = makeRedirectHarness({
    'https://public.example/feed': { status: 302, headers: { location: 'https://private.example/secret' } },
  });
  const fetched = await fetchProfilerUrl('https://public.example/feed', fetchImpl, 1000, 10_000, resolveHost);
  assert.equal(fetched!.redirectRejected, true);
  assert.deepEqual(requested, ['https://public.example/feed'], 'resolving-private hostname never contacted');
});

test('malformed redirect Location is rejected without contact', async () => {
  for (const location of ['http://[::1', 'https://exa mple.com/%']) {
    const { fetchImpl, requested, resolveHost } = makeRedirectHarness({
      'https://public.example/feed': { status: 302, headers: { location } },
    });
    const fetched = await fetchProfilerUrl('https://public.example/feed', fetchImpl, 1000, 10_000, resolveHost);
    // WHATWG URL parsing is lenient (spaces encode); unparseable inputs
    // throw while parseable-but-nonpublic inputs fail the guard. Both paths
    // reject before contact — never evidence, never NOT_FOUND-shaped.
    assert.equal(fetched!.redirectRejected, true, `${location} rejected`);
    assert.ok(fetched!.status === 302 || fetched === null, `${location} stays a limitation`);
    assert.deepEqual(requested, ['https://public.example/feed'], `${location} never contacted`);
  }
});

test('redirect chains remain bounded', async () => {
  const routes: Record<string, { status: number; body?: string; headers?: Record<string, string> }> = {};
  for (let i = 0; i < 10; i += 1) {
    routes[`https://public.example/hop${i}`] = { status: 302, headers: { location: `https://public.example/hop${i + 1}` } };
  }
  routes['https://public.example/hop10'] = { status: 200, body: 'too deep' };
  const { fetchImpl, requested, resolveHost } = makeRedirectHarness(routes);
  const fetched = await fetchProfilerUrl('https://public.example/hop0', fetchImpl, 1000, 10_000, resolveHost);
  assert.ok(requested.length <= MAX_PROFILER_REDIRECT_HOPS, `chain bounded, got ${requested.length} requests`);
  assert.ok(fetched!.redirectsFollowed.length <= MAX_PROFILER_REDIRECT_HOPS);
  assert.equal(fetched!.redirectRejected, false, 'exhaustion is a skip, not a rejection');
  assert.notEqual(fetched!.status, 200, 'capped chain never presents deep content as the fetch result');
});

test('feed redirect to private destination is skipped within attempt budget', async () => {
  const { MAX_FEEDS_PER_SITE: cap } = await import('./siteProfiler');
  const requested: string[] = [];
  const fetchImpl = (async (url: unknown) => {
    const target = String(url);
    requested.push(target);
    if (target.endsWith('/robots.txt')) {
      return new Response('User-agent: *\nAllow: /', { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    if (target === 'https://public.example/') {
      return new Response(
        '<html><head><link rel="alternate" type="application/rss+xml" href="/feed"></head><body>hi</body></html>',
        { status: 200, headers: { 'content-type': 'text/html' } },
      );
    }
    if (target === 'https://public.example/feed') {
      return new Response('', { status: 302, headers: { location: 'http://127.0.0.1/stolen' } });
    }
    return new Response('missing', { status: 404, headers: { 'content-type': 'text/plain' } });
  }) as typeof fetch;
  const result = await runSiteProfiler(
    { siteIdentity: 'public.example', identityTier: 'A', seedUrl: 'https://public.example/' },
    { fetchImpl, now: () => '2026-10-01T00:00:00.000Z', resolveHost: async () => ['93.184.216.1'] },
    async () => true,
  );
  assert.equal(result.status, 'PROFILED', 'rejected redirect is a limitation, not a profile failure');
  assert.deepEqual(result.profile!.feeds, [], 'redirect-rejected feed yields no inventory');
  assert.ok(!requested.some(url => url.includes('127.0.0.1')), 'private redirect target never contacted');
  const feedFetches = requested.filter(url => url === 'https://public.example/feed').length;
  assert.ok(feedFetches <= cap + 1, `feed attempt budget holds, got ${feedFetches}`);
});

test('stalled redirect DNS fails closed within the fetch budget', async () => {
  const requested: string[] = [];
  const fetchImpl = (async (url: unknown) => {
    const target = String(url);
    requested.push(target);
    if (target === 'https://public.example/feed') {
      return new Response('', { status: 302, headers: { location: 'https://slow.example/next' } });
    }
    return new Response('must never arrive', { status: 200, headers: { 'content-type': 'text/html' } });
  }) as typeof fetch;
  // Resolver stalls far beyond the fetch budget; the guard must fail
  // closed on budget instead of delaying inspection.
  const resolveHost = async (): Promise<string[]> => {
    await new Promise(resolve => setTimeout(resolve, 5000));
    return ['93.184.216.1'];
  };
  const startedAt = Date.now();
  const fetched = await fetchProfilerUrl('https://public.example/feed', fetchImpl, 1000, 60, resolveHost);
  const elapsed = Date.now() - startedAt;
  assert.equal(fetched!.redirectRejected, true, 'unknown (budget-exhausted) destination fails closed');
  assert.ok(!requested.some(url => url.includes('slow.example')), 'unvalidated destination never contacted');
  assert.ok(elapsed < 2000, `bounded by budget, took ${elapsed}ms`);
});

test('rejected redirect responses release their bodies', async () => {
  let cancelled = 0;
  const fetchImpl = (async (url: unknown) => {
    const target = String(url);
    if (target === 'https://public.example/feed') {
      const response = new Response('redirect body', { status: 302, headers: { location: 'http://127.0.0.1/x' } });
      const stream = response.body!;
      const original = stream.cancel.bind(stream);
      stream.cancel = () => {
        cancelled += 1;
        return original();
      };
      return response;
    }
    return new Response('missing', { status: 404, headers: { 'content-type': 'text/plain' } });
  }) as typeof fetch;
  const fetched = await fetchProfilerUrl(
    'https://public.example/feed', fetchImpl, 1000, 10_000, async () => ['93.184.216.1'],
  );
  assert.equal(fetched!.redirectRejected, true);
  assert.equal(cancelled, 1, 'rejected redirect body released, not left open');
});
