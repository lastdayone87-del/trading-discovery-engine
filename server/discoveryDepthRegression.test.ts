import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { triageAutonomousSearchCandidate } from './candidateTriage';
import { allocateSearchOrdering } from './searchOrdering';
import { evaluateContinuation } from './continuationPolicy';
import { crawlExternalLinks, runChannelInspection } from './inspector';
import { calculateCreatorQualityScore } from './queryIntelligence';

function tradingVideoCandidate(publishedAt: string) {
  return {
    channelId: 'UC1234567890123456789012',
    channelName: 'Active Futures Trader',
    youtubeUrl: 'https://youtube.com/channel/UC1234567890123456789012',
    description: '',
    videoTitles: [],
    matchedDocument: {
      type: 'VIDEO' as const,
      providerNativeId: 'video-1',
      title: 'NQ futures live trading and market structure',
      description: 'Live futures trading session',
      publishedAt,
      locator: 'youtube:video:video-1'
    }
  };
}

test('fresh autonomous trading videos remain eligible while stale retrieval documents are withheld', () => {
  const previous = process.env.DISCOVERY_MAX_MATCH_AGE_DAYS;
  process.env.DISCOVERY_MAX_MATCH_AGE_DAYS = '730';
  try {
    const fresh = triageAutonomousSearchCandidate(
      tradingVideoCandidate(new Date(Date.now() - 7 * 86_400_000).toISOString()),
      'automated_query',
      false
    );
    assert.equal(fresh.disposition, 'PLAUSIBLE_TRADING_HYPOTHESIS');
    assert.ok(fresh.matchedSignals.length > 0);

    const stale = triageAutonomousSearchCandidate(
      tradingVideoCandidate(new Date(Date.now() - 1000 * 86_400_000).toISOString()),
      'automated_query',
      false
    );
    assert.equal(stale.disposition, 'WITHHOLD_NO_PLAUSIBLE_HYPOTHESIS');
    assert.ok(stale.reasonCodes.includes('STALE_RETRIEVAL_DOCUMENT'));
    assert.ok(stale.reasonCodes.includes('DO_NOT_SPEND_ENRICHMENT_QUOTA'));
  } finally {
    if (previous === undefined) delete process.env.DISCOVERY_MAX_MATCH_AGE_DAYS;
    else process.env.DISCOVERY_MAX_MATCH_AGE_DAYS = previous;
  }
});

test('VIDEO retrieval converges to the configured freshness floor while CHANNEL retrieval stays relevance ordered', () => {
  const previous = process.env.DISCOVERY_RECENCY_FLOOR_PERCENT;
  process.env.DISCOVERY_RECENCY_FLOOR_PERCENT = '60';
  try {
    let dateRuns = 0;
    for (let totalRuns = 0; totalRuns < 10; totalRuns++) {
      const ordering = allocateSearchOrdering('VIDEO', dateRuns, totalRuns, 10);
      if (ordering === 'DATE') dateRuns++;
    }
    assert.equal(dateRuns, 6, '10 VIDEO allocations should converge to the 60% DATE freshness floor');
    assert.equal(allocateSearchOrdering('CHANNEL', 0, 0, 100), 'RELEVANCE');
  } finally {
    if (previous === undefined) delete process.env.DISCOVERY_RECENCY_FLOOR_PERCENT;
    else process.env.DISCOVERY_RECENCY_FLOOR_PERCENT = previous;
  }
});

test('adaptive pagination continues productive pages and stops after bounded consecutive low-yield pages', () => {
  const productive = evaluateContinuation({
    pageNumber: 1,
    maxPages: 3,
    hasNextPage: true,
    distinctCreators: 20,
    cumulativeDistinctCreators: 20,
    newCreators: 15,
    confirmedCreators: 10,
    qualityConfirmedCreators: 8,
    countryPrecision: 0.9,
    communityDiversity: 0.5,
    duplicateRatio: 0.1,
    consecutiveLowYieldPages: 0,
    maxConsecutiveLowYieldPages: 2
  });
  assert.equal(productive.shouldContinue, true);
  assert.equal(productive.primaryReason, 'CONTINUE_PRODUCTIVE');

  const exhausted = evaluateContinuation({
    pageNumber: 2,
    maxPages: 3,
    hasNextPage: true,
    distinctCreators: 20,
    cumulativeDistinctCreators: 40,
    newCreators: 1,
    confirmedCreators: 0,
    qualityConfirmedCreators: 0,
    countryPrecision: 0.3,
    communityDiversity: 0,
    duplicateRatio: 0.9,
    consecutiveLowYieldPages: 1,
    maxConsecutiveLowYieldPages: 2
  });
  assert.equal(exhausted.shouldContinue, false);
  assert.equal(exhausted.primaryReason, 'CONSECUTIVE_LOW_YIELD');
});

