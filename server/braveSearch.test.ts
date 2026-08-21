import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeYouTubeLocator,
  evaluateBraveCandidateNoise,
  buildBraveSearchRequest,
  mapLanguageToBraveParam,
  extractCandidatesFromBraveResponse,
  stageDiscoveredCandidates,
  fetchBraveSearchResults,
  executeBraveSearchRetrieval,
  checkBraveControlPlane,
  BRAVE_DIRECT_PROVIDER,
  BRAVE_OSINT_PROVIDER,
  BRAVE_SEARCH_PROVIDER_KEY
} from './braveSearch';
import { executeAllocatedRetrievalPage } from './providerAwareRetrieval';

test('normalizeYouTubeLocator correctly parses channel IDs, handles, video IDs, and external pages', () => {
  const channel = normalizeYouTubeLocator('https://www.youtube.com/channel/UC1234567890123456789012');
  assert.equal(channel?.candidateType, 'CHANNEL_ID');
  assert.equal(channel?.normalizedIdentity, 'UC1234567890123456789012');

  const handle = normalizeYouTubeLocator('https://youtube.com/@TraderJohn?sub_confirmation=1');
  assert.equal(handle?.candidateType, 'HANDLE');
  assert.equal(handle?.normalizedIdentity, '@traderjohn');

  const video = normalizeYouTubeLocator('https://youtu.be/dQw4w9WgXcQ');
  assert.equal(video?.candidateType, 'VIDEO_ID');
  assert.equal(video?.normalizedIdentity, 'dQw4w9WgXcQ');

  const external = normalizeYouTubeLocator('https://example.com/blog/best-traders-in-uk');
  assert.equal(external?.candidateType, 'EXTERNAL_EVIDENCE');
  assert.equal(external?.isNoise, false);

  const noise = normalizeYouTubeLocator('https://pinterest.com/pin/12345');
  assert.equal(noise?.candidateType, 'EXTERNAL_EVIDENCE');
  assert.equal(noise?.isNoise, true);
});

test('evaluateBraveCandidateNoise identifies low-quality SEO and spam', () => {
  const goodItem = { title: 'Top London FX Trader Interview', url: 'https://example.com/interview' };
  assert.equal(evaluateBraveCandidateNoise(goodItem).isNoise, false);

  const spamItem = { title: 'Best 10 Brokers with Promo Code', url: 'https://example.com/promo' };
  assert.equal(evaluateBraveCandidateNoise(spamItem).isNoise, true);
});

test('Brave language labels map to supported search_lang codes and requests include no-cache', () => {
  assert.equal(mapLanguageToBraveParam('English'), 'en');
  assert.equal(mapLanguageToBraveParam('English (Australia)'), 'en');
  assert.equal(mapLanguageToBraveParam('French'), 'fr');
  assert.equal(mapLanguageToBraveParam('en-AU'), 'en');
  assert.equal(mapLanguageToBraveParam(undefined), 'en');
  const req = buildBraveSearchRequest('forex trading', 'Australia', 'English', 'DIRECT_YOUTUBE', 0, 20, 'test-key-123');
  assert.ok(req.url.includes('country=australia'));
  assert.ok(req.url.includes('search_lang=en'));
  assert.equal(req.headers['Cache-Control'], 'no-cache');
});

test('buildBraveSearchRequest constructs valid endpoint URL, headers, and dynamic search_lang', () => {
  const req = buildBraveSearchRequest('forex trading', 'GB', 'es', 'DIRECT_YOUTUBE', 0, 20, 'test-key-123');
  assert.ok(req.url.includes('site%3Ayoutube.com+forex+trading') || req.url.includes('site:youtube.com'));
  assert.ok(req.url.includes('country=gb'));
  assert.ok(req.url.includes('search_lang=es'));
  assert.equal(req.headers['X-Subscription-Token'], 'test-key-123');
});

test('extractCandidatesFromBraveResponse extracts valid candidates and filters direct vs OSINT mode', () => {
  const mockResponse = {
    web: {
      total: 3,
      results: [
        {
          title: 'FX Strategy Guide - Channel',
          url: 'https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv',
          description: 'Official FX channel'
        },
        {
          title: 'Daily Market Update @FXMaster',
          url: 'https://youtube.com/@FXMaster',
          description: 'Daily market streams'
        },
        {
          title: 'External Blog',
          url: 'https://example.com/blog',
          description: 'Non-YouTube page'
        }
      ]
    }
  };

  const directCandidates = extractCandidatesFromBraveResponse(mockResponse, 'DIRECT_YOUTUBE');
  assert.equal(directCandidates.length, 2);
  assert.equal(directCandidates[0].candidateType, 'CHANNEL_ID');
  assert.equal(directCandidates[1].candidateType, 'HANDLE');

  const osintCandidates = extractCandidatesFromBraveResponse(mockResponse, 'EXTERNAL_OSINT');
  assert.equal(osintCandidates.length, 3);
  assert.equal(osintCandidates[2].candidateType, 'EXTERNAL_EVIDENCE');
});

test('checkBraveControlPlane strictly fails closed when DB is unavailable', async () => {
  const status = await checkBraveControlPlane(null);
  assert.equal(status.allowed, false);
  assert.equal(status.reason, 'CONTROL_PLANE_UNAVAILABLE_FAIL_CLOSED');
});

