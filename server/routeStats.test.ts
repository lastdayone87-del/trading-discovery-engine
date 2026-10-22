import test from 'node:test';
import assert from 'node:assert/strict';
import { crawlExternalLinks as crawlExternalLinksImpl } from './inspector';
import { crawlExternalLinksForTest as crawlExternalLinks } from './testCrawlHelpers';
import { aggregateRouteStats, buildWeightSnapshot, computeDomainWeights, type RouteStats } from './domainLearner';
import type { FrontierCrawlOptions } from './frontierManager';

/**
 * P-D production data path: completed inspection outcomes must reach
 * domain_route_stats (via the existing accumulateRouteStats mechanism)
 * so the offline learner stops returning NO_DATA. Blocked/unreachable
 * outcomes must never be recorded as attempts (never negative evidence).
 */
function makeSiteFetch() {
  const pages: Record<string, { status: number; body: string }> = {
    'https://routestat.example/': {
      status: 200,
      body: '<html><body>Hub. <a href="/p/1">join one</a> <a href="/p/2">community two</a> <a href="/p/3">join three</a> <a href="/p/4">community four</a></body></html>',
    },
    'https://routestat.example/p/1': { status: 200, body: '<html><body>One. Nothing here.</body></html>' },
    'https://routestat.example/p/2': { status: 200, body: '<html><body>Two. Join https://discord.gg/routeroom today.</body></html>' },
    'https://routestat.example/p/3': { status: 500, body: 'server error' },
    'https://routestat.example/p/4': { status: 200, body: '<html><body>Four. Nothing here.</body></html>' },
  };
  const fetchImpl = (async (url: unknown) => {
    const target = String(url);
    const page = pages[target];
    if (!page) return new Response('missing', { status: 404, headers: { 'content-type': 'text/plain' } });
    return new Response(page.body, { status: page.status, headers: { 'content-type': 'text/html' } });
  }) as typeof fetch;
  return { fetchImpl };
}

type CapturedRow = { siteIdentity: string; routePattern: string; evidenceUnits: number; observedAt?: string | null };

test('completed inspection outcomes reach route statistics; unreachable pages excluded', async () => {
  const { fetchImpl } = makeSiteFetch();
  const captured: CapturedRow[] = [];
  const opts: FrontierCrawlOptions = {
    enabled: true,
    siteIdentity: 'routestat.example',
    marginalFloor: 0,
    remainingValueFloor: 0,
    marginalWindow: 5,
    routeStatsSink: async row => {
      captured.push(row);
    },
  };
  const result = await crawlExternalLinks(
    ['https://routestat.example/'], [], undefined, fetchImpl,
    'CREATOR_WEBSITES', false, undefined, false, opts,
  );
  assert.equal(result.foundInvite, 'routeroom', 'evidence page reached under open floors');
  // Five pages inspected (root + four children); the 500 child resolves
  // UNREACHABLE and must never become an attempt. Four rows accumulate.
  assert.equal(captured.length, 4, `inspected pages accumulate, unreachable excluded (got ${captured.length})`);
  assert.ok(captured.every(row => row.siteIdentity === 'routestat.example'));
  const patterns = captured.map(row => row.routePattern).sort();
  assert.deepEqual(patterns, [
    'routestat.example/',
    'routestat.example/p/{n}',
    'routestat.example/p/{n}',
    'routestat.example/p/{n}',
  ], 'numeric segments collapse to one route pattern; root keeps its own');
  const evidenceRows = captured.filter(row => row.evidenceUnits > 0);
  assert.equal(evidenceRows.length, 1, 'exactly the invite-bearing page carries evidence units');
  assert.equal(evidenceRows[0].routePattern, 'routestat.example/p/{n}');
});

test('accumulated observations feed the offline learner into a DRAFT snapshot', async () => {
  const { fetchImpl } = makeSiteFetch();
  const captured: CapturedRow[] = [];
  await crawlExternalLinks(
    ['https://routestat.example/'], [], undefined, fetchImpl,
    'CREATOR_WEBSITES', false, undefined, false,
    {
      enabled: true, siteIdentity: 'routestat.example',
      marginalFloor: 0, remainingValueFloor: 0, marginalWindow: 5,
      routeStatsSink: async row => {
        captured.push(row);
      },
    },
  );
  assert.ok(captured.length > 0, 'production path produced observations (no NO_DATA)');
  // Shape captured rows into learner input (same aggregation the batch
  // runner performs over domain_route_stats counters).
  const byPattern = new Map<string, { attempts: number; hits: number; units: number; last: string | null }>();
  for (const row of captured) {
    const current = byPattern.get(row.routePattern) || { attempts: 0, hits: 0, units: 0, last: null as string | null };
    current.attempts += 1;
    if (row.evidenceUnits > 0) {
      current.hits += 1;
      current.units += row.evidenceUnits;
    }
    if (row.observedAt && (!current.last || row.observedAt > current.last)) current.last = row.observedAt;
    byPattern.set(row.routePattern, current);
  }
  const stats: RouteStats[] = [...byPattern.entries()].map(([routePattern, counts]) => ({
    siteIdentity: 'routestat.example',
    routePattern,
    attempts: counts.attempts,
    evidenceHits: counts.hits,
    evidenceUnits: counts.units,
    lastObservedAt: counts.last,
  }));
  const computed = computeDomainWeights('routestat.example', stats, { quorum: 3 });
  assert.equal(computed.metrics.qualifiedRoutes, 1, 'three attempts on one pattern meet quorum');
  assert.ok(computed.weights['routestat.example/p/{n}'] > 0, 'evidence-bearing route earns positive weight');
  assert.equal(computed.weights['routestat.example/'], 0, 'single-observation root stays below quorum (never flips on one sample)');
  const snapshot = buildWeightSnapshot(computed);
  assert.equal(snapshot.status, 'DRAFT', 'learner output starts DRAFT, never auto-promoted');
  assert.match(snapshot.version, /^dw-[0-9a-f]{16}$/);
  // Cross-check against the pure aggregator over equivalent observations.
  const now = new Date().toISOString();
  const regrouped = aggregateRouteStats([
    { siteIdentity: 'routestat.example', pageUrl: 'https://routestat.example/p/1', evidenceUnits: 0, terminalState: 'INSPECTED_NO_MATCH', observedAt: now },
    { siteIdentity: 'routestat.example', pageUrl: 'https://routestat.example/p/2', evidenceUnits: 1, terminalState: 'FOUND', observedAt: now },
    { siteIdentity: 'routestat.example', pageUrl: 'https://routestat.example/p/4', evidenceUnits: 0, terminalState: 'INSPECTED_NO_MATCH', observedAt: now },
  ]);
  const fromSink = stats.find(stat => stat.routePattern === 'routestat.example/p/{n}')!;
  const fromCoverage = regrouped.find(stat => stat.routePattern === 'routestat.example/p/{n}')!;
  assert.deepEqual(
    { ...fromSink, lastObservedAt: null },
    { ...fromCoverage, lastObservedAt: null },
    'sink rows aggregate identically to coverage-derived observations (timestamps excluded)',
  );
  assert.ok(fromSink.lastObservedAt && fromCoverage.lastObservedAt, 'both carry observation timestamps');
});
