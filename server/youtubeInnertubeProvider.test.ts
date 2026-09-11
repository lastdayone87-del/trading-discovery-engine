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
  setInnertubeEmitSinkForTests,
  withInnertubeDeadline,
  withInnertubeRemaining,
  resetInnertubePacingForTests,
  innertubePacingGatePassesForTests,
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

test('videos from the same channel merge so dedupe cannot discard evidence', () => {
  const mapped = mapInnertubeVideosToRaw([
    { video_id: 'vid1', title: { text: 'First setup' }, author: { id: UC, name: 'Desk' }, description_snippet: { text: 'd1' } },
    { video_id: 'vid2', title: { text: 'Second setup' }, author: { id: UC, name: 'Desk' }, description_snippet: { text: '' } },
  ]);
  assert.equal(mapped.length, 1);
  assert.deepEqual(mapped[0].videoTitles, ['First setup', 'Second setup']);
  // Index-parallel with titles: the missing description is '' (never omitted).
  assert.deepEqual(mapped[0].videoDescriptions, ['d1', '']);
  // First video's provenance wins, mirroring the official merge.
  assert.equal(mapped[0].matchedDocument?.providerNativeId, 'vid1');
  assert.equal(mapped[0].matchedDocument?.locator, 'youtube:video:vid1');
});

test('a missing description never shifts a later video description onto an earlier title', () => {
  const mapped = mapInnertubeVideosToRaw([
    { video_id: 'vidA', title: { text: 'Title A' }, author: { id: UC, name: 'Desk' } },
    { video_id: 'vidB', title: { text: 'Title B' }, author: { id: UC, name: 'Desk' }, description_snippet: { text: 'desc B' } },
  ]);
  assert.equal(mapped.length, 1);
  const [entry] = mapped;
  // Every per-video field stays tied to its own video record by index.
  assert.deepEqual(entry.videoTitles, ['Title A', 'Title B']);
  assert.deepEqual(entry.videoDescriptions, ['', 'desc B']);
  assert.equal(entry.videoDescriptions[0], '');
  assert.equal(entry.videoDescriptions[1], 'desc B');
  assert.equal(entry.channelId, UC);
  // First video's provenance (matches the official merge rule).
  assert.deepEqual(entry.matchedDocument, {
    type: 'VIDEO',
    providerNativeId: 'vidA',
    title: 'Title A',
    description: '',
    locator: 'youtube:video:vidA',
  });
  assert.equal((entry.matchedDocument as Record<string, unknown>).publishedAt, undefined);
});

