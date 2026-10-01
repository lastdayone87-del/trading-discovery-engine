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

function makePathFetch(fetched: string[]) {
  return (async (url: unknown) => {
    const target = String(url);
    fetched.push(target);
    const body = target.includes('/join')
      ? '<html><body>Join https://discord.gg/joinroom today</body></html>'
      : '<html><body>plain pricing page</body></html>';
    return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
  }) as typeof fetch;
}

test('uncovered paths recrawl (invite on second path found); covered paths reuse', async () => {
  const { store, rows } = makeStore();
  const fetched: string[] = [];
  const fetchImpl = makePathFetch(fetched);
  const noHistory = async () => [];
  const base = { videoDescriptions: DESCS, externalFetchImpl: fetchImpl, urlFailureHistoryLoader: noHistory, siteInspectionStore: store } as const;

  const first = await runChannelInspection({
    ...base, channelId: 'UCPathCover000000000001', channelName: 'Path A', channelBio: 'Trading educator',
    channelLinks: ['https://multisite.example/pricing'],
  });
  assert.equal(first.foundInvite, null, 'no invite on the pricing path');
  assert.ok(rows.has('multisite.example'), 'negative row cached');

  const beforeSame = fetched.length;
  const same = await runChannelInspection({
    ...base, channelId: 'UCPathCover000000000002', channelName: 'Path B', channelBio: 'Another educator',
    channelLinks: ['https://multisite.example/pricing'],
  });
  assert.equal(fetched.length, beforeSame, 'same covered path reuses without recrawl');
  assert.ok((same.acquisitionOutcomes || []).some(item => (item as unknown as Record<string, unknown>).siteCacheHit === true));

  const other = await runChannelInspection({
    ...base, channelId: 'UCPathCover000000000003', channelName: 'Path C', channelBio: 'Third educator',
    channelLinks: ['https://multisite.example/join'],
  });
  assert.ok(fetched.some(url => url.includes('/join')), 'uncovered path forces acquisition');
  assert.equal(other.foundInvite, 'joinroom', 'invite on the second path is discovered, not masked by the cached absence');
});

function makeRedirectFetch(fetched: string[]) {
  return (async (url: unknown) => {
    const target = String(url);
    fetched.push(target);
    const respond = (html: string, finalUrl?: string) => {
      const response = new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
      if (finalUrl) Object.defineProperty(response, 'url', { value: finalUrl });
      return response;
    };
    if (target.startsWith('https://go.creator-link.example/start')) {
      return respond('<html><body>short link hub, no invite</body></html>', 'https://dest-site.example/landing');
    }
    if (target.startsWith('https://apextrader.com/old')) {
      return respond('<html><body>moved page, no invite</body></html>', 'https://apextrader.com/new');
    }
    if (target.startsWith('https://bit.ly/x1')) {
      return respond('<html><body>short link, no invite</body></html>', 'https://linktr.ee/trader1');
    }
    return respond('<html><body>plain creator site</body></html>');
  }) as typeof fetch;
}

test('cross-domain redirect: alias recorded, repeat inspection borrows without recrawl', async () => {
  const { store, rows, links } = makeStore();
  const fetched: string[] = [];
  const fetchImpl = makeRedirectFetch(fetched);
  const base = { videoDescriptions: DESCS, externalFetchImpl: fetchImpl, urlFailureHistoryLoader: async () => [], siteInspectionStore: store } as const;
  const seed = 'https://go.creator-link.example/start';

  await runChannelInspection({
    ...base, channelId: 'UCRedirect000000000001', channelName: 'Redirect A', channelBio: 'Trading educator',
    channelLinks: [seed],
  });
  assert.equal(fetched.length, 1, 'short link crawled once');
  assert.ok(rows.has('dest-site.example'), 'destination facts persisted under the destination identity');
  const alias = rows.get('creator-link.example');
  assert.equal(alias?.outcome, 'REDIRECTED', 'requested identity carries a redirect alias, not facts');
  assert.equal(alias?.finalUrl, 'https://dest-site.example/landing');
  assert.deepEqual((alias?.candidates as unknown[]).length, 0, 'alias rows carry no candidates');
  const seen = links.filter(link => link.channelId === 'UCRedirect000000000001').map(link => link.siteIdentity).sort();
  assert.deepEqual(seen, ['creator-link.example', 'dest-site.example'], 'creator linked the wrapper and inspected the destination');

  const before = fetched.length;
  const repeat = await runChannelInspection({
    ...base, channelId: 'UCRedirect000000000002', channelName: 'Redirect B', channelBio: 'Another educator',
    channelLinks: [seed],
  });
  assert.equal(fetched.length, before, 'repeated inspection resolves the alias without recrawling');
  assert.ok((repeat.acquisitionOutcomes || []).some(item => (item as unknown as Record<string, unknown>).siteCacheHit === true), 'borrowed destination facts marked');
});

