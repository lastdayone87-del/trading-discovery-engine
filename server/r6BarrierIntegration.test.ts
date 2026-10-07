import assert from 'node:assert/strict';
import test from 'node:test';
import { runChannelInspection } from './inspector';
import type { BrowserFallbackResult } from './browserCommunityFallback';

const html = (body: string, url = '') => {
  const res = new Response(`<html><body>${body}</body></html>`, {
    status: 200,
    headers: { 'content-type': 'text/html' },
  });
  if (url) Object.defineProperty(res, 'url', { value: url });
  return res;
};
const noInviteHtml = async () => html('No Discord invite here');
const loginHtml = (finalUrl: string) =>
  (async () => {
    return html(
      '<form action="/login"><input name="user"><input type="password" name="pass">Sign in</form>',
      finalUrl,
    );
  }) as typeof fetch;
const emptyRendered = async (seedUrl: string): Promise<BrowserFallbackResult> => ({
  foundInvite: null,
  foundLocation: seedUrl,
  inspectedPages: 1,
  scrolls: 0,
  clicks: 0,
  complete: true,
  retryable: false,
  detail: 'test rendered surface inspected without invite',
});
const isolatedStore = () => ({ read: async () => [], write: async () => {}, recordLinks: async () => {} });
const noHistory = (async () => []) as never;
const fillers = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];

async function inspect(
  input: {
    channelLinks?: string[];
    videoDescriptions?: string[];
    youtubeUrl?: string;
    liveChannelDataLoader?: never;
  },
  fetchImpl: typeof fetch,
  store: ReturnType<typeof isolatedStore> = isolatedStore(),
) {
  const renderedCalls: string[] = [];
  const result = await runChannelInspection({
    channelId: `r6-${Math.random().toString(36).slice(2)}`,
    channelName: 'R6 Barrier Channel',
    channelBio: 'Trading notes',
    channelLinks: input.channelLinks || [],
    videoDescriptions: input.videoDescriptions || fillers,
    youtubeUrl: input.youtubeUrl,
    liveChannelDataLoader: input.liveChannelDataLoader,
    creatorLikelyTrading: true,
    enableDebug: true,
    recentVideoDescriptionsLoader: (async () => []) as never,
    externalFetchImpl: fetchImpl,
    renderedFallback: (async (seedUrl: string) => {
      renderedCalls.push(seedUrl);
      return emptyRendered(seedUrl);
    }) as typeof emptyRendered,
    urlFailureHistoryLoader: noHistory,
    siteInspectionStore: store,
  } as never);
  return { result, renderedCalls };
}

// Finding 7: a conclusive static terminal barrier never escalates the same
// seed into rendered acquisition (which could hide/replace the terminal
// result or restore retry ownership).
test('terminal login wall: no rendered escalation, visible terminal, no retry', async () => {
  const seed = 'https://www.instagram.com/somecreator';
  const { result, renderedCalls } = await inspect(
    { channelLinks: [seed] },
    loginHtml('https://www.instagram.com/accounts/login/?next=/somecreator') as never,
  );
  assert.ok(!renderedCalls.includes(seed), 'rendered must not run for the terminal seed');
  const loginObs = result.acquisitionOutcomes.filter(
    o => o.requestedUrl === seed && (o.failureClass === 'LOGIN_WALL' || o.failureClass === 'PAYWALL_WALL'),
  );
  assert.ok(loginObs.length > 0, 'terminal barrier observation recorded');
  assert.ok(loginObs.every(o => o.retryable === false), 'terminal barrier non-retryable');
  assert.ok(loginObs.every(o => o.outcome !== 'INSPECTED_NO_MATCH'), 'never a clean negative');
  assert.equal(result.retryDirective, undefined, 'no retry owned by terminal barrier');
  assert.notEqual(result.acquisitionStatus, 'INSPECTED_NO_MATCH');
});