test('rawResultCount counts raw results before mapping drops nodes', async () => {
  resetInnertubeCooldownForTests();
  setInnertubeSessionFactoryForTests(async () => ({
    search: async () => ({
      videos: [
        { video_id: 'vid1', title: { text: 'Good' }, author: { id: UC, name: 'Desk' } },
        { video_id: '', title: { text: 'dropped: no id' }, author: { id: UC } },
        { video_id: 'vid9', title: { text: 'dropped: bad channel' }, author: { id: 'x' } },
      ],
      has_continuation: false,
    }),
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
    assert.equal(page.rawResultCount, 3);
    assert.equal(page.channels.length, 1);
  } finally {
    setInnertubeSessionFactoryForTests(null);
    resetInnertubeCooldownForTests();
  }
});

test('continuation 429 keeps its classification and arms the cooldown', async () => {
  resetInnertubeCooldownForTests();
  const firstFeed = {
    videos: [{ video_id: 'vid1', title: { text: 't' }, author: { id: UC } }],
    has_continuation: true,
    getContinuation: async () => { throw new Error('429 Too Many Requests'); },
  };
  setInnertubeSessionFactoryForTests(async () => ({ search: async () => firstFeed }));
  try {
    await assert.rejects(
      executeInnertubeRetrievalPage({
        provider: { ...YOUTUBE_INNERTUBE_PROVIDER },
        query: 'trading',
        country: 'US',
        lane: 'VIDEO',
        cursor: '2',
        ordering: 'RELEVANCE',
      } as any),
      (error: any) => error?.code === INNERTUBE_RATE_LIMITED_CODE && error?.retryable === true,
    );
    assert.ok(innertubeCooldownRemainingMs() > 0, 'continuation 429 must arm backpressure');
  } finally {
    setInnertubeSessionFactoryForTests(null);
    resetInnertubeCooldownForTests();
  }
});

test('each retrieval page passes the pacing gate exactly once per outbound request', async () => {
  // A page-1 retrieval performs one outbound search (1 gate pass); a page-2
  // walk performs one search plus one continuation (2 passes). A duplicate
  // admission per page would show 2 and 3 here instead of 1 and 2.
  const previousInterval = process.env.YOUTUBE_INNERTUBE_MIN_INTERVAL_MS;
  process.env.YOUTUBE_INNERTUBE_MIN_INTERVAL_MS = '0';
  resetInnertubeCooldownForTests();
  resetInnertubePacingForTests();
  setInnertubeEmitSinkForTests(async () => undefined);
  const secondFeed = {
    videos: [{ video_id: 'vid2', title: { text: 't2' }, author: { id: UC } }],
    has_continuation: false,
  };
  const firstFeed = {
    videos: [{ video_id: 'vid1', title: { text: 't1' }, author: { id: UC } }],
    has_continuation: true,
    getContinuation: async () => secondFeed,
  };
  setInnertubeSessionFactoryForTests(async () => ({ search: async () => firstFeed }));
  try {
    assert.equal(innertubePacingGatePassesForTests(), 0);
    const first = await executeInnertubeRetrievalPage({
      provider: { ...YOUTUBE_INNERTUBE_PROVIDER },
      query: 'trading',
      country: 'US',
      lane: 'VIDEO',
      cursor: null,
      ordering: 'RELEVANCE',
    } as any);
    assert.equal(first.channels.length, 1);
    assert.equal(innertubePacingGatePassesForTests(), 1);
    const second = await executeInnertubeRetrievalPage({
      provider: { ...YOUTUBE_INNERTUBE_PROVIDER },
      query: 'trading',
      country: 'US',
      lane: 'VIDEO',
      cursor: '2',
      ordering: 'RELEVANCE',
    } as any);
    assert.equal(second.channels.length, 1);
    assert.equal(second.channels[0].matchedDocument?.providerNativeId, 'vid2');
    assert.equal(innertubePacingGatePassesForTests(), 3);
  } finally {
    if (previousInterval === undefined) delete process.env.YOUTUBE_INNERTUBE_MIN_INTERVAL_MS;
    else process.env.YOUTUBE_INNERTUBE_MIN_INTERVAL_MS = previousInterval;
    setInnertubeEmitSinkForTests(null);
    setInnertubeSessionFactoryForTests(null);
    resetInnertubeCooldownForTests();
    resetInnertubePacingForTests();
  }
});

test('continuation requests pass through pacing like the initial search', async () => {
  resetInnertubeCooldownForTests();
  const { resetInnertubePacingForTests } = await import('./youtubeInnertubeProvider');
  resetInnertubePacingForTests();
  const stamps: number[] = [];
  const secondFeed = {
    videos: [{ video_id: 'vid2', title: { text: 't2' }, author: { id: UC } }],
    has_continuation: false,
  };
  const firstFeed = {
    videos: [{ video_id: 'vid1', title: { text: 't1' }, author: { id: UC } }],
    has_continuation: true,
    getContinuation: async () => {
      stamps.push(Date.now());
      return secondFeed;
    },
  };
  setInnertubeSessionFactoryForTests(async () => ({
    search: async () => {
      stamps.push(Date.now());
      return firstFeed;
    },
  }));
  const previousInterval = process.env.YOUTUBE_INNERTUBE_MIN_INTERVAL_MS;
  process.env.YOUTUBE_INNERTUBE_MIN_INTERVAL_MS = '60';
  try {
    const page = await executeInnertubeRetrievalPage({
      provider: { ...YOUTUBE_INNERTUBE_PROVIDER },
      query: 'trading',
      country: 'US',
      lane: 'VIDEO',
      cursor: '2',
      ordering: 'RELEVANCE',
    } as any);
    assert.equal(page.channels.length, 1);
    assert.equal(stamps.length, 2);
    assert.ok(stamps[1] - stamps[0] >= 40, `search and continuation must be paced, gap was ${stamps[1] - stamps[0]}ms`);
  } finally {
    if (previousInterval === undefined) delete process.env.YOUTUBE_INNERTUBE_MIN_INTERVAL_MS;
    else process.env.YOUTUBE_INNERTUBE_MIN_INTERVAL_MS = previousInterval;
    setInnertubeSessionFactoryForTests(null);
    resetInnertubeCooldownForTests();
    resetInnertubePacingForTests();
  }
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

test('an already-exhausted page deadline rejects immediately with the timeout code', async () => {
  const started = Date.now();
  await assert.rejects(
    withInnertubeRemaining(new Promise(() => undefined), Date.now() - 1),
    (error: any) => error?.code === INNERTUBE_TIMEOUT_CODE && error?.retryable === true,
  );
  assert.ok(Date.now() - started < 50, 'exhausted budget must not wait out another full timeout');
});

test('page timeout is one wall-clock budget across search and continuations', async () => {
  // Budget 300ms. The search consumes ~250ms of it, then the continuation
  // stalls. Per-operation timeouts would allow 250 + 300 = ~550ms; the page
  // deadline must fire at ~300ms from page start instead.
  const previousTimeout = process.env.YOUTUBE_INNERTUBE_TIMEOUT_MS;
  const previousInterval = process.env.YOUTUBE_INNERTUBE_MIN_INTERVAL_MS;
  process.env.YOUTUBE_INNERTUBE_TIMEOUT_MS = '300';
  process.env.YOUTUBE_INNERTUBE_MIN_INTERVAL_MS = '0';
  resetInnertubeCooldownForTests();
  resetInnertubePacingForTests();
  setInnertubeEmitSinkForTests(async () => undefined);
  let continuationAttempted = false;
  setInnertubeSessionFactoryForTests(async () => ({
    search: async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return {
        channels: [],
        has_continuation: true,
        getContinuation: async () => {
          continuationAttempted = true;
          return new Promise(() => undefined) as never;
        },
      };
    },
  }));
  try {
    const started = Date.now();
    await assert.rejects(
      executeInnertubeRetrievalPage({
        provider: { ...YOUTUBE_INNERTUBE_PROVIDER },
        query: 'trading',
        country: 'US',
        lane: 'CHANNEL',
        cursor: '2',
        ordering: 'RELEVANCE',
      } as any),
      (error: any) => error?.code === INNERTUBE_TIMEOUT_CODE && error?.retryable === true,
    );
    const elapsed = Date.now() - started;
    assert.ok(continuationAttempted, 'the walk must reach the continuation for the bound to be meaningful');
    assert.ok(elapsed < 500, `page must respect the single 300ms budget, took ${elapsed}ms`);
  } finally {
    if (previousTimeout === undefined) delete process.env.YOUTUBE_INNERTUBE_TIMEOUT_MS;
    else process.env.YOUTUBE_INNERTUBE_TIMEOUT_MS = previousTimeout;
    if (previousInterval === undefined) delete process.env.YOUTUBE_INNERTUBE_MIN_INTERVAL_MS;
    else process.env.YOUTUBE_INNERTUBE_MIN_INTERVAL_MS = previousInterval;
    setInnertubeEmitSinkForTests(null);
    setInnertubeSessionFactoryForTests(null);
    resetInnertubeCooldownForTests();
    resetInnertubePacingForTests();
  }
});

test('a hung session attempt does not wedge later retrievals', async () => {
  // First factory call hangs forever; the first page must time out, drop the
  // stuck shared attempt, and let the second page create a fresh session and
  // succeed. Without invalidation the second page would reuse the permanently
  // pending promise and time out too (InnerTube disabled until restart).
  const previousTimeout = process.env.YOUTUBE_INNERTUBE_TIMEOUT_MS;
  const previousInterval = process.env.YOUTUBE_INNERTUBE_MIN_INTERVAL_MS;
  process.env.YOUTUBE_INNERTUBE_TIMEOUT_MS = '100';
  process.env.YOUTUBE_INNERTUBE_MIN_INTERVAL_MS = '0';
  resetInnertubeCooldownForTests();
  resetInnertubePacingForTests();
  setInnertubeEmitSinkForTests(async () => undefined);
  let factoryCalls = 0;
  setInnertubeSessionFactoryForTests(async () => {
    factoryCalls += 1;
    if (factoryCalls === 1) return new Promise(() => undefined) as never;
    return {
      search: async () => ({
        channels: [{ author: { id: UC, name: 'Desk' } }],
        has_continuation: false,
      }),
    };
  });
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
    assert.equal(factoryCalls, 1);
    const recovered = await executeInnertubeRetrievalPage({
      provider: { ...YOUTUBE_INNERTUBE_PROVIDER },
      query: 'trading',
      country: 'US',
      lane: 'CHANNEL',
      cursor: null,
      ordering: 'RELEVANCE',
    } as any);
    assert.equal(factoryCalls, 2);
    assert.equal(recovered.channels.length, 1);
    assert.equal(recovered.channels[0].channelId, UC);
  } finally {
    if (previousTimeout === undefined) delete process.env.YOUTUBE_INNERTUBE_TIMEOUT_MS;
    else process.env.YOUTUBE_INNERTUBE_TIMEOUT_MS = previousTimeout;
    if (previousInterval === undefined) delete process.env.YOUTUBE_INNERTUBE_MIN_INTERVAL_MS;
    else process.env.YOUTUBE_INNERTUBE_MIN_INTERVAL_MS = previousInterval;
    setInnertubeEmitSinkForTests(null);
    setInnertubeSessionFactoryForTests(null);
    resetInnertubeCooldownForTests();
    resetInnertubePacingForTests();
  }
});

test('an older timed-out page never clears a newer session attempt', async () => {
  // The older page awaits the stuck first attempt with a long deadline while
  // a newer page times out, drops it, and a replacement session is created.
  // When the older page finally times out it must leave the replacement
  // alone: a further page reuses it without invoking the factory again.
  const previousTimeout = process.env.YOUTUBE_INNERTUBE_TIMEOUT_MS;
  const previousInterval = process.env.YOUTUBE_INNERTUBE_MIN_INTERVAL_MS;
  process.env.YOUTUBE_INNERTUBE_MIN_INTERVAL_MS = '0';
  resetInnertubeCooldownForTests();
  resetInnertubePacingForTests();
  setInnertubeEmitSinkForTests(async () => undefined);
  let factoryCalls = 0;
  setInnertubeSessionFactoryForTests(async () => {
    factoryCalls += 1;
    if (factoryCalls === 1) return new Promise(() => undefined) as never;
    return {
      search: async () => ({
        channels: [{ author: { id: UC, name: 'Desk' } }],
        has_continuation: false,
      }),
    };
  });
  const page = () => executeInnertubeRetrievalPage({
    provider: { ...YOUTUBE_INNERTUBE_PROVIDER },
    query: 'trading',
    country: 'US',
    lane: 'CHANNEL',
    cursor: null,
    ordering: 'RELEVANCE',
  } as any);
  try {
    process.env.YOUTUBE_INNERTUBE_TIMEOUT_MS = '500';
    const older = page();
    process.env.YOUTUBE_INNERTUBE_TIMEOUT_MS = '100';
    await assert.rejects(
      page(),
      (error: any) => error?.code === INNERTUBE_TIMEOUT_CODE && error?.retryable === true,
    );
    assert.equal(factoryCalls, 1);
    const recovered = await page();
    assert.equal(factoryCalls, 2);
    assert.equal(recovered.channels.length, 1);
    await assert.rejects(
      older,
      (error: any) => error?.code === INNERTUBE_TIMEOUT_CODE && error?.retryable === true,
    );
    const reuse = await page();
    assert.equal(factoryCalls, 2);
    assert.equal(reuse.channels.length, 1);
  } finally {
    if (previousTimeout === undefined) delete process.env.YOUTUBE_INNERTUBE_TIMEOUT_MS;
    else process.env.YOUTUBE_INNERTUBE_TIMEOUT_MS = previousTimeout;
    if (previousInterval === undefined) delete process.env.YOUTUBE_INNERTUBE_MIN_INTERVAL_MS;
    else process.env.YOUTUBE_INNERTUBE_MIN_INTERVAL_MS = previousInterval;
    setInnertubeEmitSinkForTests(null);
    setInnertubeSessionFactoryForTests(null);
    resetInnertubeCooldownForTests();
    resetInnertubePacingForTests();
  }
});

test('a search that succeeds after the deadline is discarded, never emitted', async () => {
  // youtubei.js exposes no cancellation, so the slow search still completes
  // in the background. The page must already have rejected with TIMEOUT, the
  // late result must never surface, and exactly one non-SUCCESS telemetry
  // event must exist even after the late success lands.
  const previousTimeout = process.env.YOUTUBE_INNERTUBE_TIMEOUT_MS;
  const previousInterval = process.env.YOUTUBE_INNERTUBE_MIN_INTERVAL_MS;
  process.env.YOUTUBE_INNERTUBE_TIMEOUT_MS = '100';
  process.env.YOUTUBE_INNERTUBE_MIN_INTERVAL_MS = '0';
  resetInnertubeCooldownForTests();
  resetInnertubePacingForTests();
  const events: Array<Record<string, unknown>> = [];
  setInnertubeEmitSinkForTests(async (event) => { events.push(event as unknown as Record<string, unknown>); });
  setInnertubeSessionFactoryForTests(async () => ({
    search: async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return {
        channels: [{ author: { id: UC, name: 'Desk' } }],
        has_continuation: false,
      };
    },
  }));
  try {
    const started = Date.now();
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
    assert.ok(Date.now() - started < 200, 'page must reject on its deadline, not wait out the late success');
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'TRANSIENT_ERROR');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(events.length, 1, 'late background success must never emit');
    assert.ok(events.every((event) => event.status !== 'SUCCESS'));
  } finally {
    if (previousTimeout === undefined) delete process.env.YOUTUBE_INNERTUBE_TIMEOUT_MS;
    else process.env.YOUTUBE_INNERTUBE_TIMEOUT_MS = previousTimeout;
    if (previousInterval === undefined) delete process.env.YOUTUBE_INNERTUBE_MIN_INTERVAL_MS;
    else process.env.YOUTUBE_INNERTUBE_MIN_INTERVAL_MS = previousInterval;
    setInnertubeEmitSinkForTests(null);
    setInnertubeSessionFactoryForTests(null);
    resetInnertubeCooldownForTests();
    resetInnertubePacingForTests();
  }
});