test('same-site redirect writes no alias; shared shortener identities never merge destinations', async () => {
  const { store, rows } = makeStore();
  const fetched: string[] = [];
  const fetchImpl = makeRedirectFetch(fetched);
  const base = { videoDescriptions: DESCS, externalFetchImpl: fetchImpl, urlFailureHistoryLoader: async () => [], siteInspectionStore: store } as const;

  await runChannelInspection({
    ...base, channelId: 'UCRedirect000000000003', channelName: 'Same Site', channelBio: 'Trading educator',
    channelLinks: ['https://apextrader.com/old'],
  });
  assert.equal(rows.get('apextrader.com')?.outcome !== 'REDIRECTED', true, 'same-identity redirect keeps one facts row');
  assert.equal(rows.get('apextrader.com')?.finalUrl, 'https://apextrader.com/new');

  await runChannelInspection({
    ...base, channelId: 'UCRedirect000000000004', channelName: 'Tenant One', channelBio: 'Trading educator',
    channelLinks: ['https://bit.ly/x1'],
  });
  assert.equal(rows.get('bit.ly')?.outcome, 'REDIRECTED', 'shortener alias recorded');
  assert.equal(rows.get('linktr.ee/trader1')?.identityTier, 'C', 'path-tenant destination keeps its tenant identity');
  const before = fetched.length;
  await runChannelInspection({
    ...base, channelId: 'UCRedirect000000000005', channelName: 'Tenant Two', channelBio: 'Another educator',
    channelLinks: ['https://bit.ly/x2'],
  });
  assert.ok(fetched.some(url => url.includes('/x2')), 'different short link never borrows another destination through the shared identity');
  assert.ok(fetched.length > before);
});

function makeCoexistFetch(fetched: string[]) {
  return (async (url: unknown) => {
    const target = String(url);
    fetched.push(target);
    const respond = (html: string, finalUrl?: string) => {
      const response = new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
      if (finalUrl) Object.defineProperty(response, 'url', { value: finalUrl });
      return response;
    };
    if (target.startsWith('https://shortener.com/a')) {
      return respond('<html><body>A hub https://discord.gg/invitea today</body></html>', 'https://site-a.com/');
    }
    if (target.startsWith('https://shortener.com/b')) {
      return respond('<html><body>B hub https://discord.gg/inviteb today</body></html>', 'https://site-b.com/');
    }
    if (target.startsWith('https://shortener.com/c')) {
      return respond('<html><body>C hub https://discord.gg/invitea today</body></html>', 'https://site-a.com/');
    }
    return respond('<html><body>plain creator site</body></html>');
  }) as typeof fetch;
}

test('shared shortener host: distinct wrappers coexist, resolve independently, never cross-borrow', async () => {
  const { store, rows } = makeStore();
  const fetched: string[] = [];
  const fetchImpl = makeCoexistFetch(fetched);
  const base = { videoDescriptions: DESCS, externalFetchImpl: fetchImpl, urlFailureHistoryLoader: async () => [], siteInspectionStore: store } as const;
  const run = (channelId: string, channelName: string, link: string) => runChannelInspection({
    ...base, channelId, channelName, channelBio: 'Trading educator', channelLinks: [link],
  });

  await run('UCShortCoexist000001', 'Wrapper A', 'https://shortener.com/a');
  await run('UCShortCoexist000002', 'Wrapper B', 'https://shortener.com/b');
  const alias = rows.get('shortener.com');
  assert.equal(alias?.outcome, 'REDIRECTED', 'one shared alias row');
  assert.equal((alias?.observations as unknown[]).length, 2, 'both bindings coexist instead of overwriting');
  assert.ok(rows.has('site-a.com') && rows.has('site-b.com'), 'each destination keeps its own facts');

  const beforeRevisits = fetched.length;
  const revisitA = await run('UCShortCoexist000003', 'Wrapper A again', 'https://shortener.com/a');
  const revisitB = await run('UCShortCoexist000004', 'Wrapper B again', 'https://shortener.com/b');
  assert.equal(fetched.length, beforeRevisits, 'revisits reuse their own destinations without recrawling');
  assert.equal(revisitA.foundInvite, 'invitea', 'A never borrows B facts');
  assert.equal(revisitB.foundInvite, 'inviteb', 'B never borrows A facts');

  await run('UCShortCoexist000005', 'Wrapper C', 'https://shortener.com/c');
  assert.equal((rows.get('shortener.com')?.observations as unknown[]).length, 3, 'same-destination wrappers accumulate bindings');
  const beforeCRevisit = fetched.length;
  const revisitC = await run('UCShortCoexist000006', 'Wrapper C again', 'https://shortener.com/c');
  assert.equal(fetched.length, beforeCRevisit, 'same-destination aliases deduplicate repeat inspections');
  assert.equal(revisitC.foundInvite, 'invitea');
});

function makeRenderFallback(calls: string[], result: { complete: boolean; timedOut: boolean; inspectedPages: number }) {
  return (async (seedUrl: string) => {
    calls.push(seedUrl);
    return {
      foundInvite: null, foundLocation: seedUrl, candidates: [],
      inspectedPages: result.inspectedPages, scrolls: 0, clicks: 0,
      complete: result.complete, retryable: !result.complete, timedOut: result.timedOut,
      telemetry: undefined, detail: result.complete ? 'render complete in test' : 'render incomplete in test',
    };
  }) as unknown as (seedUrl: string) => Promise<never>;
}