test('checkBraveControlPlane respects emergency kill switch env', async () => {
  const origEnv = process.env.BRAVE_KILL_SWITCH;
  process.env.BRAVE_KILL_SWITCH = 'true';
  try {
    const status = await checkBraveControlPlane();
    assert.equal(status.allowed, false);
    assert.equal(status.killSwitchActive, true);
  } finally {
    process.env.BRAVE_KILL_SWITCH = origEnv;
  }
});

test('checkBraveControlPlane fails closed on database error', async () => {
  const mockDbWithError = {
    query: async () => { throw new Error('DB_CONNECTION_ERROR'); }
  };
  const status = await checkBraveControlPlane(mockDbWithError);
  assert.equal(status.allowed, false);
  assert.equal(status.reason, 'CONTROL_PLANE_CHECK_FAILED');
});

test('checkBraveControlPlane enforces staging backlog threshold backpressure', async () => {
  const mockDbWithHighBacklog = {
    query: async (sql: string) => {
      if (sql.includes('app_settings')) return { rows: [{ setting_key: 'brave_staging_backlog_threshold', setting_value: '10' }] };
      if (sql.includes('discovery_provider_registry')) return { rows: [{ mode: 'SHADOW' }] };
      if (sql.includes('discovery_candidate_staging')) return { rows: [{ backlog_count: 50 }] };
      if (sql.includes('query_runs')) return { rows: [{ daily_requests: 0 }] };
      return { rows: [] };
    }
  };

  const status = await checkBraveControlPlane(mockDbWithHighBacklog);
  assert.equal(status.allowed, false);
  assert.equal(status.reason, 'STAGING_BACKLOG_THRESHOLD_EXCEEDED');
  assert.equal(status.backlogThresholdExceeded, true);
});

test('fetchBraveSearchResults handles 429 rate limits fail-closed', async () => {
  const mockFetch = async () => new Response('Rate limit exceeded', { status: 429 });
  process.env.BRAVE_SEARCH_API_KEY = 'test-key';
  await assert.rejects(
    async () => fetchBraveSearchResults('forex', 'US', 'en', 'DIRECT_YOUTUBE', 0, 20, mockFetch as any),
    /BRAVE_API_RATE_LIMIT_429/
  );
});

test('executeBraveSearchRetrieval returns empty channels in SHADOW mode while setting nextPageToken', async () => {
  const mockFetch = async () => new Response(JSON.stringify({
    query: { more_results_available: true },
    web: {
      total: 100,
      results: [
        {
          title: 'UK Trader Channel',
          url: 'https://www.youtube.com/channel/UC1111111111111111111111',
          description: 'Trading in London'
        }
      ]
    }
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  const mockDbShadow = {
    query: async (sql: string) => {
      if (sql.includes('INSERT INTO discovery_candidate_staging')) return { rows: [{ id: 'staging-shadow', inserted: true }] };
      if (sql.includes('app_settings')) return { rows: [] };
      if (sql.includes('discovery_provider_registry')) return { rows: [{ mode: 'SHADOW' }] };
      if (sql.includes('discovery_candidate_staging')) return { rows: [{ backlog_count: 0 }] };
      if (sql.includes('query_runs')) return { rows: [{ daily_requests: 0 }] };
      return { rows: [] };
    }
  };

  const origFetch = globalThis.fetch;
  globalThis.fetch = mockFetch as any;
  process.env.BRAVE_SEARCH_API_KEY = 'test-key';

  try {
    const page = await executeBraveSearchRetrieval({
      provider: BRAVE_DIRECT_PROVIDER,
      query: 'trading london',
      country: 'GB',
      lane: 'CHANNEL',
      cursor: null,
      ordering: 'RELEVANCE'
    }, mockDbShadow);

    // SHADOW mode: candidate staged, but channels array returned empty to Phase 9
    assert.equal(page.channels.length, 0);
    assert.equal(page.rawResultCount, 1);
    assert.equal(page.nextPageToken, '1'); // Brave continuation is controlled by more_results_available and bounded offset
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('executeBraveSearchRetrieval returns channels in ACTIVE mode', async () => {
  const mockFetch = async () => new Response(JSON.stringify({
    query: { more_results_available: true },
    web: {
      total: 50,
      results: [
        {
          title: 'UK Trader Channel',
          url: 'https://www.youtube.com/channel/UC1111111111111111111111',
          description: 'Trading in London'
        }
      ]
    }
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  const mockDbActive = {
    query: async (sql: string) => {
      if (sql.includes('INSERT INTO discovery_candidate_staging')) return { rows: [{ id: 'staging-active', inserted: true }] };
      if (sql.includes('app_settings')) return { rows: [] };
      if (sql.includes('discovery_provider_registry')) return { rows: [{ mode: 'ACTIVE' }] };
      if (sql.includes('discovery_candidate_staging')) return { rows: [{ backlog_count: 0 }] };
      if (sql.includes('query_runs')) return { rows: [{ daily_requests: 0 }] };
      return { rows: [] };
    }
  };

  const origFetch = globalThis.fetch;
  globalThis.fetch = mockFetch as any;
  process.env.BRAVE_SEARCH_API_KEY = 'test-key';

  try {
    const page = await executeBraveSearchRetrieval({
      provider: BRAVE_DIRECT_PROVIDER,
      query: 'trading london',
      country: 'GB',
      lane: 'CHANNEL',
      cursor: null,
      ordering: 'RELEVANCE'
    }, mockDbActive);

    assert.equal(page.channels.length, 1);
    assert.equal(page.channels[0].channelId, 'UC1111111111111111111111');
    assert.equal(page.nextPageToken, '1');
  } finally {
    globalThis.fetch = origFetch;
  }
});