test('slow session creation consumes the same page budget as the search', async () => {
  // Budget 300ms. Session creation consumes ~250ms, then the search stalls.
  // Per-operation timeouts would allow 250 + 300 = ~550ms; the page deadline
  // must fire at ~300ms from page start instead.
  const previousTimeout = process.env.YOUTUBE_INNERTUBE_TIMEOUT_MS;
  const previousInterval = process.env.YOUTUBE_INNERTUBE_MIN_INTERVAL_MS;
  process.env.YOUTUBE_INNERTUBE_TIMEOUT_MS = '300';
  process.env.YOUTUBE_INNERTUBE_MIN_INTERVAL_MS = '0';
  resetInnertubeCooldownForTests();
  resetInnertubePacingForTests();
  setInnertubeEmitSinkForTests(async () => undefined);
  setInnertubeSessionFactoryForTests(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    return { search: async () => new Promise(() => undefined) as never };
  });
  try {
    const started = Date.now();
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
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 500, `page must respect the single 300ms budget, took ${elapsed}ms`);
  } finally {
    if (previousTimeout === undefined) delete process.env.YOUTUBE_INNERTUBE_TIMEOUT_MS;
    else process.env.YOUTUBE_INNERTUBE_TIMEOUT_MS = previousTimeout;
    if (previousInterval === undefined) delete process.env.YOUTUBE_INNERTUBE_MIN_INTERVAL_MS;
    else process.env.YOUTUBE_INNERTUBE_MIN_INTERVAL_MS = previousInterval;
    setInnertubeEmitSinkForTests(null);
    setInnertubeSessionFactoryForTests(null);
    resetInnertubeCooldownForTests();
    resetInnertubePacingForTests();
  }
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

