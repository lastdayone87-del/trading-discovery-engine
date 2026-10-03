import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { crawlExternalLinks } from './inspector';

const here = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');

const PLAIN_HTML = '<html><head><title>creator</title></head><body><p>plain creator page</p></body></html>';

const stubFetch = (async () =>
  new Response(PLAIN_HTML, { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;

async function seedObservation(options?: {
  ladderStructured?: boolean;
  frontier?: { enabled: boolean; siteIdentity: string };
  seedAdmission?: { admitted: number; considered: number } | null;
}) {
  const result = await crawlExternalLinks(
    ['https://example.com/creator'],
    [],
    undefined,
    stubFetch,
    'CREATOR_WEBSITES',
    false,
    undefined,
    options?.ladderStructured,
    options?.frontier,
    options?.seedAdmission
  );
  assert.equal(result.observations.length, 1);
  return result.observations[0];
}

test('legacy crawls persist no experiment attribution (identical rows)', async () => {
  const observation = await seedObservation();
  assert.equal(observation.telemetry?.experimentAttribution, undefined);
  const explicitNull = await seedObservation({ ladderStructured: false, seedAdmission: null });
  assert.equal(explicitNull.telemetry?.experimentAttribution, undefined);
});

test('ladder seed admission is attributed with counts, frontier crawls are tagged', async () => {
  const ladder = await seedObservation({
    ladderStructured: true,
    seedAdmission: { admitted: 3, considered: 10 },
  });
  assert.deepEqual(ladder.telemetry?.experimentAttribution?.policies, ['acquisition-ladder-v1']);
  assert.equal(ladder.telemetry?.experimentAttribution?.method, 'structured-navigation');
  assert.equal(ladder.telemetry?.experimentAttribution?.admittedSeeds, 3);
  assert.equal(ladder.telemetry?.experimentAttribution?.consideredSeeds, 10);
  const frontier = await seedObservation({
    frontier: { enabled: true, siteIdentity: 'example.com' },
  });
  assert.deepEqual(frontier.telemetry?.experimentAttribution?.policies, ['frontier-manager-v1']);
  assert.equal(frontier.telemetry?.experimentAttribution?.method, 'frontier-crawl');
});

test('social crawls never inherit website seed-admission counts (call-site contract)', () => {
  const source = here('./inspector.ts');
  const socialCall = /safeCrawlStatic\(item\.url,debugLog,channelData\.externalFetchImpl\|\|fetch,'SOCIAL_PROFILES',item\.wrapperUrl,ladderOn,frontierOptsFor\(item\.url\)(.*?)\)\)\.crawlRes/;
  const socialMatch = source.match(socialCall);
  assert.ok(socialMatch, 'social safeCrawlStatic call site exists');
  assert.doesNotMatch(socialMatch[1], /ladderSeedAdmission/);
  const websiteCall = /safeCrawlStatic\(item\.url,debugLog,channelData\.externalFetchImpl\|\|fetch,'CREATOR_WEBSITES',item\.wrapperUrl,ladderOn,frontierOptsFor\(item\.url\)(.*?)\)\)\.crawlRes/;
  const websiteMatch = source.match(websiteCall);
  assert.ok(websiteMatch, 'website safeCrawlStatic call site exists');
  assert.match(websiteMatch[1], /ladderSeedAdmission/);
});

test('domain-weight shadow evaluates the live capped queue, never the pre-cap list', () => {
  const source = here('./inspector.ts');
  assert.match(source, /evaluateDomainWeightShadow\(shadowSiteIdentity,queue\.map\(item=>\(\{url:item\.url,score:item\.score\}\)\)\)/);
  assert.doesNotMatch(source, /evaluateDomainWeightShadow\(shadowSiteIdentity,dedupedNavigation\.map/);
});
