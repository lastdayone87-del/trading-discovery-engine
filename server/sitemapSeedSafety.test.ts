import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  isSameSiteSitemapSeed,
  selectSameSiteSitemapSeedCandidates,
  selectSitemapSeedCandidates,
  MAX_LADDER_SITEMAP_SEEDS,
} from './acquisitionLadder';

/**
 * P1 regression: Unchecked Sitemap Seed Destinations (inspector.ts ~787).
 * When the ladder is enabled and a stored profile contains an off-site
 * sitemap inventory, positively-scored URLs must never become website seeds
 * for another site. The static crawler would otherwise request an
 * unintended/private destination advertised by the site.
 */

test('same-site gate admits same-site seeds (www/subdomain/scheme/port aliases)', () => {
  assert.equal(isSameSiteSitemapSeed('https://creator.example/', 'https://creator.example/community'), true);
  assert.equal(isSameSiteSitemapSeed('https://creator.example/', 'https://www.creator.example/join'), true);
  assert.equal(isSameSiteSitemapSeed('https://creator.example/', 'https://sub.creator.example/join'), true);
  assert.equal(isSameSiteSitemapSeed('https://creator.example/', 'http://creator.example/join'), true);
  assert.equal(isSameSiteSitemapSeed('https://creator.example/', 'https://creator.example:8443/community'), true);
});

test('same-site gate rejects off-site, lookalike, and unidentifiable destinations', () => {
  // Off-site registrable domain.
  assert.equal(isSameSiteSitemapSeed('https://creator.example/', 'https://evil.example.net/community'), false);
  // Lookalike subdomain of another registrable domain.
  assert.equal(
    isSameSiteSitemapSeed('https://creator.example/', 'https://creator.example.evil.example.net/join'),
    false,
  );
  // Private IP literals and dotless hosts have no site identity: fail closed.
  assert.equal(isSameSiteSitemapSeed('https://creator.example/', 'http://192.168.1.1/community'), false);
  assert.equal(isSameSiteSitemapSeed('https://creator.example/', 'http://127.0.0.1/admin'), false);
  assert.equal(isSameSiteSitemapSeed('https://creator.example/', 'http://10.0.0.7/y'), false);
  assert.equal(isSameSiteSitemapSeed('https://creator.example/', 'https://g/join'), false);
  assert.equal(isSameSiteSitemapSeed('https://creator.example/', 'not-a-url'), false);
  assert.equal(isSameSiteSitemapSeed('not-a-url', 'https://creator.example/community'), false);
});

test('same-site gate isolates tenant sites (subdomain and path tenants)', () => {
  // Tier B: skool subdomain tenants are distinct sites.
  assert.equal(
    isSameSiteSitemapSeed('https://foo.skool.com/', 'https://bar.skool.com/community'),
    false,
  );
  assert.equal(
    isSameSiteSitemapSeed('https://foo.skool.com/', 'https://foo.skool.com/community'),
    true,
  );
  // Tier C: linktr.ee path tenants are distinct sites.
  assert.equal(
    isSameSiteSitemapSeed('https://linktr.ee/trader1', 'https://linktr.ee/trader2/join'),
    false,
  );
  assert.equal(
    isSameSiteSitemapSeed('https://linktr.ee/trader1', 'https://linktr.ee/trader1/join'),
    true,
  );
});

test('off-site sitemap inventory is rejected even though its URLs score positively', () => {
  const seedUrl = 'https://creator.example/';
  const offSiteInventory = {
    sourceUrl: 'https://evil.example.net/sitemap.xml',
    urls: [{ loc: 'https://evil.example.net/community' }],
  };
  // The scorer alone admits the off-site URL (this is the pre-fix hazard):
  // it carries a community hint and scores positively.
  const unscored = selectSitemapSeedCandidates(
    offSiteInventory.urls,
    offSiteInventory.sourceUrl,
    MAX_LADDER_SITEMAP_SEEDS,
  );
  assert.ok(
    unscored.some(candidate => candidate.url === 'https://evil.example.net/community'),
    'scorer admits the off-site community URL by score (pre-fix behavior)',
  );
  // The candidate-level gate rejects the off-site URL, so no website seed
  // is produced. (The inventory source itself is intentionally not gated on
  // exact identity — see path-tenant root-sitemap test below — the per-URL
  // gate is the security boundary.)
  const gated = unscored.filter(candidate => isSameSiteSitemapSeed(seedUrl, candidate.url));
  assert.deepEqual(gated, [], 'off-site sitemap URLs never become seeds');
});

test('same-site sitemap inventory still seeds through the gate (no over-blocking)', () => {
  const seedUrl = 'https://creator.example/';
  const sameSiteInventory = {
    sourceUrl: 'https://creator.example/sitemap.xml',
    urls: [{ loc: 'https://creator.example/community' }, { loc: 'https://creator.example/about' }],
  };
  assert.equal(isSameSiteSitemapSeed(seedUrl, sameSiteInventory.sourceUrl), true);
  const candidates = selectSitemapSeedCandidates(
    sameSiteInventory.urls,
    sameSiteInventory.sourceUrl,
    MAX_LADDER_SITEMAP_SEEDS,
  );
  const gated = candidates.filter(candidate => isSameSiteSitemapSeed(seedUrl, candidate.url));
  assert.ok(
    gated.some(candidate => candidate.url === 'https://creator.example/community'),
    'legitimate same-site community URL still seeds',
  );
});

