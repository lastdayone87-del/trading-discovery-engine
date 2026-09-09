import test from 'node:test';
import assert from 'node:assert/strict';
import {
  YOUTUBE_INNERTUBE_PROVIDER,
  YOUTUBE_INNERTUBE_PROVIDER_KEY,
  YOUTUBE_INNERTUBE_SURFACE,
  YOUTUBE_INNERTUBE_CAPABILITY,
  YOUTUBE_INNERTUBE_COST_DOMAIN,
  YOUTUBE_INNERTUBE_MAX_PAGES,
  INNERTUBE_RATE_LIMITED_CODE,
  mapInnertubeChannelsToRaw,
  parseInnertubeCursor,
  innertubeTimeoutMs,
  innertubeCooldownMs,
  innertubeCooldownRemainingMs,
  resetInnertubeCooldownForTests,
  setInnertubeSessionFactoryForTests,
  executeInnertubeRetrievalPage,
} from './youtubeInnertubeProvider';

const UC = 'UCabcdefghijklmnopqrstuv';

test('innertube allocation identity is fully namespaced away from the official provider', () => {
  assert.equal(YOUTUBE_INNERTUBE_PROVIDER.providerKey, YOUTUBE_INNERTUBE_PROVIDER_KEY);
  assert.notEqual(YOUTUBE_INNERTUBE_PROVIDER.providerKey, 'youtube-search');
  assert.equal(YOUTUBE_INNERTUBE_PROVIDER.capability, YOUTUBE_INNERTUBE_CAPABILITY);
  assert.notEqual(YOUTUBE_INNERTUBE_PROVIDER.costDomain, 'YOUTUBE_DATA_API');
  assert.equal(YOUTUBE_INNERTUBE_PROVIDER.costDomain, YOUTUBE_INNERTUBE_COST_DOMAIN);
  assert.equal(YOUTUBE_INNERTUBE_PROVIDER.continuationOwner, 'PHASE_9');
  assert.ok(Object.isFrozen(YOUTUBE_INNERTUBE_PROVIDER));
  assert.equal(YOUTUBE_INNERTUBE_SURFACE, 'YOUTUBE_NATIVE');
});

test('channel mapping resolves UC ids, drops unresolvable nodes, never fabricates', () => {
  const mapped = mapInnertubeChannelsToRaw([
    { id: 'other', author: { id: UC, name: 'Trader One' }, subscriber_count: { text: '10K subscribers' }, description_snippet: { text: '' } },
    { id: UC.replace('U', 'X'), author: { id: 'nope' } },
    {},
  ], 'Germany');
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].channelId, UC);
  assert.equal(mapped[0].channelName, 'Trader One');
  assert.equal(mapped[0].youtubeUrl, `https://www.youtube.com/channel/${UC}`);
  assert.deepEqual(mapped[0].videoTitles, []);
  assert.equal(mapped[0].subscriberCount, '10K subscribers');
  assert.deepEqual(mapped[0].videoTitles, []);
});

test('channel mapping falls back to node id and channel id when author is missing', () => {
  const [byNode] = mapInnertubeChannelsToRaw([{ id: UC }], 'France');
  assert.equal(byNode.channelId, UC);
  assert.equal(byNode.channelName, UC);
});

test('cursor parsing is bounded to the page cap', () => {
  assert.equal(parseInnertubeCursor(null), 1);
  assert.equal(parseInnertubeCursor(''), 1);
  assert.equal(parseInnertubeCursor('2'), 2);
  assert.equal(parseInnertubeCursor('99'), YOUTUBE_INNERTUBE_MAX_PAGES);
  assert.equal(parseInnertubeCursor('junk'), 1);
});

test('timeout and cooldown env parsing mirrors provider conventions', () => {
  assert.equal(innertubeTimeoutMs({} as any), 30000);
  assert.equal(innertubeTimeoutMs({ YOUTUBE_INNERTUBE_TIMEOUT_MS: '5000' } as any), 5000);
  assert.equal(innertubeCooldownMs({} as any), 90000);
});

test('executor returns mapped channels with continuation and zero official cost', async () => {
  resetInnertubeCooldownForTests();
  const feed = {
    channels: [{ author: { id: UC, name: 'Desk' } }],
    has_continuation: true,
    getContinuation: async () => null,
  };
  setInnertubeSessionFactoryForTests(async () => ({ search: async () => feed }));
  try {
    const page = await executeInnertubeRetrievalPage({
      provider: { ...YOUTUBE_INNERTUBE_PROVIDER },
      query: 'trading',
      country: 'Spain',
      lane: 'CHANNEL',
      cursor: null,
      ordering: 'RELEVANCE',
    } as any);
    assert.equal(page.channels.length, 1);
    assert.equal(page.channels[0].channelId, UC);
    assert.equal(page.nextPageToken, '2');
    assert.equal(page.providerCostUsd, 0);
  } finally {
    setInnertubeSessionFactoryForTests(null);
    resetInnertubeCooldownForTests();
  }
});

test('rate-limit failure arms only the innertube-local cooldown', async () => {
  resetInnertubeCooldownForTests();
  setInnertubeSessionFactoryForTests(async () => ({
    search: async () => { throw new Error('429 Too Many Requests'); },
  }));
  try {
    await assert.rejects(
      executeInnertubeRetrievalPage({
        provider: { ...YOUTUBE_INNERTUBE_PROVIDER }, query: 'x', country: 'US', lane: 'CHANNEL', cursor: null, ordering: 'RELEVANCE',
      } as any),
      (error: any) => error?.code === INNERTUBE_RATE_LIMITED_CODE,
    );
    assert.ok(innertubeCooldownRemainingMs() > 0);
    await assert.rejects(
      executeInnertubeRetrievalPage({
        provider: { ...YOUTUBE_INNERTUBE_PROVIDER }, query: 'x', country: 'US', lane: 'CHANNEL', cursor: null, ordering: 'RELEVANCE',
      } as any),
      (error: any) => error?.code === INNERTUBE_RATE_LIMITED_CODE,
    );
  } finally {
    setInnertubeSessionFactoryForTests(null);
    resetInnertubeCooldownForTests();
  }
  assert.equal(innertubeCooldownRemainingMs(), 0);
});

test('innertube module shares no runtime state with the official youtube module', async () => {
  const source = await import('node:fs').then((fs) => fs.readFileSync(new URL('./youtubeInnertubeProvider.ts', import.meta.url), 'utf8'));
  // Type-only imports are erased at compile time; only value imports couple runtimes.
  const valueImports = source.split('\n').filter((line) => !/^\s*import\s+type\b/.test(line)).join('\n');
  assert.doesNotMatch(valueImports, /from '\.\/youtube'/);
  assert.doesNotMatch(source, /YOUTUBE_API_KEY|YOUTUBE_DATA_API|youtubeFetch|getYouTubeKeyPool/);
});