test('innertube channel descriptions recover per-video metadata with bounded calls', async () => {
  resetInnertubeCooldownForTests();
  resetInnertubePacingForTests();
  const events: Array<{ status: string; operation: string }> = [];
  setInnertubeEmitSinkForTests(async event => { events.push({ status: event.status, operation: event.operation }); });
  setInnertubeSessionFactoryForTests(async () => ({
    search: async () => { throw new Error('unused'); },
    getChannel: async () => ({
      getVideos: async () => ({ videos: [{ content_id: 'vid1' }, { content_id: 'vid2' }, { content_id: 'vid3' }] }),
    }),
    getBasicInfo: async (videoId: string) => {
      if (videoId === 'vid2') return { basic_info: { short_description: '  ' } };
      if (videoId === 'vid3') throw Object.assign(new Error('Video unavailable'), { status: 404 });
      return { basic_info: { short_description: `Description for ${videoId}` } };
    },
  }));
  try {
    const { fetchChannelVideoDescriptionsViaInnertube } = await import('./youtubeInnertubeProvider');
    const result = await fetchChannelVideoDescriptionsViaInnertube('UCtestchannel', { maxVideos: 10 });
    assert.equal(result.videosListed, 3);
    assert.equal(result.videosAttempted, 3);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].description, 'Description for vid1');
    assert.ok(events.some(event => event.status === 'SUCCESS' && event.operation === 'channel-video-descriptions'));
    assert.equal(innertubeCooldownRemainingMs(), 0);
  } finally {
    setInnertubeSessionFactoryForTests(null);
    setInnertubeEmitSinkForTests(null);
    resetInnertubeCooldownForTests();
    resetInnertubePacingForTests();
  }
});