test('inspector sitemap seeding filters before the cap (no exact-identity source gate)', () => {
  const source = readFileSync(new URL('./inspector.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(
    source,
    /isSameSiteSitemapSeed\(seed\.url,\s*inventorySourceUrl\)/,
    'root sitemaps must not require the exact path-tenant identity',
  );
  assert.match(
    source,
    /selectSameSiteSitemapSeedCandidates\(\s*seed\.url/,
    'same-site filtering must happen inside the capped selector (filter-before-cap)',
  );
});

/**
 * Inspector-equivalent gating (delegates to the production selector in
 * server/acquisitionLadder.ts): same-site filter BEFORE scoring/capping.
 * The inventory source is provenance, never a seed-identity requirement,
 * so conventional root sitemaps keep working for path-tenant seeds.
 */
function gatedSeedsFor(
  seedUrl: string,
  inventories: Array<{ sourceUrl: string; urls: Array<{ loc: string }> }>,
): string[] {
  const out: string[] = [];
  for (const inventory of inventories) {
    for (const candidate of selectSameSiteSitemapSeedCandidates(
      seedUrl,
      inventory.urls,
      inventory.sourceUrl,
      MAX_LADDER_SITEMAP_SEEDS,
    )) {
      if (!out.includes(candidate.url)) out.push(candidate.url);
    }
  }
  return out;
}

test('valid tenant URL survives higher-scoring other-tenant URLs (filter-before-cap)', () => {
  const seedUrl = 'https://linktr.ee/trader1';
  const crowding = [2, 3, 4, 5, 6].map(n => ({
    loc: `https://linktr.ee/trader${n}/discord-community-join`,
  }));
  const inventories = [
    {
      sourceUrl: 'https://linktr.ee/sitemap.xml',
      urls: [...crowding, { loc: 'https://linktr.ee/trader1/community' }],
    },
  ];
  // Old ordering (cap-then-filter) loses the valid tenant URL: the top-5
  // cap keeps only the higher-scoring other-tenant URLs, which are then all
  // rejected, leaving no seeds.
  const cappedFirst = selectSitemapSeedCandidates(
    inventories[0].urls,
    inventories[0].sourceUrl,
    MAX_LADDER_SITEMAP_SEEDS,
  );
  assert.ok(
    !cappedFirst.some(candidate => candidate.url === 'https://linktr.ee/trader1/community'),
    'cap-before-filter crowds out the valid tenant URL',
  );
  assert.deepEqual(
    cappedFirst.filter(candidate => isSameSiteSitemapSeed(seedUrl, candidate.url)),
    [],
    'cap-before-filter leaves the tenant with no seeds',
  );
  // Filter-before-cap keeps the valid tenant URL despite lower rank.
  const seeds = gatedSeedsFor(seedUrl, inventories);
  assert.ok(
    seeds.includes('https://linktr.ee/trader1/community'),
    'valid tenant URL still selected after higher-scoring cross-tenant URLs',
  );
  assert.ok(
    seeds.every(url => isSameSiteSitemapSeed(seedUrl, url)),
    'no off-site or cross-tenant URL leaks through the cap',
  );
});

test('path-tenant root sitemap with valid tenant URL is accepted', () => {
  const seeds = gatedSeedsFor('https://linktr.ee/trader1', [
    {
      sourceUrl: 'https://linktr.ee/sitemap.xml',
      urls: [{ loc: 'https://linktr.ee/trader1/community' }],
    },
  ]);
  assert.ok(
    seeds.includes('https://linktr.ee/trader1/community'),
    'root sitemap may inventory its tenant pages',
  );
});

test('path-tenant sitemap listing another tenant URL is rejected', () => {
  const seeds = gatedSeedsFor('https://linktr.ee/trader1', [
    {
      sourceUrl: 'https://linktr.ee/sitemap.xml',
      urls: [{ loc: 'https://linktr.ee/trader2/join' }],
    },
  ]);
  assert.deepEqual(seeds, [], 'another tenant never becomes this tenant seed');
});

test('genuinely off-site sitemap inventory is rejected', () => {
  const seeds = gatedSeedsFor('https://creator.example/', [
    {
      sourceUrl: 'https://evil.example.net/sitemap.xml',
      urls: [{ loc: 'https://evil.example.net/community' }],
    },
  ]);
  assert.deepEqual(seeds, [], 'off-site inventory supplies no seeds');
});

test('Tier B/C tenant isolation is preserved under candidate gating', () => {
  assert.deepEqual(
    gatedSeedsFor('https://foo.skool.com/', [
      { sourceUrl: 'https://skool.com/sitemap.xml', urls: [{ loc: 'https://bar.skool.com/community' }] },
    ]),
    [],
    'Tier B cross-tenant rejected',
  );
  assert.ok(
    gatedSeedsFor('https://foo.skool.com/', [
      { sourceUrl: 'https://foo.skool.com/sitemap.xml', urls: [{ loc: 'https://foo.skool.com/community' }] },
    ]).includes('https://foo.skool.com/community'),
    'Tier B same-tenant accepted',
  );
});
