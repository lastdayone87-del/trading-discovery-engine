import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalSiteIdentity } from './siteIdentity';

test('Tier A collapses single-tenant aliases to the registrable domain', () => {
  for (const url of [
    'https://apextrader.com',
    'http://www.apextrader.com/pricing/?utm_source=x',
    'https://APP.apextrader.com/join',
    'apextrader.com',
  ]) {
    assert.deepEqual(canonicalSiteIdentity(url), {
      siteIdentity: 'apextrader.com',
      tier: 'A',
      basis: 'ICANN registrable domain',
      crawlUrl: canonicalSiteIdentity(url)?.crawlUrl,
    });
  }
  // Multi-label public suffixes resolve correctly (naive second-label
  // splitting would return co.uk here).
  assert.equal(canonicalSiteIdentity('https://a.example.co.uk/path')?.siteIdentity, 'example.co.uk');
  assert.equal(canonicalSiteIdentity('https://example.co.uk')?.siteIdentity, 'example.co.uk');
  // Lookalikes never merge.
  assert.equal(canonicalSiteIdentity('https://notbinance.com')?.siteIdentity, 'notbinance.com');
  assert.equal(canonicalSiteIdentity('https://binance.com.evil.com')?.siteIdentity, 'evil.com');
});

test('Tier A handles IDN and trailing-dot hosts', () => {
  const a = canonicalSiteIdentity('https://www.BÜCHER.de/path');
  const b = canonicalSiteIdentity('https://xn--bcher-kva.de/other');
  assert.ok(a && b && a.siteIdentity === b.siteIdentity && a.tier === 'A');
  assert.equal(canonicalSiteIdentity('https://example.com./')?.siteIdentity, 'example.com');
});

test('Tier B keeps subdomain tenants distinct (evidence-backed registry)', () => {
  const trading = canonicalSiteIdentity('https://trading.skool.com/atlas');
  const other = canonicalSiteIdentity('https://other.skool.com/');
  assert.equal(trading?.tier, 'B');
  assert.equal(trading?.siteIdentity, 'trading.skool.com');
  assert.notEqual(trading?.siteIdentity, other?.siteIdentity);
  const circle = canonicalSiteIdentity('https://community.circle.so/atlas-trading');
  assert.equal(circle?.tier, 'B');
  assert.equal(circle?.siteIdentity, 'community.circle.so');
});

test('Tier C keeps path tenants distinct (evidence-backed registry)', () => {
  const cases: Array<[string, string]> = [
    ['https://linktr.ee/atlastrading', 'linktr.ee/atlastrading'],
    ['https://linktr.ee/community', 'linktr.ee/community'],
    ['https://beacons.ai/trader', 'beacons.ai/trader'],
    ['https://whop.com/atlastrading', 'whop.com/atlastrading'],
    ['https://whop.com/some-desk', 'whop.com/some-desk'],
    ['https://patreon.com/abc', 'patreon.com/abc'],
    ['https://bio.link/x', 'bio.link/x'],
    ['https://solo.to/x', 'solo.to/x'],
    ['https://campsite.bio/x', 'campsite.bio/x'],
    ['https://lnk.bio/x', 'lnk.bio/x'],
  ];
  for (const [url, identity] of cases) {
    assert.equal(canonicalSiteIdentity(url)?.siteIdentity, identity, url);
    assert.equal(canonicalSiteIdentity(url)?.tier, 'C', url);
  }
  assert.notEqual(
    canonicalSiteIdentity('https://linktr.ee/atlastrading')?.siteIdentity,
    canonicalSiteIdentity('https://linktr.ee/community')?.siteIdentity,
  );
  // Bare platform homepage is one site (no tenant path to split on).
  assert.equal(canonicalSiteIdentity('https://linktr.ee')?.siteIdentity, 'linktr.ee');
});

test('Tier D resolves identity from the final destination, not the wrapper', () => {
  const via = canonicalSiteIdentity('https://www.youtube.com/redirect?q=https%3A%2F%2Fapextrader.com%2Fjoin', 'https://apextrader.com/join');
  assert.equal(via?.siteIdentity, 'apextrader.com');
  assert.equal(via?.tier, 'A');
  const direct = canonicalSiteIdentity('https://short.example/abc', 'https://trading.skool.com/atlas');
  assert.equal(direct?.siteIdentity, 'trading.skool.com');
  assert.equal(direct?.tier, 'B');
});

test('deferred platforms stay on Tier A until evidence admits them (no silent merge by us)', () => {
  // These are NOT in the registries: both resolve to the registrable
  // domain today. If either ever appears in creator-link evidence, admit
  // it to Tier B with fixtures — do not rely on PSL private behavior.
  assert.equal(canonicalSiteIdentity('https://trader1.github.io/school')?.tier, 'A');
  assert.equal(canonicalSiteIdentity('https://trader1.github.io/school')?.siteIdentity, 'github.io');
  assert.equal(canonicalSiteIdentity('https://a.vercel.app')?.tier, 'A');
});

test('unsafe inputs fail closed to null (crawl without reuse, never merge)', () => {
  assert.equal(canonicalSiteIdentity('ftp://apextrader.com/x'), null);
  assert.equal(canonicalSiteIdentity('https://g/'), null, 'dotless host');
  assert.equal(canonicalSiteIdentity('http://1.2.3.4/status'), null, 'IP literal');
  assert.equal(canonicalSiteIdentity('not a url at all !@#'), null);
  assert.equal(canonicalSiteIdentity(''), null);
});
