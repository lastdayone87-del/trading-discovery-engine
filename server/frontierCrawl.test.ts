import test from 'node:test';
import assert from 'node:assert/strict';
import { crawlExternalLinks } from './inspector';
import type { FrontierCrawlOptions } from './frontierManager';

function makeSiteFetch() {
  const fetched: string[] = [];
  const pages: Record<string, string> = {
    'https://wired.example/': '<html><body>Hub. <a href="/p1">join one</a> <a href="/p2">community two</a></body></html>',
    'https://wired.example/p1': '<html><body>One. Join https://discord.gg/wiredroom today.</body></html>',
    'https://wired.example/p2': '<html><body>Two. Nothing here.</body></html>',
  };
  const fetchImpl = (async (url: unknown) => {
    const target = String(url);
    fetched.push(target);
    const body = pages[target] || '<html><body>empty</body></html>';
    return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
  }) as typeof fetch;
  return { fetchImpl, fetched };
}

const OPTS: FrontierCrawlOptions = { enabled: true, siteIdentity: 'wired.example' };

test('flag-on crawl with open floors matches flag-off evidence exactly', async () => {
  const plain = makeSiteFetch();
  const legacy = await crawlExternalLinks(['https://wired.example/'], [], undefined, plain.fetchImpl);
  const wired = makeSiteFetch();
  const gated = await crawlExternalLinks(
    ['https://wired.example/'], [], undefined, wired.fetchImpl,
    'CREATOR_WEBSITES', false, undefined, false, OPTS,
  );
  assert.equal(gated.foundInvite, 'wiredroom');
  assert.equal(legacy.foundInvite, gated.foundInvite, 'gated crawl recovers identical evidence');
  assert.deepEqual(
    gated.candidates.map(candidate => candidate.nativeInviteCode).sort(),
    legacy.candidates.map(candidate => candidate.nativeInviteCode).sort(),
  );
});

test('conservative default floors never stop a known-evidence crawl early', async () => {
  const { fetchImpl, fetched } = makeSiteFetch();
  const result = await crawlExternalLinks(
    ['https://wired.example/'], [], undefined, fetchImpl,
    'CREATOR_WEBSITES', false, undefined, false,
    { ...OPTS, marginalFloor: 0, remainingValueFloor: 0, marginalWindow: 5 },
  );
  assert.equal(result.foundInvite, 'wiredroom', 'depth-2 evidence reached under default floors');
  assert.ok(fetched.some(url => url.includes('/p1')), 'evidence page actually fetched, not assumed');
});

test('arbiter halt is observable, reasoned, and never a clean negative', async () => {
  const { fetchImpl, fetched } = makeSiteFetch();
  const result = await crawlExternalLinks(
    ['https://wired.example/'], [], undefined, fetchImpl,
    'CREATOR_WEBSITES', false, undefined, false,
    // Window of one: the single root observation completes the window, so
    // the floor applies immediately. Larger windows warm up first (tested
    // in frontierManager.test.ts); production defaults never stop early.
    { ...OPTS, marginalFloor: 1000, remainingValueFloor: 0, marginalWindow: 1 },
  );
  assert.equal(fetched.length, 1, 'only the root fetched once the floor trips');
  assert.equal(result.outcome, 'PARTIALLY_INSPECTED', 'halted crawl reports partial, never clean');
  const ceilings = result.observations
    .map(observation => {
      const telemetry = observation.telemetry as { ceiling?: { kind?: unknown } | string } | undefined;
      return typeof telemetry?.ceiling === 'string' ? telemetry.ceiling : telemetry?.ceiling?.kind;
    })
    .filter(Boolean);
  assert.ok(ceilings.includes('frontier-yield'), 'halt recorded under its own ceiling kind');
});