test('innertube 429 aborts the fetch and arms the provider cooldown', async () => {
  resetInnertubeCooldownForTests();
  resetInnertubePacingForTests();
  const events: Array<{ status: string }> = [];
  setInnertubeEmitSinkForTests(async event => { events.push({ status: event.status }); });
  setInnertubeSessionFactoryForTests(async () => ({
    search: async () => { throw new Error('unused'); },
    getChannel: async () => ({
      getVideos: async () => ({ videos: [{ content_id: 'vid1' }] }),
    }),
    getBasicInfo: async () => { throw Object.assign(new Error('Too Many Requests'), { status: 429 }); },
  }));
  try {
    const { fetchChannelVideoDescriptionsViaInnertube } = await import('./youtubeInnertubeProvider');
    await assert.rejects(
      fetchChannelVideoDescriptionsViaInnertube('UCtestchannel'),
      (error: any) => error?.code === INNERTUBE_RATE_LIMITED_CODE && error?.retryable === true,
    );
    assert.ok(innertubeCooldownRemainingMs() > 0, '429 must arm backpressure');
    assert.ok(events.some(event => event.status === 'RATE_LIMITED'));
  } finally {
    setInnertubeSessionFactoryForTests(null);
    setInnertubeEmitSinkForTests(null);
    resetInnertubeCooldownForTests();
    resetInnertubePacingForTests();
  }
});