function makeTradingBase(store: ReturnType<typeof makeStore>['store'], fetched: string[], renderCalls: string[], rendered: { complete: boolean; timedOut: boolean; inspectedPages: number }) {
  return {
    videoDescriptions: DESCS,
    externalFetchImpl: makeFetch(fetched),
    urlFailureHistoryLoader: async () => [],
    recentVideoDescriptionsLoader: async () => [],
    renderedFallback: makeRenderFallback(renderCalls, rendered),
    creatorLikelyTrading: true,
    siteInspectionStore: store,
  } as const;
}

test('timeout render leaves renderedCovered false so the next creator re-renders', async () => {
  const { store, rows } = makeStore();
  const fetched: string[] = [];
  const renderCalls: string[] = [];
  const seed = 'https://rendersite.example/';
  const run = (channelId: string, channelName: string) => runChannelInspection({
    ...makeTradingBase(store, fetched, renderCalls, { complete: false, timedOut: true, inspectedPages: 2 }),
    channelId, channelName, channelBio: 'Trading educator', channelLinks: [seed],
  });

  await run('UCRenderTimeout00000001', 'Render A');
  assert.equal(renderCalls.length, 1, 'first inspection renders');
  assert.equal(rows.get('rendersite.example')?.renderedCovered, false, 'timeout never satisfies rendered coverage');

  await run('UCRenderTimeout00000002', 'Render B');
  assert.equal(renderCalls.length, 2, 'incomplete coverage triggers rendered acquisition again');
});

test('complete render satisfies coverage and is borrowed without re-render', async () => {
  const { store, rows } = makeStore();
  const fetched: string[] = [];
  const renderCalls: string[] = [];
  const seed = 'https://rendersite.example/';
  const run = (channelId: string, channelName: string) => runChannelInspection({
    ...makeTradingBase(store, fetched, renderCalls, { complete: true, timedOut: false, inspectedPages: 2 }),
    channelId, channelName, channelBio: 'Trading educator', channelLinks: [seed],
  });

  await run('UCRenderComplete000001', 'Render C');
  assert.equal(rows.get('rendersite.example')?.renderedCovered, true, 'complete processed render satisfies coverage');
  const fetchedAfterFirst = fetched.length;
  await run('UCRenderComplete000002', 'Render D');
  assert.equal(renderCalls.length, 1, 'covered render is not repeated');
  assert.equal(fetched.length, fetchedAfterFirst, 'covered borrow skips the static crawl too');
});

function failureHistory(url: string, count: number, newestFirst = true) {
  const rows = Array.from({ length: count }, (_, index) => ({
    requestedUrl: url,
    failureClass: 'NETWORK_FAILURE',
    outcome: 'ACQUISITION_FAILED',
    observedAt: new Date(Date.now() - index * 60_000).toISOString(),
  }));
  return newestFirst ? rows : [...rows].reverse();
}

test('repeat-failure skip stays authoritative over cache borrowing', async () => {
  const { store } = makeStore();
  const fetched: string[] = [];
  const seed = 'https://flakysite.example/';
  const seedRow = async (channelId: string, channelName: string, history: ReturnType<typeof failureHistory>) => runChannelInspection({
    videoDescriptions: DESCS, externalFetchImpl: makeFetch(fetched),
    urlFailureHistoryLoader: async () => history,
    siteInspectionStore: store, channelId, channelName, channelBio: 'Trading educator', channelLinks: [seed],
  });

  await seedRow('UCFailureCap00000001', 'Flaky A', []);
  const cachedFetches = fetched.length;
  assert.ok(cachedFetches >= 1, 'first inspection crawls and caches');

  const below = await seedRow('UCFailureCap00000002', 'Flaky B', failureHistory(seed, 4));
  assert.ok(
    (below.acquisitionOutcomes || []).some(item => (item as unknown as Record<string, unknown>).siteCacheHit === true),
    'below threshold the reusable row still borrows',
  );

  const beforeSkip = fetched.length;
  const skipped = await seedRow('UCFailureCap00000003', 'Flaky C', failureHistory(seed, 5));
  assert.equal(fetched.length, beforeSkip, 'over-threshold URL is skipped before any borrow or crawl');
  assert.ok(
    !(skipped.acquisitionOutcomes || []).some(item => (item as unknown as Record<string, unknown>).siteCacheHit === true),
    'no borrowed observations escape the skip',
  );

  const reset = await seedRow('UCFailureCap00000004', 'Flaky D', [
    { requestedUrl: seed, failureClass: '', outcome: 'INSPECTED_NO_MATCH', observedAt: new Date().toISOString() },
    ...failureHistory(seed, 5),
  ]);
  assert.ok(
    (reset.acquisitionOutcomes || []).some(item => (item as unknown as Record<string, unknown>).siteCacheHit === true) || fetched.length > beforeSkip,
    'new success evidence resets the skip through existing policy',
  );
});
