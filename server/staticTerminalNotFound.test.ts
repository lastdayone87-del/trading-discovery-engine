import assert from 'node:assert/strict';
import test from 'node:test';
import { assessStaticNotFoundBody, isConfirmedStaticTerminalNotFound } from './staticTerminalNotFound';
import { fetchProfilerUrl } from './siteProfiler';
import { runChannelInspectionForTest as runChannelInspection } from './testCrawlHelpers';
import type { BrowserFallbackResult } from './browserCommunityFallback';

const EMPTY_RENDERED = async (seedUrl: string): Promise<BrowserFallbackResult> => ({
  foundInvite: null,
  foundLocation: seedUrl,
  inspectedPages: 1,
  scrolls: 0,
  clicks: 0,
  complete: true,
  retryable: false,
  detail: 'test rendered surface inspected without invite',
});

const makeIsolatedStore = () => ({
  read: async () => [],
  write: async () => {},
  recordLinks: async () => {},
});

const fillers = ['one', 'two', 'three', 'four', 'five'];

function observation(overrides: Record<string, unknown> = {}) {
  return {
    requestedUrl: 'https://creator.example.com/guide',
    outcome: 'ACQUISITION_FAILED',
    failureClass: 'HTTP_ERROR',
    httpStatus: 404,
    retryable: false,
    staticNotFoundBodyConfirmed: true,
    staticNotFoundBodyReason: 'NO_LINKS_SMALL_BODY',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Body assessment: only a readable, complete, link-free/no-community page can
// be terminal. Every uncertain or recoverable body keeps rendered escalation.
// ---------------------------------------------------------------------------

test('static 404 body: empty body is confirmed terminal', () => {
  assert.deepEqual(assessStaticNotFoundBody({ text: '', truncated: false }), {
    confirmed: true,
    reason: 'EMPTY_BODY',
  });
  assert.deepEqual(assessStaticNotFoundBody({ text: '   \n\t ', truncated: false }), {
    confirmed: true,
    reason: 'EMPTY_BODY',
  });
});

test('static 404 body: small plain no-link error page is confirmed terminal', () => {
  assert.deepEqual(
    assessStaticNotFoundBody({
      text: '<html><head><title>Page not found</title></head><body>This page does not exist.</body></html>',
      truncated: false,
    }),
    { confirmed: true, reason: 'NO_LINKS_EXPLICIT_NOT_FOUND' },
  );
  assert.deepEqual(
    assessStaticNotFoundBody({ text: '<html><body>Nothing here.</body></html>', truncated: false }),
    { confirmed: true, reason: 'NO_LINKS_SMALL_BODY' },
  );
});

test('static 410 body: explicit gone page is confirmed terminal', () => {
  assert.deepEqual(
    assessStaticNotFoundBody({
      text: '<html><head><title>410 Gone</title></head><body>This page is gone.</body></html>',
      truncated: false,
    }),
    { confirmed: true, reason: 'NO_LINKS_EXPLICIT_NOT_FOUND' },
  );
});

test('static 404 body: any link keeps rendered escalation', () => {
  for (const body of [
    '<html><body><h1>Page not found</h1><a href="/">Back home</a></body></html>',
    '<html><body><map><area href="/community" alt="community"></map></body></html>',
  ]) {
    assert.deepEqual(
      assessStaticNotFoundBody({ text: body, truncated: false }),
      { confirmed: false, reason: 'HAS_LINKS' },
      body,
    );
  }
});

test('static 404 body: quoted angle brackets never hide a real link', () => {
  for (const body of [
    '<html><body><a title="1 < 2" href="/join">Join</a></body></html>',
    "<html><body><a title='1 > 2' href='/join'>Join</a></body></html>",
    '<html><body><a data-label="a < b" href="/join">Join</a></body></html>',
    '<html><body><area title="1 < 2" href="/community"></body></html>',
  ]) {
    assert.deepEqual(
      assessStaticNotFoundBody({ text: body, truncated: false }),
      { confirmed: false, reason: 'HAS_LINKS' },
      body,
    );
  }
});

test('static 404 body: tags that cannot be fully checked are never terminal', () => {
  const oversized = 'x'.repeat(2_500);
  for (const body of [
    `<html><body><a ${oversized} href="/join">Join</a></body></html>`,
    `<html><body><button ${oversized} onclick="location='/community'">Continue</button></body></html>`,
    `<html><head><meta ${oversized} http-equiv="refresh" content="0;url=/"></head><body>404</body></html>`,
    `<html><body><h1 ${oversized} title="404">Welcome</h1></body></html>`,
  ]) {
    assert.deepEqual(
      assessStaticNotFoundBody({ text: body, truncated: false }),
      { confirmed: false, reason: 'UNSAFE_MARKUP' },
      body.slice(0, 80),
    );
  }
});

test('static 404 body: attribute text is not treated as visible heading', () => {
  const body = `<html><body><h1 data-label="> 404">Welcome</h1>${'x'.repeat(3_000)}</body></html>`;
  assert.deepEqual(
    assessStaticNotFoundBody({ text: body, truncated: false }),
    { confirmed: false, reason: 'LARGE_BODY' },
  );
});

test('static 404 body: community content keeps rendered escalation', () => {
  for (const marker of [
    'https://discord.gg/creator',
    'https://discord.com/invite/creator',
    'https://discordapp.com/invite/creator',
    'https://discord.app/invite/creator',
    'https://discord.io/creator',
    'https://dsc.gg/creator',
    'https://discord.me/creator',
    'https://discord&#46;gg/creator',
    'https://discord[.]gg/creator',
    'https://discord[dot]gg/creator',
    'discord.gg/creator',
    'https://t.me/creator',
    'https://telegram.me/creator',
    'https://whop.com/creator',
    'https://skool.com/creator',
    'https://circle.so/creator',
    'https://patreon.com/creator',
  ]) {
    assert.deepEqual(
      assessStaticNotFoundBody({
        text: `<html><body>Join us: ${marker}</body></html>`,
        truncated: false,
      }),
      { confirmed: false, reason: 'HAS_COMMUNITY_CONTENT' },
      marker,
    );
  }
});

test('static 404 body: client-rendered shells keep rendered escalation', () => {
  for (const body of [
    '<html><body><div id="root"></div><script src="/app.js"></script></body></html>',
    '<html><head><meta http-equiv="refresh" content="0;url=/"></head><body>Not found</body></html>',
    '<html><body><iframe src="/community"></iframe></body></html>',
    '<html><body><form action="/search"><input name="q"></form></body></html>',
    '<html><body><button onclick="location=\'/community\'">Continue</button></body></html>',
  ]) {
    assert.deepEqual(
      assessStaticNotFoundBody({ text: body, truncated: false }),
      { confirmed: false, reason: 'CLIENT_RENDER_SHELL' },
      body,
    );
  }
});

test('static 404 body: bot/block markers keep rendered escalation', () => {
  assert.deepEqual(
    assessStaticNotFoundBody({
      text: '<html><body>Attention required. Verify you are human.</body></html>',
      truncated: false,
    }),
    { confirmed: false, reason: 'BLOCK_MARKERS' },
  );
});

test('static 404 body: pathological unclosed markup stays bounded', () => {
  for (const body of [
    '<'.repeat(64_000),
    '<title>'.repeat(8_000),
    '<a '.repeat(20_000),
    '<meta '.repeat(20_000),
  ]) {
    const started = Date.now();
    const assessment = assessStaticNotFoundBody({ text: body, truncated: false });
    const elapsed = Date.now() - started;
    assert.equal(assessment.confirmed, false, body.slice(0, 12));
    assert.ok(elapsed < 1_000, `bounded scan, took ${elapsed}ms`);
  }
});

test('static 404 body: NUL-containing text is unreadable, never terminal', () => {
  assert.deepEqual(
    assessStaticNotFoundBody({ text: '<html><body>\u0000J\u0000o\u0000i\u0000n\u0000</body></html>', truncated: false }),
    { confirmed: false, reason: 'UNREADABLE' },
  );
});

test('static 404 body: unread, truncated, and large bodies are never terminal', () => {
  assert.deepEqual(assessStaticNotFoundBody({ text: '', truncated: false, bodySuppressed: true }), {
    confirmed: false,
    reason: 'BODY_NOT_READ',
  });
  assert.deepEqual(assessStaticNotFoundBody({ text: '', truncated: false, bodyProbeFailed: true }), {
    confirmed: false,
    reason: 'UNREADABLE',
  });
  assert.deepEqual(assessStaticNotFoundBody({ text: '<html>404</html>', truncated: true }), {
    confirmed: false,
    reason: 'TRUNCATED',
  });
  assert.deepEqual(
    assessStaticNotFoundBody({ text: `<html><body>${'x'.repeat(3_000)}</body></html>`, truncated: false }),
    { confirmed: false, reason: 'LARGE_BODY' },
  );
  assert.deepEqual(
    assessStaticNotFoundBody({
      text: `<html><head><title>404 Not Found</title></head><body>${'x'.repeat(3_000)}</body></html>`,
      truncated: false,
    }),
    { confirmed: true, reason: 'NO_LINKS_EXPLICIT_NOT_FOUND' },
  );
});

// ---------------------------------------------------------------------------
// Seed predicate: optional surfaces only, clean terminal evidence only.
// ---------------------------------------------------------------------------

test('seed predicate: confirmed website 404 and social 410 are terminal', () => {
  assert.equal(
    isConfirmedStaticTerminalNotFound({
      surface: 'CREATOR_WEBSITES',
      seedUrl: 'https://creator.example.com/guide',
      crawlOutcome: 'ACQUISITION_FAILED',
      observations: [observation()],
      candidateCount: 0,
    }),
    true,
  );
  assert.equal(
    isConfirmedStaticTerminalNotFound({
      surface: 'SOCIAL_PROFILES',
      seedUrl: 'https://x.com/creator',
      crawlOutcome: 'ACQUISITION_FAILED',
      observations: [observation({ requestedUrl: 'https://x.com/creator', httpStatus: 410 })],
      candidateCount: 0,
    }),
    true,
  );
});

test('seed predicate: required YouTube and OTHER surfaces are never eligible', () => {
  for (const surface of ['YOUTUBE_ABOUT', 'RECENT_VIDEO_DESCRIPTIONS', 'OTHER', 'CHANNEL_EXTERNAL_LINKS']) {
    assert.equal(
      isConfirmedStaticTerminalNotFound({
        surface,
        seedUrl: 'https://creator.example.com/guide',
        crawlOutcome: 'ACQUISITION_FAILED',
        observations: [observation()],
        candidateCount: 0,
      }),
      false,
      surface,
    );
  }
});

test('seed predicate: transient, retryable, blocked, and soft/partial evidence keep render', () => {
  const base = {
    surface: 'CREATOR_WEBSITES',
    seedUrl: 'https://creator.example.com/guide',
    crawlOutcome: 'ACQUISITION_FAILED',
    candidateCount: 0,
  };
  assert.equal(
    isConfirmedStaticTerminalNotFound({
      ...base,
      observations: [observation({ httpStatus: 503, failureClass: 'TRANSIENT_HTTP', retryable: true })],
    }),
    false,
    '5xx',
  );
  assert.equal(
    isConfirmedStaticTerminalNotFound({
      ...base,
      observations: [observation({ retryable: true })],
    }),
    false,
    'retryable 404',
  );
  assert.equal(
    isConfirmedStaticTerminalNotFound({
      ...base,
      observations: [observation({ blockMarkers: true })],
    }),
    false,
    'block markers',
  );
  assert.equal(
    isConfirmedStaticTerminalNotFound({
      ...base,
      observations: [observation({ staticNotFoundBodyConfirmed: false })],
    }),
    false,
    'body not confirmed',
  );
  assert.equal(
    isConfirmedStaticTerminalNotFound({
      ...base,
      crawlOutcome: 'PARTIALLY_INSPECTED',
      observations: [observation()],
    }),
    false,
    'partial crawl',
  );
  assert.equal(
    isConfirmedStaticTerminalNotFound({
      ...base,
      observations: [observation(), observation({ requestedUrl: 'https://creator.example.com/other', outcome: 'FOUND' })],
    }),
    false,
    'successful evidence present',
  );
});

test('seed predicate: candidates, community intent, and mismatched seeds keep render', () => {
  const base = {
    surface: 'CREATOR_WEBSITES',
    seedUrl: 'https://creator.example.com/guide',
    crawlOutcome: 'ACQUISITION_FAILED',
    observations: [observation()],
  };
  assert.equal(isConfirmedStaticTerminalNotFound({ ...base, candidateCount: 1 }), false);
  assert.equal(isConfirmedStaticTerminalNotFound({ ...base, candidateCount: 0, communityIntentCount: 1 }), false);
  assert.equal(
    isConfirmedStaticTerminalNotFound({
      ...base,
      seedUrl: 'https://creator.example.com/other',
      candidateCount: 0,
    }),
    false,
  );
});

// ---------------------------------------------------------------------------
// End-to-end inspection contracts.
// ---------------------------------------------------------------------------

async function inspect(input: {
  channelLinks?: string[];
  socialLinks?: string[];
  fetchImpl: typeof fetch;
  renderedFallback: (seedUrl: string) => Promise<BrowserFallbackResult>;
  creatorLikelyTrading?: boolean;
  youtubeUrl?: string;
  liveChannelDataLoader?: () => Promise<null>;
  videoDescriptionsAuthoritative?: boolean;
  recentVideoDescriptions?: Array<{ videoId: string; description: string }>;
}) {
  return runChannelInspection({
    channelId: `terminal-${Math.random().toString(36).slice(2)}`,
    channelName: 'Terminal Contract Channel',
    channelBio: 'Trading notes',
    channelLinks: input.channelLinks || [],
    socialLinks: input.socialLinks || [],
    videoDescriptions: fillers,
    videoDescriptionsAuthoritative: input.videoDescriptionsAuthoritative,
    recentVideoDescriptions: input.recentVideoDescriptions,
    creatorLikelyTrading: input.creatorLikelyTrading ?? true,
    youtubeUrl: input.youtubeUrl,
    liveChannelDataLoader: input.liveChannelDataLoader,
    recentVideoDescriptionsLoader: (async () => []) as never,
    externalFetchImpl: input.fetchImpl,
    renderedFallback: input.renderedFallback as never,
    urlFailureHistoryLoader: (async () => []) as never,
    siteInspectionStore: makeIsolatedStore(),
  } as never);
}

function countRenderCalls() {
  let calls = 0;
  const fallback = async (seedUrl: string) => {
    calls += 1;
    return EMPTY_RENDERED(seedUrl);
  };
  return { fallback, calls: () => calls };
}

const response = (body: string, status = 200, contentType = 'text/html') =>
  new Response(body, { status, headers: { 'content-type': contentType } });

test('website 404 with an empty body skips rendered fallback and stays visible', async () => {
  const renders = countRenderCalls();
  const url = 'https://creator.example.com/gone';
  const result = await inspect({
    channelLinks: [url],
    fetchImpl: (async () => response('', 404)) as unknown as typeof fetch,
    renderedFallback: renders.fallback,
  });
  const seed = (result.acquisitionOutcomes || []).find(item => item.requestedUrl === url);
  assert.ok(seed, 'seed observation exists');
  assert.equal(seed.outcome, 'ACQUISITION_FAILED');
  assert.equal(seed.httpStatus, 404);
  assert.equal(seed.retryable, false);
  assert.equal(seed.staticTerminalNotFound, true);
  assert.equal(renders.calls(), 0);
  assert.ok(JSON.stringify(result.steps || []).includes('confirmed static HTTP 404'));
});

test('social 410 with an empty body skips rendered fallback', async () => {
  const renders = countRenderCalls();
  const url = 'https://x.com/gone';
  const result = await inspect({
    socialLinks: [url],
    fetchImpl: (async () => response('', 410)) as unknown as typeof fetch,
    renderedFallback: renders.fallback,
  });
  const seed = (result.acquisitionOutcomes || []).find(item => item.requestedUrl === url);
  assert.ok(seed, 'social seed observation exists');
  assert.equal(seed.httpStatus, 410);
  assert.equal(seed.staticTerminalNotFound, true);
  assert.equal(renders.calls(), 0);
});

test('404 with a link or community marker still renders', async () => {
  for (const body of [
    '<html><body><a href="/">home</a></body></html>',
    '<html><body>Join https://discord.gg/creator</body></html>',
    '<html><body>Verify you are human</body></html>',
  ]) {
    const renders = countRenderCalls();
    await inspect({
      channelLinks: ['https://creator.example.com/gone'],
      fetchImpl: (async () => response(body, 404)) as unknown as typeof fetch,
      renderedFallback: renders.fallback,
    });
    assert.equal(renders.calls(), 1, body);
  }
});

test('body confirmation without an actual skip is not persisted as a terminal render avoidance', async () => {
  const renders = countRenderCalls();
  const url = 'https://patreon.com/gone';
  const result = await inspect({
    channelLinks: [url],
    fetchImpl: (async () => response('', 404)) as unknown as typeof fetch,
    renderedFallback: renders.fallback,
  });
  const seed = (result.acquisitionOutcomes || []).find(item => item.requestedUrl === url);
  assert.ok(seed, 'seed observation exists');
  assert.equal(seed.staticNotFoundBodyConfirmed, true, 'body probe confirmed the plain 404');
  assert.notEqual(seed.staticTerminalNotFound, true, 'community intent kept rendering, so no skip is recorded');
  assert.equal(renders.calls(), 1);
});

test('untyped 404 bodies are not read as terminal evidence', async () => {
  const renders = countRenderCalls();
  const url = 'https://creator.example.com/untyped';
  const result = await inspect({
    channelLinks: [url],
    fetchImpl: (async () => new Response(new Uint8Array([0x00, 0x01, 0x02]), { status: 404 })) as unknown as typeof fetch,
    renderedFallback: renders.fallback,
  });
  const seed = (result.acquisitionOutcomes || []).find(item => item.requestedUrl === url);
  assert.ok(seed, 'seed observation exists');
  assert.notEqual(seed.staticNotFoundBodyConfirmed, true);
  assert.notEqual(seed.staticTerminalNotFound, true);
  assert.equal(renders.calls(), 1);
});

test('UTF-16 XHTML 404 bodies keep rendered fallback', async () => {
  const body = Buffer.from('<html><body>Join https://discord.gg/creator</body></html>', 'utf16le');
  for (const contentType of ['application/xhtml+xml; charset=utf-16le', 'application/xhtml+xml']) {
    const renders = countRenderCalls();
    const url = 'https://creator.example.com/utf16';
    const result = await inspect({
      channelLinks: [url],
      fetchImpl: (async () => new Response(body, { status: 404, headers: { 'content-type': contentType } })) as unknown as typeof fetch,
      renderedFallback: renders.fallback,
    });
    const seed = (result.acquisitionOutcomes || []).find(item => item.requestedUrl === url);
    assert.ok(seed, `seed observation exists (${contentType})`);
    assert.notEqual(seed.staticNotFoundBodyConfirmed, true, contentType);
    assert.notEqual(seed.staticTerminalNotFound, true, contentType);
    assert.equal(renders.calls(), 1, contentType);
  }
});

test('transient 5xx keeps rendered fallback', async () => {
  const renders = countRenderCalls();
  await inspect({
    channelLinks: ['https://creator.example.com/transient'],
    fetchImpl: (async () => response('server error', 503)) as unknown as typeof fetch,
    renderedFallback: renders.fallback,
  });
  assert.equal(renders.calls(), 1);
});

test('soft 404 served as HTTP 200 keeps rendered fallback', async () => {
  const renders = countRenderCalls();
  await inspect({
    channelLinks: ['https://creator.example.com/soft'],
    fetchImpl: (async () =>
      response('<html><head><title>Page not found</title></head><body>Nothing here.</body></html>', 200)) as unknown as typeof fetch,
    renderedFallback: renders.fallback,
  });
  assert.equal(renders.calls(), 1);
});

test('valid static community link is retained and never treated as terminal', async () => {
  const renders = countRenderCalls();
  const url = 'https://creator.example.com/community';
  const result = await inspect({
    channelLinks: [url],
    fetchImpl: (async () =>
      response('<html><body><a href="https://discord.gg/valid-room">Join</a></body></html>', 200)) as unknown as typeof fetch,
    renderedFallback: renders.fallback,
  });
  const codes = (result.discordCandidates || []).map(candidate => candidate.nativeInviteCode);
  assert.ok(codes.includes('valid-room'));
  const seed = (result.acquisitionOutcomes || []).find(item => item.requestedUrl === url);
  assert.notEqual(seed?.staticTerminalNotFound, true);
});

// ---------------------------------------------------------------------------
// Probe transport: the bounded 404/410 reader must stay bounded even when the
// response stream stalls, fails, or exceeds the probe cap.
// ---------------------------------------------------------------------------

const publicResolver = async () => ['93.184.216.1'];

test('terminal body probe returns within budget when the stream stalls and cancel never settles', async () => {
  let cancelRequested = false;
  const stream = new ReadableStream<Uint8Array>({
    pull: () => new Promise<void>(() => {}),
    cancel: () => {
      cancelRequested = true;
      return new Promise<void>(() => {});
    },
  });
  const fetchImpl = (async () =>
    new Response(stream, { status: 404, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
  const started = Date.now();
  const fetched = await fetchProfilerUrl(
    'https://public.example/gone',
    fetchImpl,
    1_000,
    5_000,
    publicResolver,
    undefined,
    {
      shouldReadFinalBody: () => true,
      terminalNotFoundBodyMaxChars: 1_000,
      terminalNotFoundBodyTimeoutMs: 50,
    },
  );
  const elapsed = Date.now() - started;
  assert.equal(fetched!.status, 404);
  assert.equal(fetched!.bodyProbeFailed, true);
  assert.equal(fetched!.text, '');
  assert.equal(cancelRequested, true, 'cancellation requested without awaiting it');
  assert.ok(elapsed < 1_000, `probe stayed bounded, took ${elapsed}ms`);
});

test('terminal body probe reports a failing stream as unreadable, never empty evidence', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start: controller => controller.error(new Error('stream failed')),
  });
  const fetchImpl = (async () =>
    new Response(stream, { status: 410, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
  const fetched = await fetchProfilerUrl(
    'https://public.example/gone',
    fetchImpl,
    1_000,
    5_000,
    publicResolver,
    undefined,
    {
      shouldReadFinalBody: () => true,
      terminalNotFoundBodyMaxChars: 1_000,
      terminalNotFoundBodyTimeoutMs: 100,
    },
  );
  assert.equal(fetched!.status, 410);
  assert.equal(fetched!.bodyProbeFailed, true);
  assert.equal(fetched!.text, '');
});

test('terminal body probe truncates oversized bodies and keeps them non-terminal', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start: controller => {
      controller.enqueue(new TextEncoder().encode(`<html><body>${'x'.repeat(2_000)}</body></html>`));
      controller.close();
    },
  });
  const fetchImpl = (async () =>
    new Response(stream, { status: 404, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
  const fetched = await fetchProfilerUrl(
    'https://public.example/gone',
    fetchImpl,
    10_000,
    5_000,
    publicResolver,
    undefined,
    {
      shouldReadFinalBody: () => true,
      terminalNotFoundBodyMaxChars: 100,
      terminalNotFoundBodyTimeoutMs: 1_000,
    },
  );
  assert.equal(fetched!.status, 404);
  assert.equal(fetched!.truncated, true);
  assert.equal(fetched!.bodyProbeFailed, undefined);
  assert.deepEqual(assessStaticNotFoundBody({ text: fetched!.text, truncated: fetched!.truncated }), {
    confirmed: false,
    reason: 'TRUNCATED',
  });
});

test('required YouTube About failure is not suppressed by the optional-surface rule', async () => {
  const renders = countRenderCalls();
  const result = await inspect({
    channelLinks: [],
    youtubeUrl: 'https://www.youtube.com/@creator',
    liveChannelDataLoader: (async () => null) as never,
    videoDescriptionsAuthoritative: true,
    recentVideoDescriptions: Array.from({ length: 8 }, (_, index) => ({
      videoId: `video-${index}`,
      description: `authoritative description ${index}`,
    })),
    fetchImpl: (async () => response('', 404)) as unknown as typeof fetch,
    renderedFallback: renders.fallback,
  });
  const about = (result.acquisitionOutcomes || []).find(item => item.surface === 'YOUTUBE_ABOUT');
  assert.ok(about, 'required About observation exists');
  assert.equal(about.required, true);
  assert.equal(about.outcome, 'ACQUISITION_FAILED');
  assert.equal(about.failureClass, 'YOUTUBE_ABOUT_ACQUISITION_FAILED');
  assert.notEqual(about.staticTerminalNotFound, true);
});