test('missing videos tab yields empty items without failing', async () => {
  resetInnertubeCooldownForTests();
  resetInnertubePacingForTests();
  setInnertubeEmitSinkForTests(async () => undefined);
  setInnertubeSessionFactoryForTests(async () => ({
    search: async () => { throw new Error('unused'); },
    getChannel: async () => ({
      getVideos: async () => { throw new Error('Tab "videos" not found'); },
    }),
    getBasicInfo: async () => ({ basic_info: { short_description: 'x' } }),
  }));
  try {
    const { fetchChannelVideoDescriptionsViaInnertube } = await import('./youtubeInnertubeProvider');
    const result = await fetchChannelVideoDescriptionsViaInnertube('UCnotab');
    assert.deepEqual(result.items, []);
    assert.equal(result.videosListed, 0);
  } finally {
    setInnertubeSessionFactoryForTests(null);
    setInnertubeEmitSinkForTests(null);
    resetInnertubeCooldownForTests();
    resetInnertubePacingForTests();
  }
});

test('session without channel methods fails non-retryable', async () => {
  resetInnertubeCooldownForTests();
  resetInnertubePacingForTests();
  setInnertubeSessionFactoryForTests(async () => ({ search: async () => ({}) }));
  try {
    const { fetchChannelVideoDescriptionsViaInnertube } = await import('./youtubeInnertubeProvider');
    await assert.rejects(
      fetchChannelVideoDescriptionsViaInnertube('UCtestchannel'),
      (error: any) => error?.retryable === false,
    );
  } finally {
    setInnertubeSessionFactoryForTests(null);
    resetInnertubeCooldownForTests();
    resetInnertubePacingForTests();
  }
});

