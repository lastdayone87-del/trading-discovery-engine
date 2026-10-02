/**
 * Frozen engine fixture corpus (P-C prerequisite for scorer/learner work).
 *
 * Recorded HTTP exchanges (no live fetching) covering every stratum the
 * architecture must handle. Fixtures are versioned and append-only: gaps
 * are filed as new fixtures, existing fixtures are never edited post-hoc
 * to favor an implementation. Expected labels use the engine outcome and
 * blocked-state vocabularies; the self-validation test enforces schema
 * and label discipline, not implementation behavior.
 */
export const ENGINE_FIXTURE_CORPUS_VERSION = 'engine-fixtures-v1';

export type FixtureStratum =
  | 'redirects'
  | 'canonical-conflicts'
  | 'robots-variants'
  | 'sitemap-rss'
  | 'structured-data-conflicts'
  | 'truncation'
  | 'blocked-states'
  | 'multi-page-navigation'
  | 'duplicate-pages'
  | 'known-negative-adversarial';

export type FixtureExpectedOutcome =
  | 'FOUND'
  | 'INSPECTED_NO_MATCH'
  | 'PARTIALLY_INSPECTED'
  | 'ACQUISITION_FAILED'
  | 'BLOCKED'
  | 'NOT_INSPECTED';

export interface EngineFixtureResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  finalUrl: string;
}

export interface EngineFixture {
  id: string;
  strata: FixtureStratum;
  description: string;
  requestUrl: string;
  /** Absent response means transport failure (timeout/unreachable). */
  response?: EngineFixtureResponse;
  transportFailure?: 'timeout' | 'connection-refused' | 'dns-unresolvable';
  expectedOutcome: FixtureExpectedOutcome;
  expectedNotes: string;
}

const html = (body: string) => `<html><head><title>Fixture</title></head><body>${body}</body></html>`;

