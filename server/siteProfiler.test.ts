import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SITE_PROFILER_POLICY_VERSION,
  MAX_SITEMAP_INDEX_FILES,
  MAX_SITEMAP_URLS_ADMITTED,
  MAX_FEEDS_PER_SITE,
  MAX_FEED_ENTRIES,
  parseRobotsTxt,
  evaluateRobotsForPath,
  parseSitemapXml,
  parseFeedXml,
  extractHeadDiscovery,
  classifyPageType,
  classifyCanonicalHref,
  isSiteProfilerEnabled,
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
