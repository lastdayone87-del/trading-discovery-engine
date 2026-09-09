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
  INNERTUBE_TIMEOUT_CODE,
  INNERTUBE_CONTINUATION_UNAVAILABLE_CODE,
  mapInnertubeChannelsToRaw,
  mapInnertubeVideosToRaw,
  parseInnertubeCursor,
  innertubeTimeoutMs,
  innertubeCooldownMs,
  innertubeCooldownRemainingMs,
  resetInnertubeCooldownForTests,
  setInnertubeSessionFactoryForTests,
  withInnertubeDeadline,
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

test('channel mapping sets CHANNEL provenance like the official provider', () => {
  const [mapped] = mapInnertubeChannelsToRaw(
    [{ author: { id: UC, name: 'Desk' }, description_snippet: { text: 'bio' } }],
    'US',
  );
  assert.deepEqual(mapped.matchedDocument, {
    type: 'CHANNEL',
    providerNativeId: UC,
    title: 'Desk',
    description: 'bio',
    locator: `youtube:channel:${UC}`,
  });
  assert.equal(mapped.description, 'bio');
  assert.deepEqual(mapped.videoTitles, []);
});

test('video mapping attributes author channels with VIDEO provenance', () => {
  const mapped = mapInnertubeVideosToRaw([
    { video_id: 'vid1', title: { text: 'Scalp tutorial' }, author: { id: UC, name: 'Desk' }, description_snippet: { text: 'entries' } },
    { video_id: '', title: { text: 'no id' }, author: { id: UC } },
    { video_id: 'vid2', title: { text: 't' }, author: { id: 'not-a-channel' } },
  ]);
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].channelId, UC);
  assert.deepEqual(mapped[0].videoTitles, ['Scalp tutorial']);
  assert.deepEqual(mapped[0].videoDescriptions, ['entries']);
  // VIDEO snippets describe the video; channel bio stays empty until enrichment.
  assert.equal(mapped[0].description, '');
  assert.deepEqual(mapped[0].matchedDocument, {
    type: 'VIDEO',
    providerNativeId: 'vid1',
    title: 'Scalp tutorial',
    description: 'entries',
    locator: 'youtube:video:vid1',
  });
  // No fabricated timestamps: relative display text is never a publishedAt.
  assert.equal((mapped[0].matchedDocument as Record<string, unknown>).publishedAt, undefined);
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

test('VIDEO lane performs genuine video search with video provenance', async () => {
  resetInnertubeCooldownForTests();
  const seen: Array<{ query: string; filters?: Record<string, unknown> }> = [];
  const feed = {
    videos: [{ video_id: 'vid9', title: { text: 'NQ scalp' }, author: { id: UC, name: 'Desk' } }],
    has_continuation: false,
  };
  setInnertubeSessionFactoryForTests(async () => ({
    search: async (query: string, filters?: Record<string, unknown>) => {
      seen.push({ query, filters });
      return feed;
    },
  }));
  try {
    const page = await executeInnertubeRetrievalPage({
      provider: { ...YOUTUBE_INNERTUBE_PROVIDER },
      query: 'scalping',
      country: 'US',
      lane: 'VIDEO',
      cursor: null,
      ordering: 'RELEVANCE',
    } as any);
    assert.deepEqual(seen, [{ query: 'scalping', filters: { type: 'video' } }]);
    assert.equal(page.channels.length, 1);
    assert.equal(page.channels[0].matchedDocument?.type, 'VIDEO');
    assert.equal(page.channels[0].matchedDocument?.locator, 'youtube:video:vid9');
    assert.equal(page.nextPageToken, null);
  } finally {
    setInnertubeSessionFactoryForTests(null);
    resetInnertubeCooldownForTests();
  }
});

test('successful runs emit exactly one SUCCESS event under innertube identity', async () => {
  resetInnertubeCooldownForTests();
  const events: Array<Record<string, unknown>> = [];
  const { setInnertubeEmitSinkForTests } = await import('./youtubeInnertubeProvider');
  setInnertubeEmitSinkForTests(async (event) => { events.push(event as unknown as Record<string, unknown>); });
  setInnertubeSessionFactoryForTests(async () => ({
    search: async () => ({
      channels: [{ author: { id: UC, name: 'Desk' } }],
      has_continuation: false,
    }),
  }));
  try {
    await executeInnertubeRetrievalPage({
      provider: { ...YOUTUBE_INNERTUBE_PROVIDER },
      query: 'trading',
      country: 'US',
      lane: 'CHANNEL',
      cursor: null,
      ordering: 'RELEVANCE',
      queryRunId: 'run-1',
      jobId: 'job-1',
    } as any);
    assert.equal(events.length, 1);
    assert.equal(events[0].provider, 'youtube-innertube');
    assert.equal(events[0].operation, 'search');
    assert.equal(events[0].runId, 'run-1');
    assert.equal(events[0].status, 'SUCCESS');
  } finally {
    setInnertubeEmitSinkForTests(null);
    setInnertubeSessionFactoryForTests(null);
    resetInnertubeCooldownForTests();
  }
});

