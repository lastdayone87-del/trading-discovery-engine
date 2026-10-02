import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  isSameSiteSitemapSeed,
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
  // The inspector gate rejects both the off-site inventory source and the
  // off-site candidate, so no website seed is produced.
  assert.equal(isSameSiteSitemapSeed(seedUrl, offSiteInventory.sourceUrl), false);
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

test('inspector sitemap seeding is same-site gated at consumption time', () => {
  const source = readFileSync(new URL('./inspector.ts', import.meta.url), 'utf8');
  assert.match(
    source,
    /isSameSiteSitemapSeed\(seed\.url,\s*inventorySourceUrl\)/,
    'off-site sitemap files never contribute seeds',
  );
  assert.match(
    source,
    /isSameSiteSitemapSeed\(seed\.url,\s*candidate\.url\)/,
    'off-site sitemap URLs never become website seeds',
  );
});
