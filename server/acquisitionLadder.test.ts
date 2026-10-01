import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldEscalateToRenderedFallback } from './browserCommunityFallback';
import {
  ACQUISITION_LADDER_POLICY_VERSION,
  ACQUISITION_METHOD_COST_RANK,
  MAX_LADDER_SITEMAP_SEEDS,
  MAX_LADDER_STRUCTURED_URLS,
  isAcquisitionLadderEnabled,
  resolveRenderEscalation,
  selectSitemapSeedCandidates,
  selectStructuredNavigationCandidates,
} from './acquisitionLadder';

test('ladder render decisions match the legacy escalation predicate exactly', () => {
  const surfaces = ['CREATOR_WEBSITES', 'SOCIAL_PROFILES', 'OTHER'] as const;
  const outcomes = ['FOUND', 'INSPECTED_NO_MATCH', 'PARTIALLY_INSPECTED', 'ACQUISITION_FAILED'] as const;
  let compared = 0;
  for (const surface of surfaces) {
    for (const staticOutcome of outcomes) {
      for (const trading of [true, false]) {
        for (const owned of [true, false]) {
          const legacy = staticOutcome === 'FOUND'
            ? !owned
            : shouldEscalateToRenderedFallback({ staticOutcome, creatorLikelyTrading: trading, surface });
          const ladder = resolveRenderEscalation({
            staticOutcome, creatorLikelyTrading: trading, surface, hasCreatorOwnedEvidence: staticOutcome === 'FOUND' && owned,
          });
          assert.equal(ladder.escalate, legacy, `surface=${surface} outcome=${staticOutcome} trading=${trading} owned=${owned}`);
          assert.ok(ladder.justification.length > 0, 'every decision carries a justification');
          compared += 1;
        }
      }
    }
  }
  assert.equal(compared, 3 * 4 * 2 * 2, 'full decision matrix compared');
});

test('method cost ranks order cheapest-first with render last-resort', () => {
  assert.ok(ACQUISITION_METHOD_COST_RANK.STRUCTURED_EXTRACTION < ACQUISITION_METHOD_COST_RANK.HTTP_STATIC);
  assert.ok(ACQUISITION_METHOD_COST_RANK.HTTP_STATIC < ACQUISITION_METHOD_COST_RANK.RENDERED_BROWSER);
  assert.ok(ACQUISITION_METHOD_COST_RANK.PUBLIC_ALTERNATIVE >= ACQUISITION_METHOD_COST_RANK.RENDERED_BROWSER);
  assert.equal(ACQUISITION_LADDER_POLICY_VERSION, 'acquisition-ladder-v1');
});

test('sitemap seeds are scored, deduped, and capped with provenance', () => {
  const urls = [
    { loc: 'https://example.com/join-community' },
    { loc: 'https://example.com/join-community' },
    { loc: 'https://example.com/about' },
    { loc: 'not-a-url' },
    { loc: 'ftp://example.com/x' },
  ];
  const seeds = selectSitemapSeedCandidates(urls, 'https://example.com/sitemap.xml', 10);
  assert.ok(seeds.length >= 1 && seeds.length <= 10);
  assert.ok(seeds.every(seed => seed.sitemapUrl === 'https://example.com/sitemap.xml'));
  assert.ok(seeds[0].score >= seeds[seeds.length - 1].score, 'best-first order');
  const capped = selectSitemapSeedCandidates(
    Array.from({ length: MAX_LADDER_SITEMAP_SEEDS + 5 }, (_, i) => ({ loc: `https://example.com/join-${i}` })),
    'https://example.com/sitemap.xml',
  );
  assert.equal(capped.length, MAX_LADDER_SITEMAP_SEEDS);
  assert.deepEqual(selectSitemapSeedCandidates([{ loc: 'https://example.com/plain' }], 'https://example.com/sitemap.xml'), [], 'zero-score URLs never seed');
});

test('structured candidates admit same-host canonicals and scored sameAs, never cross-host canonicals', () => {
  const found = selectStructuredNavigationCandidates(
    {
      canonicalHrefs: ['https://example.com/', 'https://other.example.net/x'],
      jsonLdSameAs: ['https://shop.example.com/join', 'not-a-url', 'https://example.com/'],
    },
    'https://example.com/a',
  );
  const urls = found.map(candidate => candidate.url);
  assert.ok(!urls.some(url => url.includes('other.example.net')), 'cross-host canonicals never admitted here');
  assert.ok(urls.some(url => url.includes('shop.example.com')), 'scored sameAs admitted');
  assert.ok(found.length <= MAX_LADDER_STRUCTURED_URLS);
  assert.deepEqual(selectStructuredNavigationCandidates({ canonicalHrefs: [], jsonLdSameAs: [] }, 'https://example.com/a'), []);
  assert.deepEqual(selectStructuredNavigationCandidates({ canonicalHrefs: ['https://example.com/'], jsonLdSameAs: [] }, 'not a url'), []);
});

test('ladder stays disabled by default', async () => {
  assert.equal(await isAcquisitionLadderEnabled(async () => 'false'), false);
  assert.equal(await isAcquisitionLadderEnabled(async () => 'true'), true);
});
