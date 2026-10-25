import assert from 'node:assert/strict';
import test from 'node:test';
import { assessStaticNotFoundBody, isConfirmedStaticTerminalNotFound } from './staticTerminalNotFound';
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
    staticTerminalNotFound: true,
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

test('static 404 body: community content keeps rendered escalation', () => {
  for (const marker of [
    'https://discord.gg/creator',
    'https://discord.com/invite/creator',
    'https://t.me/creator',
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
      observations: [observation({ staticTerminalNotFound: false })],
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