test('expired deadline never starts provider work', async () => {
  resetInnertubeCooldownForTests();
  resetInnertubePacingForTests();
  const savedTimeout = process.env.YOUTUBE_INNERTUBE_TIMEOUT_MS;
  const savedInterval = process.env.YOUTUBE_INNERTUBE_MIN_INTERVAL_MS;
  // Pacing (2s) dwarfs the total budget (200ms): the channel call fits, but
  // the videos call must never start once the deadline expired in the wait.
  // The settling wait afterwards proves no detached background work fires
  // late (the old chain-then-race shape would start it here).
  process.env.YOUTUBE_INNERTUBE_TIMEOUT_MS = '200';
  process.env.YOUTUBE_INNERTUBE_MIN_INTERVAL_MS = '2000';
  let videosStarted = false;
  setInnertubeEmitSinkForTests(async () => undefined);
  setInnertubeSessionFactoryForTests(async () => ({
    search: async () => { throw new Error('unused'); },
    getChannel: async () => ({ getVideos: async () => { videosStarted = true; return { videos: [] }; } }),
    getBasicInfo: async () => ({ basic_info: { short_description: 'x' } }),
  }));
  try {
    const { fetchChannelVideoDescriptionsViaInnertube } = await import('./youtubeInnertubeProvider');
    await assert.rejects(
      fetchChannelVideoDescriptionsViaInnertube('UCtestchannel'),
      (error: any) => error?.code === INNERTUBE_TIMEOUT_CODE,
    );
    assert.equal(videosStarted, false, 'no outbound work may start after the deadline expired in pacing');
    await new Promise(resolve => setTimeout(resolve, 2500));
    assert.equal(videosStarted, false, 'no detached background work may fire late');
  } finally {
    if (savedTimeout === undefined) delete process.env.YOUTUBE_INNERTUBE_TIMEOUT_MS;
    else process.env.YOUTUBE_INNERTUBE_TIMEOUT_MS = savedTimeout;
    if (savedInterval === undefined) delete process.env.YOUTUBE_INNERTUBE_MIN_INTERVAL_MS;
    else process.env.YOUTUBE_INNERTUBE_MIN_INTERVAL_MS = savedInterval;
    setInnertubeSessionFactoryForTests(null);
    setInnertubeEmitSinkForTests(null);
    resetInnertubeCooldownForTests();
    resetInnertubePacingForTests();
  }
});