test('creator freshness score comes from observed activity rather than the presence of search-result titles', () => {
  const active = calculateCreatorQualityScore({
    channel_name: 'Trader A',
    activity_band: 'VERY_ACTIVE'
  }, ['A returned title'], 'order flow market structure');
  const dormant = calculateCreatorQualityScore({
    channel_name: 'Trader B',
    activity_band: 'DORMANT'
  }, ['A returned title'], 'order flow market structure');
  const unknown = calculateCreatorQualityScore({
    channel_name: 'Trader C'
  }, ['A returned title'], 'order flow market structure');

  assert.equal(active.breakdown.freshness_activity, 25);
  assert.equal(dormant.breakdown.freshness_activity, 2);
  assert.equal(unknown.breakdown.freshness_activity, 8);
});

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

test('website crawler follows prioritized same-origin community navigation to a Discord invite', async () => {
  const calls: string[] = [];
  const fakeFetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url === 'https://creator.test/') {
      return htmlResponse('<a href="https://elsewhere.test/community">External community</a><a href="/community">Community</a>');
    }
    if (url === 'https://creator.test/community') {
      return htmlResponse('<a href="/members">Members</a>');
    }
    if (url === 'https://creator.test/members') {
      return htmlResponse('<a href="https://discord.gg/RealTradingRoom">Join our Discord</a>');
    }
    throw new Error(`Unexpected crawl: ${url}`);
  }) as typeof fetch;

  const result = await crawlExternalLinks(['https://creator.test/'], [], undefined, fakeFetch);
  assert.equal(result.outcome, 'FOUND');
  assert.equal(result.foundInvite, 'RealTradingRoom');
  assert.deepEqual(calls, [
    'https://creator.test/',
    'https://creator.test/community',
    'https://creator.test/members'
  ]);
  assert.equal(calls.some(url => url.startsWith('https://elsewhere.test/')), false, 'crawler must not wander off the creator origin');
});

test('website crawler remains bounded to eight prioritized follow-up pages', async () => {
  const calls: string[] = [];
  const links = Array.from({ length: 20 }, (_, index) => `<a href="/community-${index}">Community ${index}</a>`).join('');
  const fakeFetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url === 'https://bounded.test/') return htmlResponse(links);
    return htmlResponse('<p>No community invite here.</p>');
  }) as typeof fetch;

  const result = await crawlExternalLinks(['https://bounded.test/'], [], undefined, fakeFetch);
  assert.equal(result.foundInvite, null);
  assert.equal(result.outcome, 'INSPECTED_NO_MATCH');
  assert.equal(calls.length, 9, 'one root page plus at most eight prioritized follow-up pages may be fetched');
});

test('mixed website acquisition success and failure is projected as PARTIAL rather than full ERROR', async () => {
  const fakeFetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === 'https://good.test/') return htmlResponse('<p>No Discord link on this successfully inspected site.</p>');
    if (url === 'https://broken.test/') return htmlResponse('temporary failure', 503);
    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;

  const inspection = await runChannelInspection({
    channelId: '',
    channelBio: 'Trading creator',
    channelLinks: ['https://good.test/', 'https://broken.test/'],
    videoDescriptions: ['one', 'two', 'three', 'four', 'five'],
    externalFetchImpl: fakeFetch
  });
  const websiteStep = inspection.steps.find(step => step.step === 'CUSTOM_DOMAINS');
  assert.ok(websiteStep);
  assert.equal(websiteStep.status, 'PARTIAL');
  assert.equal(inspection.acquisitionOutcomes?.some(item => item.outcome === 'ACQUISITION_FAILED'), true);
  assert.equal(inspection.acquisitionOutcomes?.some(item => item.outcome === 'INSPECTED_NO_MATCH'), true);
});

test('Discord candidate selection contract does not stop on the first merely operational success', () => {
  const source = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
  assert.match(source, /const validationRank=/);
  assert.match(source, /TRADING_RELEVANT[^\n]*ACTIVE[^\n]*ACTIVE_LOW_VOLUME[^\n]*return 100/);
  assert.match(source, /if\(rank>=100\)break;/);
  assert.doesNotMatch(source, /if\(validation\.operationalOutcome==='SUCCEEDED'\)\{selected=validation;selectedCandidate=candidate;break;\}/);
});
