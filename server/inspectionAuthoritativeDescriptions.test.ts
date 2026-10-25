import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergeSampledVideoDescriptions, normalizeSampledVideoDescriptions, runChannelInspection } from './inspector';

const CHANNEL_ID = 'UCzzzzzzzzzzzzzzzzzzzzzz';

function sampled(prefix: string, count = 10): Array<{ videoId: string; description: string }> {
  return Array.from({ length: count }, (_, index) => ({
    videoId: `video-${index}`,
    description: `${prefix} ${index}`,
  }));
}

test('authoritative enrichment sample is reused without a second recent-videos search', async () => {
  const authoritative = sampled('enriched recent upload');
  let loaderCalls = 0;
  const result = await runChannelInspection({
    channelId: CHANNEL_ID,
    channelName: 'Test Channel',
    channelBio: 'Trading creator',
    channelLinks: [],
    videoDescriptions: authoritative.map(item => item.description),
    videoDescriptionsAuthoritative: true,
    recentVideoDescriptions: authoritative,
    creatorLikelyTrading: true,
    recentVideoDescriptionsLoader: async () => {
      loaderCalls += 1;
      return [];
    },
  });
  assert.equal(loaderCalls, 0, 'Gate 3 must not repeat the 100-unit recent-videos search');
  assert.deepEqual(result.observedVideoDescriptions, authoritative.map(item => item.description));
  assert.equal(result.observedVideoDescriptionsAuthoritative, true);
});

test('authoritative descriptions without separate video IDs still avoid the loader', async () => {
  const descriptions = sampled('authoritative text').map(item => item.description);
  let loaderCalls = 0;
  const result = await runChannelInspection({
    channelId: CHANNEL_ID,
    channelName: 'Test Channel',
    channelBio: 'Trading creator',
    channelLinks: [],
    videoDescriptions: descriptions,
    videoDescriptionsAuthoritative: true,
    creatorLikelyTrading: true,
    recentVideoDescriptionsLoader: async () => {
      loaderCalls += 1;
      return [];
    },
  });
  assert.equal(loaderCalls, 0);
  assert.deepEqual(result.observedVideoDescriptions, descriptions);
  assert.equal(result.observedVideoDescriptionsAuthoritative, true);
});

test('search-selected descriptions keep the fresh loader path', async () => {
  const preloaded = sampled('search snippet', 5).map(item => item.description);
  const fresh = sampled('fresh channel sample');
  let loaderCalls = 0;
  const result = await runChannelInspection({
    channelId: CHANNEL_ID,
    channelName: 'Test Channel',
    channelBio: 'Trading creator',
    channelLinks: [],
    videoDescriptions: preloaded,
    videoDescriptionsAuthoritative: false,
    creatorLikelyTrading: true,
    recentVideoDescriptionsLoader: async () => {
      loaderCalls += 1;
      return fresh;
    },
  });
  assert.equal(loaderCalls, 1);
  assert.deepEqual(result.observedVideoDescriptions, fresh.map(item => item.description));
  assert.equal(result.observedVideoDescriptionsAuthoritative, true);
  for (const snippet of preloaded) {
    assert.ok(!(result.observedVideoDescriptions || []).includes(snippet));
  }
});

test('unmarked short samples retain the legacy fallback loader', async () => {
  const fresh = sampled('fallback sample');
  let loaderCalls = 0;
  const result = await runChannelInspection({
    channelId: CHANNEL_ID,
    channelName: 'Test Channel',
    channelBio: 'Trading creator',
    channelLinks: [],
    videoDescriptions: ['only one search snippet'],
    recentVideoDescriptionsLoader: async () => {
      loaderCalls += 1;
      return fresh;
    },
  });
  assert.equal(loaderCalls, 1);
  assert.deepEqual(result.observedVideoDescriptions, fresh.map(item => item.description));
  assert.equal(result.observedVideoDescriptionsAuthoritative, true);
});

test('ID-bearing top-up upgrades a text-only authoritative observation', () => {
  const textOnly = normalizeSampledVideoDescriptions(['same upload text']);
  const withId = normalizeSampledVideoDescriptions([{ videoId: 'video-1', description: 'same upload text' }]);
  const merged = mergeSampledVideoDescriptions(textOnly, withId);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.videoId, 'video-1');
  // A genuinely distinct video with the same text still votes separately.
  const twins = mergeSampledVideoDescriptions(
    normalizeSampledVideoDescriptions([{ videoId: 'video-2', description: 'same upload text' }]),
    normalizeSampledVideoDescriptions([{ videoId: 'video-3', description: 'same upload text' }]),
  );
  assert.equal(twins.length, 2);
});

test('reused authoritative descriptions record a no-match acquisition observation', async () => {
  const authoritative = sampled('no invite here');
  const result = await runChannelInspection({
    channelId: CHANNEL_ID,
    channelName: 'Test Channel',
    channelBio: 'Trading creator',
    channelLinks: [],
    videoDescriptions: authoritative.map(item => item.description),
    videoDescriptionsAuthoritative: true,
    recentVideoDescriptions: authoritative,
    creatorLikelyTrading: true,
    recentVideoDescriptionsLoader: async () => {
      throw new Error('loader must not run for authoritative input');
    },
  });
  const reused = (result.acquisitionOutcomes || []).filter(
    outcome => outcome.requestedUrl === `enrichment:channel:${CHANNEL_ID}:recent-video-descriptions`,
  );
  assert.equal(reused.length, 1);
  assert.equal(reused[0]?.outcome, 'INSPECTED_NO_MATCH');
});

test('Step 3 inspects the authoritative seed and top-up before preloaded snippets', () => {
  const source = readFileSync(new URL('./inspector.ts', import.meta.url), 'utf8');
  assert.match(
    source,
    /const orderedVideoDescs=authoritativeInspectionDescriptions\.length\?Array\.from\(new Set\(\[\.\.\.channelSampledDescs\(\),\.\.\.videoDescs\]\)\):videoDescs;const descriptionsToInspect=orderedVideoDescs\.slice\(0,5\)/,
  );
});

test('queue threading passes provenance and video IDs into Gate 3 inspection', () => {
  const source = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
  assert.match(source, /videoDescriptionsAuthoritative: rawDetails\?\.videoDescriptionsAuthoritative/);
  assert.match(source, /recentVideoDescriptions: rawDetails\?\.videoDescriptionsAuthoritative/);
  assert.match(source, /rawDetails\.videos\.map\(video => \(\{ videoId: video\.id, description: video\.description \}\)\)/);
});