test('non-tab errors mentioning videos still propagate', async () => {
  resetInnertubeCooldownForTests();
  resetInnertubePacingForTests();
  setInnertubeEmitSinkForTests(async () => undefined);
  setInnertubeSessionFactoryForTests(async () => ({
    search: async () => { throw new Error('unused'); },
    getChannel: async () => ({
      getVideos: async () => { throw new Error('No videos found for this channel'); },
    }),
    getBasicInfo: async () => ({ basic_info: { short_description: 'x' } }),
  }));
  try {
    const { fetchChannelVideoDescriptionsViaInnertube } = await import('./youtubeInnertubeProvider');
    await assert.rejects(
      fetchChannelVideoDescriptionsViaInnertube('UCtestchannel'),
      (error: any) => String(error?.message || '').includes('No videos found'),
    );
  } finally {
    setInnertubeSessionFactoryForTests(null);
    setInnertubeEmitSinkForTests(null);
    resetInnertubeCooldownForTests();
    resetInnertubePacingForTests();
  }
});

test('service-level outage is never mistaken for unavailable videos', async () => {
  resetInnertubeCooldownForTests();
  resetInnertubePacingForTests();
  setInnertubeEmitSinkForTests(async () => undefined);
  setInnertubeSessionFactoryForTests(async () => ({
    search: async () => { throw new Error('unused'); },
    getChannel: async () => ({
      getVideos: async () => ({ videos: [{ content_id: 'vid1' }, { content_id: 'vid2' }] }),
    }),
    getBasicInfo: async () => { throw Object.assign(new Error('Service Unavailable'), { status: 503 }); },
  }));
  try {
    const { fetchChannelVideoDescriptionsViaInnertube } = await import('./youtubeInnertubeProvider');
    await assert.rejects(
      fetchChannelVideoDescriptionsViaInnertube('UCtestchannel'),
      (error: any) => error?.retryable === true && String(error?.message || '').includes('Service Unavailable'),
    );
  } finally {
    setInnertubeSessionFactoryForTests(null);
    setInnertubeEmitSinkForTests(null);
    resetInnertubeCooldownForTests();
    resetInnertubePacingForTests();
  }
});

test('unstatused service outage message still aborts instead of skipping', async () => {
  resetInnertubeCooldownForTests();
  resetInnertubePacingForTests();
  setInnertubeEmitSinkForTests(async () => undefined);
  setInnertubeSessionFactoryForTests(async () => ({
    search: async () => { throw new Error('unused'); },
    getChannel: async () => ({
      getVideos: async () => ({ videos: [{ content_id: 'vid1' }] }),
    }),
    getBasicInfo: async () => { throw new Error('Service Unavailable'); },
  }));
  try {
    const { fetchChannelVideoDescriptionsViaInnertube } = await import('./youtubeInnertubeProvider');
    await assert.rejects(fetchChannelVideoDescriptionsViaInnertube('UCtestchannel'));
  } finally {
    setInnertubeSessionFactoryForTests(null);
    setInnertubeEmitSinkForTests(null);
    resetInnertubeCooldownForTests();
    resetInnertubePacingForTests();
  }
});

test('genuinely unavailable videos still skip quietly', async () => {
  resetInnertubeCooldownForTests();
  resetInnertubePacingForTests();
  setInnertubeEmitSinkForTests(async () => undefined);
  setInnertubeSessionFactoryForTests(async () => ({
    search: async () => { throw new Error('unused'); },
    getChannel: async () => ({
      getVideos: async () => ({ videos: [{ content_id: 'vid1' }, { content_id: 'vid2' }] }),
    }),
    getBasicInfo: async (videoId: string) => {
      if (videoId === 'vid1') throw new Error('This video is unavailable');
      return { basic_info: { short_description: 'Kept description' } };
    },
  }));
  try {
    const { fetchChannelVideoDescriptionsViaInnertube } = await import('./youtubeInnertubeProvider');
    const result = await fetchChannelVideoDescriptionsViaInnertube('UCtestchannel');
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].description, 'Kept description');
  } finally {
    setInnertubeSessionFactoryForTests(null);
    setInnertubeEmitSinkForTests(null);
    resetInnertubeCooldownForTests();
    resetInnertubePacingForTests();
  }
});