// Finding 8: creator-canonical hosts come from live-refreshed links, so a
// creator news page discovered during the current inspection is ELIGIBLE
// (not DEMOTE) exactly like a statically provided channel link.
test('refreshed creator links receive canonical treatment in relevance', async () => {
  process.env.RELEVANCE_ENFORCEMENT_ENABLED = 'true';
  try {
    const newsUrl = 'https://mycreator.example/news/launch';
    const { result } = await inspect(
      {
        channelLinks: [],
        youtubeUrl: 'https://www.youtube.com/channel/UCtest',
        liveChannelDataLoader: (async () => ({
          bio: 'Trading education',
          channelLinks: [newsUrl],
        })) as never,
      },
      (async () => html('No Discord invite here')) as typeof fetch,
    );
    const decisions = ((result.debugLog || {}) as { relevanceDecisions?: Array<{ url: string; tier: string }> })
      .relevanceDecisions || [];
    const news = decisions.filter(d => d.url === newsUrl);
    assert.ok(news.length > 0, 'news seed classified');
    assert.ok(
      news.every(d => d.tier === 'ELIGIBLE'),
      `refreshed creator news stays ELIGIBLE, got ${JSON.stringify(news)}`,
    );
  } finally {
    delete process.env.RELEVANCE_ENFORCEMENT_ENABLED;
  }
});

// Finding 6: a DEMOTE seed reusing cached coverage stays non-owning — the
// borrowed observations carry the seed tier, so they cannot own outcome or
// retry even though the cached row itself is reusable.
test('demoted borrow stays non-owning (tier carried onto borrowed observations)', async () => {
  process.env.RELEVANCE_ENFORCEMENT_ENABLED = 'true';
  try {
    const newsUrl = 'https://newsw.example/news/launch';
    const now = new Date().toISOString();
    const cachedRow = {
      siteIdentity: 'newsw.example',
      identityTier: 'A',
      identityBasis: '',
      canonicalUrl: 'https://newsw.example/news/launch',
      finalUrl: 'https://newsw.example/news/launch',
      outcome: 'INSPECTED_NO_MATCH',
      retryable: false,
      httpStatus: 200,
      failureClass: '',
      detail: 'cached clean',
      payloadChecksum: null,
      candidates: [],
      observations: [
        {
          requestedUrl: newsUrl,
          rootUrl: newsUrl,
          finalUrl: 'https://newsw.example/news/launch',
          surface: 'CREATOR_WEBSITES',
          required: false,
          outcome: 'INSPECTED_NO_MATCH',
          retryable: false,
        },
      ],
      renderedCovered: true,
      lastObservedAt: now,
    };
    const store = {
      read: async () => [cachedRow],
      write: async () => {},
      recordLinks: async () => {},
    };
    const { result } = await inspect(
      { channelLinks: [], videoDescriptions: [`Read more ${newsUrl} here`, ...fillers] },
      (async () => {
        throw new Error('must reuse cache, not fetch');
      }) as typeof fetch,
      store as never,
    );
    const borrowed = result.acquisitionOutcomes.filter(o => o.requestedUrl === newsUrl);
    assert.ok(borrowed.length > 0, 'borrowed observations present');
    assert.ok(
      borrowed.every(o => (o as unknown as Record<string, unknown>).relevanceTier === 'DEMOTE'),
      'borrowed observations carry DEMOTE tier',
    );
    assert.equal(result.acquisitionStatus, 'INSPECTED_NO_MATCH');
    assert.equal(result.retryDirective, undefined);
  } finally {
    delete process.env.RELEVANCE_ENFORCEMENT_ENABLED;
  }
});

// Finding 2: single-attempt 401/403 stays retryable (uncertain → retryable).
test('single 403 remains retryable acquisition failure (not terminal)', async () => {
  const { result } = await inspect(
    { channelLinks: ['https://example.com/gated-page'] },
    (async () => new Response('forbidden', { status: 403, headers: { 'content-type': 'text/html' } })) as typeof fetch,
  );
  const failures = result.acquisitionOutcomes.filter(
    o => o.requestedUrl === 'https://example.com/gated-page' && o.outcome === 'ACQUISITION_FAILED',
  );
  assert.ok(failures.length > 0, 'failure recorded');
  assert.ok(
    failures.some(o => o.retryable === true && o.failureClass === 'HTTP_ERROR'),
    'single 403 is retryable HTTP_ERROR, not terminal',
  );
});