test('failed runs emit failure telemetry, never SUCCESS', async () => {
  resetInnertubeCooldownForTests();
  const events: Array<Record<string, unknown>> = [];
  const { setInnertubeEmitSinkForTests } = await import('./youtubeInnertubeProvider');
  setInnertubeEmitSinkForTests(async (event) => { events.push(event as unknown as Record<string, unknown>); });
  setInnertubeSessionFactoryForTests(async () => ({
    search: async () => { throw new Error('boom'); },
  }));
  try {
    await assert.rejects(
      executeInnertubeRetrievalPage({
        provider: { ...YOUTUBE_INNERTUBE_PROVIDER },
        query: 'trading',
        country: 'US',
        lane: 'VIDEO',
        cursor: null,
        ordering: 'DATE',
        queryRunId: 'run-2',
        jobId: 'job-2',
      } as any),
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].provider, 'youtube-innertube');
    assert.equal(events[0].runId, 'run-2');
    assert.notEqual(events[0].status, 'SUCCESS');
  } finally {
    setInnertubeEmitSinkForTests(null);
    setInnertubeSessionFactoryForTests(null);
    resetInnertubeCooldownForTests();
  }
});

test('page-2 null continuation fails instead of returning stale success', async () => {
  resetInnertubeCooldownForTests();
  const firstFeed = {
    channels: [{ author: { id: UC, name: 'Desk' } }],
    has_continuation: true,
    getContinuation: async () => null,
  };
  setInnertubeSessionFactoryForTests(async () => ({ search: async () => firstFeed }));
  try {
    await assert.rejects(
      executeInnertubeRetrievalPage({
        provider: { ...YOUTUBE_INNERTUBE_PROVIDER },
        query: 'trading',
        country: 'US',
        lane: 'CHANNEL',
        cursor: '2',
        ordering: 'RELEVANCE',
      } as any),
      (error: any) => error?.code === INNERTUBE_CONTINUATION_UNAVAILABLE_CODE,
    );
  } finally {
    setInnertubeSessionFactoryForTests(null);
    resetInnertubeCooldownForTests();
  }
});

test('wall-clock deadline races hung session work and classifies timeout', async () => {
  resetInnertubeCooldownForTests();
  setInnertubeSessionFactoryForTests(async () => ({
    search: async () => new Promise(() => undefined) as never,
  }));
  const previousTimeout = process.env.YOUTUBE_INNERTUBE_TIMEOUT_MS;
  process.env.YOUTUBE_INNERTUBE_TIMEOUT_MS = '30';
  try {
    await assert.rejects(
      executeInnertubeRetrievalPage({
        provider: { ...YOUTUBE_INNERTUBE_PROVIDER },
        query: 'trading',
        country: 'US',
        lane: 'CHANNEL',
        cursor: null,
        ordering: 'RELEVANCE',
      } as any),
      (error: any) => error?.code === INNERTUBE_TIMEOUT_CODE && error?.retryable === true,
    );
  } finally {
    if (previousTimeout === undefined) delete process.env.YOUTUBE_INNERTUBE_TIMEOUT_MS;
    else process.env.YOUTUBE_INNERTUBE_TIMEOUT_MS = previousTimeout;
    setInnertubeSessionFactoryForTests(null);
    resetInnertubeCooldownForTests();
  }
});

test('withInnertubeDeadline ignores late losers so no post-timeout success emits', async () => {
  let settled = '';
  const slow = new Promise<string>((resolve) => setTimeout(() => { settled = 'late'; resolve('late'); }, 50));
  await assert.rejects(withInnertubeDeadline(slow, 5), (error: any) => error?.code === INNERTUBE_TIMEOUT_CODE);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(settled, 'late');
});

test('request pacing serializes bursts behind a minimum interval', async () => {
  const { resetInnertubePacingForTests, innertubeMinIntervalMs } = await import('./youtubeInnertubeProvider');
  assert.equal(innertubeMinIntervalMs({} as any), 500);
  assert.equal(innertubeMinIntervalMs({ YOUTUBE_INNERTUBE_MIN_INTERVAL_MS: '0' } as any), 0);
  resetInnertubePacingForTests();
  resetInnertubeCooldownForTests();
  const stamps: number[] = [];
  setInnertubeSessionFactoryForTests(async () => ({
    search: async () => {
      stamps.push(Date.now());
      return { channels: [], has_continuation: false };
    },
  }));
  const previousInterval = process.env.YOUTUBE_INNERTUBE_MIN_INTERVAL_MS;
  process.env.YOUTUBE_INNERTUBE_MIN_INTERVAL_MS = '60';
  try {
    await Promise.all([
      executeInnertubeRetrievalPage({
        provider: { ...YOUTUBE_INNERTUBE_PROVIDER }, query: 'a', country: 'US', lane: 'CHANNEL', cursor: null, ordering: 'RELEVANCE',
      } as any),
      executeInnertubeRetrievalPage({
        provider: { ...YOUTUBE_INNERTUBE_PROVIDER }, query: 'b', country: 'US', lane: 'CHANNEL', cursor: null, ordering: 'RELEVANCE',
      } as any),
    ]);
    assert.equal(stamps.length, 2);
    assert.ok(stamps[1] - stamps[0] >= 40, `expected pacing gap, got ${stamps[1] - stamps[0]}ms`);
  } finally {
    if (previousInterval === undefined) delete process.env.YOUTUBE_INNERTUBE_MIN_INTERVAL_MS;
    else process.env.YOUTUBE_INNERTUBE_MIN_INTERVAL_MS = previousInterval;
    setInnertubeSessionFactoryForTests(null);
    resetInnertubeCooldownForTests();
    resetInnertubePacingForTests();
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