export const ENGINE_FIXTURES: EngineFixture[] = [
  {
    id: 'redirect-chain-cross-host',
    strata: 'redirects',
    description: 'Shortener wraps a destination across hosts (two hops).',
    requestUrl: 'https://go.fixture.example/s1',
    response: {
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: html('Community hub. Join https://discord.gg/fixtureone any time.'),
      finalUrl: 'https://dest.fixture.example/landing',
    },
    expectedOutcome: 'FOUND',
    expectedNotes: 'facts keyed by destination identity; requested identity carries a fact-free alias',
  },
  {
    id: 'redirect-same-site-path',
    strata: 'redirects',
    description: 'Same-host path migration: old path serves new path content.',
    requestUrl: 'https://shop.fixture.example/old-pricing',
    response: {
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: html('Pricing has moved. See <a href="/new-pricing">new pricing</a>.'),
      finalUrl: 'https://shop.fixture.example/new-pricing',
    },
    expectedOutcome: 'INSPECTED_NO_MATCH',
    expectedNotes: 'same identity, no alias; coverage recorded per path',
  },
  {
    id: 'canonical-self-consistent',
    strata: 'canonical-conflicts',
    description: 'Self-referential canonical agreeing with served content.',
    requestUrl: 'https://press.fixture.example/post',
    response: {
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: `<html><head><link rel="canonical" href="https://press.fixture.example/post"></head><body>Post body.</body></html>`,
      finalUrl: 'https://press.fixture.example/post',
    },
    expectedOutcome: 'INSPECTED_NO_MATCH',
    expectedNotes: 'canonical recorded as corroborating hint, never a merge verdict',
  },
  {
    id: 'canonical-cross-host-contradictory',
    strata: 'canonical-conflicts',
    description: 'Page canonicalizes cross-host while serving distinct content.',
    requestUrl: 'https://copy.fixture.example/deal',
    response: {
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: `<html><head><link rel="canonical" href="https://origin.fixture.example/deal"></head><body>Distinct promotional content with unique pricing table.</body></html>`,
      finalUrl: 'https://copy.fixture.example/deal',
    },
    expectedOutcome: 'INSPECTED_NO_MATCH',
    expectedNotes: 'CANONICAL_CONFLICT recorded; observed behavior governs; no identity merge',
  },
  {
    id: 'robots-allow-all',
    strata: 'robots-variants',
    description: 'Explicit allow policy for all agents.',
    requestUrl: 'https://open.fixture.example/robots.txt',
    response: {
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: 'User-agent: *\nAllow: /\nSitemap: https://open.fixture.example/sitemap.xml\n',
      finalUrl: 'https://open.fixture.example/robots.txt',
    },
    expectedOutcome: 'INSPECTED_NO_MATCH',
    expectedNotes: 'ROBOTS_ALLOWED with sitemap discovery input; fixture asserts policy, not evidence',
  },
  {
    id: 'robots-disallow-scoped',
    strata: 'robots-variants',
    description: 'Scoped disallow with an explicit allow exception.',
    requestUrl: 'https://scoped.fixture.example/robots.txt',
    response: {
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: 'User-agent: *\nDisallow: /private/\nAllow: /private/public\n',
      finalUrl: 'https://scoped.fixture.example/robots.txt',
    },
    expectedOutcome: 'INSPECTED_NO_MATCH',
    expectedNotes: 'longest-match evaluation; disallowed routes terminal without fetching',
  },
  {
    id: 'robots-missing-404',
    strata: 'robots-variants',
    description: 'No robots file (404): fetching permitted, absence recorded distinctly.',
    requestUrl: 'https://norobots.fixture.example/robots.txt',
    response: { status: 404, headers: { 'content-type': 'text/plain' }, body: 'nope', finalUrl: 'https://norobots.fixture.example/robots.txt' },
    expectedOutcome: 'INSPECTED_NO_MATCH',
    expectedNotes: 'ROBOTS_UNAVAILABLE state, never conflated with explicit allow',
  },
  {
    id: 'robots-unreachable-500',
    strata: 'robots-variants',
    description: 'Server error fetching robots: assume disallowed temporarily.',
    requestUrl: 'https://down.fixture.example/robots.txt',
    response: { status: 500, headers: {}, body: 'error', finalUrl: 'https://down.fixture.example/robots.txt' },
    expectedOutcome: 'PARTIALLY_INSPECTED',
    expectedNotes: 'ROBOTS_UNREACHABLE defers with backoff; never a negative',
  },
  {
    id: 'sitemap-index-and-urlset',
    strata: 'sitemap-rss',
    description: 'Sitemap index advertising two files, one off-host (dropped).',
    requestUrl: 'https://smap.fixture.example/sitemap.xml',
    response: {
      status: 200,
      headers: { 'content-type': 'application/xml' },
      body: `<?xml version="1.0"?><sitemapindex><sitemap><loc>https://smap.fixture.example/s1.xml</loc></sitemap><sitemap><loc>https://elsewhere.example.net/s2.xml</loc></sitemap></sitemapindex>`,
      finalUrl: 'https://smap.fixture.example/sitemap.xml',
    },
    expectedOutcome: 'INSPECTED_NO_MATCH',
    expectedNotes: 'off-host sitemap dropped with count; nominations only, never evidence',
  },
  {
    id: 'rss-feed-two-entries',
    strata: 'sitemap-rss',
    description: 'RSS 2.0 feed with two entries.',
    requestUrl: 'https://blog.fixture.example/feed',
    response: {
      status: 200,
      headers: { 'content-type': 'application/rss+xml' },
      body: `<?xml version="1.0"?><rss version="2.0"><channel><title>B</title><item><title>One</title><link>https://blog.fixture.example/1</link></item><item><title>Two</title><link>https://blog.fixture.example/2</link></item></channel></rss>`,
      finalUrl: 'https://blog.fixture.example/feed',
    },
    expectedOutcome: 'INSPECTED_NO_MATCH',
    expectedNotes: 'entries are discovery nominations; entry bodies need separate acquisition for evidence',
  },
  {
    id: 'structured-markup-stale-invite',
    strata: 'structured-data-conflicts',
    description: 'JSON-LD advertises an invite absent from visible text (stale markup).',
    requestUrl: 'https://stale.fixture.example/',
    response: {
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: `<html><head><script type="application/ld+json">{"@type": "Organization", "sameAs": ["https://discord.gg/staleroom"]}</script></head><body>Welcome to our homepage. No community links visible today.</body></html>`,
      finalUrl: 'https://stale.fixture.example/',
    },
    expectedOutcome: 'INSPECTED_NO_MATCH',
    expectedNotes: 'STRUCTURED_CONFLICT preserved; markup-only claim stays provisional without corroboration',
  },
  {
    id: 'structured-markup-corroborated-invite',
    strata: 'structured-data-conflicts',
    description: 'Visible invite corroborated by JSON-LD sameAs.',
    requestUrl: 'https://agree.fixture.example/',
    response: {
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: `<html><head><script type="application/ld+json">{"@type": "Organization", "sameAs": ["https://discord.gg/agreeroom"]}</script></head><body>Join https://discord.gg/agreeroom today.</body></html>`,
      finalUrl: 'https://agree.fixture.example/',
    },
    expectedOutcome: 'FOUND',
    expectedNotes: 'agreement raises confidence; neither source alone decides admissibility',
  },
  {
    id: 'truncated-response',
    strata: 'truncation',
    description: 'Large page cut by the response cap mid-content.',
    requestUrl: 'https://big.fixture.example/guide',
    response: {
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: `<html><body>${'lorem ipsum dolor sit amet. '.repeat(200)}</body></html>`,
      finalUrl: 'https://big.fixture.example/guide',
    },
    expectedOutcome: 'PARTIALLY_INSPECTED',
    expectedNotes: 'truncation forces partial, never a clean negative (cap assumed hit downstream)',
  },
  {
    id: 'blocked-login-wall',
    strata: 'blocked-states',
    description: 'Login gate: content requires authentication.',
    requestUrl: 'https://gated.fixture.example/community',
    response: {
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: `<html><body><form action="/login"><input type="password" name="pw"><button>Sign in to continue</button></form></body></html>`,
      finalUrl: 'https://gated.fixture.example/community',
    },
    expectedOutcome: 'BLOCKED',
    expectedNotes: 'terminal login state; never bypassed, never negative; legitimate alternatives only',
  },
  {
    id: 'blocked-waf-interstitial',
    strata: 'blocked-states',
    description: 'Bot-management interstitial (challenge markers, no content).',
    requestUrl: 'https://waf.fixture.example/',
    response: {
      status: 403,
      headers: { 'content-type': 'text/html' },
      body: `<html><body><div class="cf-challenge">Verifying you are human before accessing waf.fixture.example</div></body></html>`,
      finalUrl: 'https://waf.fixture.example/',
    },
    expectedOutcome: 'BLOCKED',
    expectedNotes: 'WAF-managed terminal; backoff and alternatives only, challenge never solved',
  },
  {
    id: 'blocked-rate-limited',
    strata: 'blocked-states',
    description: '429 with Retry-After: politeness signal, not a verdict.',
    requestUrl: 'https://limited.fixture.example/api',
    response: { status: 429, headers: { 'content-type': 'text/plain', 'retry-after': '120' }, body: 'slow down', finalUrl: 'https://limited.fixture.example/api' },
    expectedOutcome: 'PARTIALLY_INSPECTED',
    expectedNotes: 'rate limit defers with backoff; retry-owned, never negative',
  },
  {
    id: 'nav-hub-three-deep-invite',
    strata: 'multi-page-navigation',
    description: 'Hub links to section links to an invite page (depth 2).',
    requestUrl: 'https://nav.fixture.example/',
    response: {
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: html('Start here: <a href="/community">our community hub</a> and <a href="/about">about us</a>.'),
      finalUrl: 'https://nav.fixture.example/',
    },
    expectedOutcome: 'INSPECTED_NO_MATCH',
    expectedNotes: 'hub itself clean; ranked navigation must reach depth-2 evidence in companion fixtures',
  },
  {
    id: 'nav-invite-at-depth-two',
    strata: 'multi-page-navigation',
    description: 'Section page linking the invite page.',
    requestUrl: 'https://nav.fixture.example/community',
    response: {
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: html('Members gather on <a href="/community/join">our join page</a> every Friday.'),
      finalUrl: 'https://nav.fixture.example/community',
    },
    expectedOutcome: 'INSPECTED_NO_MATCH',
    expectedNotes: 'intermediate hop carries no invite; route value learned from eventual yield',
  },
  {
    id: 'duplicate-utm-variant',
    strata: 'duplicate-pages',
    description: 'Identical body under a tracked variant URL.',
    requestUrl: 'https://dup.fixture.example/p?utm_source=x',
    response: {
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: html('Same content. Join https://discord.gg/duproom today.'),
      finalUrl: 'https://dup.fixture.example/p?utm_source=x',
    },
    expectedOutcome: 'FOUND',
    expectedNotes: 'content-hash dedup collapses variants before counting evidence',
  },
  {
    id: 'adversarial-honeypot-links',
    strata: 'known-negative-adversarial',
    description: 'Hidden honeypot links a naive crawler would follow.',
    requestUrl: 'https://trap.fixture.example/',
    response: {
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: `<html><body>Welcome.<a href="/hidden-admin" style="display: none">admin</a><a href="/community">community</a></body></html>`,
      finalUrl: 'https://trap.fixture.example/',
    },
    expectedOutcome: 'INSPECTED_NO_MATCH',
    expectedNotes: 'display:none links never enter the frontier; no invite present regardless',
  },
  {
    id: 'adversarial-fake-invite-text',
    strata: 'known-negative-adversarial',
    description: 'Invite-like strings that are not real invites.',
    requestUrl: 'https://fake.fixture.example/',
    response: {
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: html('Example: discord.gg/ is where invites live. Our code is ABC (not a link, too short).'),
      finalUrl: 'https://fake.fixture.example/',
    },
    expectedOutcome: 'INSPECTED_NO_MATCH',
    expectedNotes: 'precision fixture: noisy extraction must not manufacture evidence',
  },
  {
    id: 'unreachable-timeout',
    strata: 'blocked-states',
    description: 'Transport timeout with no response.',
    requestUrl: 'https://down.fixture.example/',
    transportFailure: 'timeout',
    expectedOutcome: 'PARTIALLY_INSPECTED',
    expectedNotes: 'no evidence either way; retry-owned, absence never claimed',
  },
];

