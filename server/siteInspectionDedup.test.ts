import test from 'node:test';
import assert from 'node:assert/strict';
import { runChannelInspection, creatorWebsiteHostsFromLinks } from './inspector';
import { mergeDiscordCandidates, type DiscordCandidate } from './discordCandidates';
import type { SiteInspectionRow } from './dbCore';
import type { SiteInspectionStore } from './siteInspectionCache';

function makeStore() {
  const rows = new Map<string, SiteInspectionRow>();
  const links: Array<{ channelId: string; siteIdentity: string; sourceSurface: string; sourceUrl: string }> = [];
  const store: SiteInspectionStore = {
    read: async identities => identities.map(id => rows.get(id)).filter((row): row is SiteInspectionRow => !!row),
    write: async row => {
      const now = new Date().toISOString();
      const prior = rows.get(row.siteIdentity);
      rows.set(row.siteIdentity, {
        siteIdentity: row.siteIdentity,
        identityTier: row.identityTier,
        identityBasis: row.identityBasis,
        canonicalUrl: row.canonicalUrl,
        finalUrl: row.finalUrl,
        outcome: row.outcome,
        retryable: row.retryable,
        httpStatus: row.httpStatus ?? null,
        failureClass: row.failureClass ?? '',
        detail: row.detail ?? '',
        payloadChecksum: row.payloadChecksum ?? null,
        candidates: row.candidates,
        observations: row.observations,
        renderedCovered: row.renderedCovered,
        provenance: row.provenance ?? {},
        firstObservedAt: prior?.firstObservedAt ?? now,
        lastObservedAt: now,
        observedCount: (prior?.observedCount ?? 0) + 1,
      });
    },
    recordLinks: async (channelId, recorded) => {
      for (const link of recorded) links.push({ channelId, ...link });
    },
  };
  return { store, rows, links };
}

const DESCS = ['d1', 'd2', 'd3', 'd4', 'd5'];

function makeFetch(fetched: string[]) {
  return (async (url: unknown) => {
    const target = String(url);
    fetched.push(target);
    if (target.includes('apextrader.com')) {
      return new Response(
        '<html><head><title>Apex</title></head><body>Join our trading floor https://discord.gg/apexroom today</body></html>',
        { status: 200, headers: { 'content-type': 'text/html' } },
      );
    }
    return new Response('<html><body>plain creator site</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
  }) as typeof fetch;
}

test('Trader A/B: shared affiliate site is crawled once, reused with separate associations', async () => {
  const { store, rows, links } = makeStore();
  const fetched: string[] = [];
  const fetchImpl = makeFetch(fetched);
  const base = { videoDescriptions: DESCS, externalFetchImpl: fetchImpl, urlFailureHistoryLoader: async () => [], siteInspectionStore: store } as const;

  const a = await runChannelInspection({
    ...base,
    channelId: 'UCTraderA00000000000001',
    channelName: 'Trader A',
    channelBio: 'Trading educator',
    channelLinks: ['https://tradingsimp.com', 'https://apextrader.com/pricing'],
  });
  assert.equal(a.foundInvite, 'apexroom');
  assert.equal(a.acquisitionStatus, 'FOUND');
  assert.equal(fetched.filter(url => url.includes('apextrader.com')).length, 1, 'affiliate crawled once for Trader A');
  assert.ok(rows.has('tradingsimp.com') && rows.has('apextrader.com'), 'both sites cached after Trader A');
  assert.deepEqual(
    links.filter(link => link.channelId === 'UCTraderA00000000000001').map(link => link.siteIdentity).sort(),
    ['apextrader.com', 'tradingsimp.com'],
    'Trader A associated to both sites',
  );

  const before = fetched.length;
  const b = await runChannelInspection({
    ...base,
    channelId: 'UCTraderB00000000000002',
    channelName: 'Trader B',
    channelBio: 'Another educator',
    channelLinks: ['https://soso.com', 'https://apextrader.com/'],
  });
  assert.equal(fetched.length, before + 1, 'only the new site is fetched for Trader B');
  assert.deepEqual(fetched.slice(before), ['https://soso.com/'], 'no second affiliate crawl');
  assert.equal(fetched.filter(url => url.includes('apextrader.com')).length, 1, 'affiliate still crawled exactly once overall');

  const borrowed = (b.acquisitionOutcomes || []).filter(item => (item as unknown as Record<string, unknown>).siteCacheHit === true);
  assert.ok(borrowed.length >= 1, 'Trader B carries borrowed site observations');
  assert.ok(borrowed.every(item => item.requestedUrl === 'https://apextrader.com/'), 'borrowed rows are re-attributed to Trader B');
  assert.ok(borrowed.every(item => item.surface === 'CREATOR_WEBSITES'));
  assert.equal(b.foundInvite, 'apexroom', 'reused site-facts still surface the invite for Trader B');
  assert.deepEqual(
    links.filter(link => link.channelId === 'UCTraderB00000000000002').map(link => link.siteIdentity).sort(),
    ['apextrader.com', 'soso.com'],
    'Trader B associated to the affiliate separately despite no crawl',
  );
  const bApexCandidates = (b.discordCandidates || []).filter(c => c.nativeInviteCode === 'apexroom');
  assert.ok(bApexCandidates.length >= 1, 'affiliate candidate present for Trader B');
  assert.ok(rows.has('soso.com'), 'new site cached after Trader B');
});

test('borrowed site-facts never import another creator ownership attribution', () => {
  // Raw candidate exactly as a site row stores it (no ownership verdict).
  const borrowedRaw: DiscordCandidate = {
    candidateId: 'apex-1',
    locatorType: 'NATIVE_INVITE',
    sourceSurface: 'CREATOR_WEBSITES',
    rawLocator: 'https://discord.gg/apexroom',
    nativeInviteCode: 'apexroom',
    sourceUrl: 'https://apextrader.com/home',
    extractionConfidence: 'EXPLICIT',
  };
  // Trader B does not link the affiliate: no canonical-domain contribution
  // may come from Trader A's linkage, which is not in this input at all.
  const forB = mergeDiscordCandidates([borrowedRaw], {
    creatorName: 'Trader B',
    creatorWebsiteHosts: creatorWebsiteHostsFromLinks(['https://soso.com']),
  });
  assert.equal(forB.length, 1);
  assert.ok(!(forB[0].ownershipReasons || []).some(reason => reason.includes('CREATOR_CANONICAL_DOMAIN')), 'no cross-creator ownership import');
  assert.notEqual(forB[0].ownershipStatus, 'CREATOR_OWNED');
  // Positive control: a creator that links the site earns the signal from
  // their OWN link graph (recomputed, never copied).
  const forA = mergeDiscordCandidates([borrowedRaw], {
    creatorName: 'Trader A',
    creatorWebsiteHosts: creatorWebsiteHostsFromLinks(['https://tradingsimp.com', 'https://apextrader.com/pricing']),
  });
  assert.ok((forA[0].ownershipReasons || []).some(reason => reason.includes('CREATOR_CANONICAL_DOMAIN')), 'own linkage still confers the signal');
});