const EXPECTED_OUTCOMES: FixtureExpectedOutcome[] = [
  'FOUND', 'INSPECTED_NO_MATCH', 'PARTIALLY_INSPECTED', 'ACQUISITION_FAILED', 'BLOCKED', 'NOT_INSPECTED',
];

/** Fixture self-validation: schema discipline and label closure. Asserts
 * corpus mechanics only — never implementation behavior. Every stratum from
 * the specification must be represented. */
export function validateEngineFixtures(fixtures: EngineFixture[] = ENGINE_FIXTURES): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const strata = new Set<FixtureStratum>();
  const required: FixtureStratum[] = [
    'redirects', 'canonical-conflicts', 'robots-variants', 'sitemap-rss',
    'structured-data-conflicts', 'truncation', 'blocked-states',
    'multi-page-navigation', 'duplicate-pages', 'known-negative-adversarial',
  ];
  for (const fixture of fixtures) {
    if (!fixture.id || seen.has(fixture.id)) problems.push(`duplicate or empty id: ${fixture.id}`);
    seen.add(fixture.id);
    strata.add(fixture.strata);
    if (!fixture.description) problems.push(`missing description: ${fixture.id}`);
    if (!fixture.requestUrl) problems.push(`missing requestUrl: ${fixture.id}`);
    if (!fixture.response && !fixture.transportFailure) problems.push(`neither response nor transportFailure: ${fixture.id}`);
    if (fixture.response && fixture.transportFailure) problems.push(`both response and transportFailure: ${fixture.id}`);
    if (!EXPECTED_OUTCOMES.includes(fixture.expectedOutcome)) problems.push(`open outcome label: ${fixture.id}`);
    if (!fixture.expectedNotes) problems.push(`missing expectedNotes: ${fixture.id}`);
  }
  for (const stratum of required) {
    if (!strata.has(stratum)) problems.push(`stratum unrepresented: ${stratum}`);
  }
  return problems;
}
