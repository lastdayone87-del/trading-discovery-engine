import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildProviderRequestBaseId,
  providerSnapshot,
  YOUTUBE_SEARCH_PROVIDER,
  executeAllocatedRetrievalPage,
  registerRetrievalExecutor,
  clearRegisteredExecutorsForTest,
  isShadowBraveCanaryAllowed,
  type ProviderAllocation,
  type RetrievalRequest,
  type RetrievalPage
} from './providerAwareRetrieval';

test('current production provider contract preserves official YouTube semantics', () => {
  assert.deepEqual(YOUTUBE_SEARCH_PROVIDER, {
    providerKey: 'youtube-search',
    retrievalSurface: 'YOUTUBE_NATIVE',
    capability: 'SEARCH_YOUTUBE',
    costDomain: 'YOUTUBE_DATA_API',
    continuationOwner: 'PHASE_9'
  });
  assert.equal(providerSnapshot(undefined), YOUTUBE_SEARCH_PROVIDER);
});

test('only the explicit Brave direct-search canary may allocate a SHADOW provider', () => {
  assert.equal(isShadowBraveCanaryAllowed({ mode: 'SHADOW', providerKey: 'brave-search', capability: 'SEARCH_BRAVE_DIRECT', allowShadowProvider: true }), true);
  assert.equal(isShadowBraveCanaryAllowed({ mode: 'SHADOW', providerKey: 'brave-search', capability: 'SEARCH_BRAVE_DIRECT', allowShadowProvider: false }), false);
  assert.equal(isShadowBraveCanaryAllowed({ mode: 'SHADOW', providerKey: 'youtube-search', capability: 'SEARCH_YOUTUBE', allowShadowProvider: true }), false);
  assert.equal(isShadowBraveCanaryAllowed({ mode: 'CANARY', providerKey: 'brave-search', capability: 'SEARCH_BRAVE_DIRECT', allowShadowProvider: true }), false);
});

test('provider request identity is deterministic and contains no provider secret', () => {
  const base = buildProviderRequestBaseId({ queryRunId: 'run-1', jobId: 'job-1', jobAttempt: 2, pageNumber: 3 });
  assert.equal(base, 'query-run:run-1:job:job-1:attempt:2:page:3');
  assert.equal(`${base}:attempt:4`, 'query-run:run-1:job:job-1:attempt:2:page:3:attempt:4');
  assert.doesNotMatch(base, /key|secret|token/i);
});

test('provider contract accepts a hypothetical non-YouTube provider shape structurally', () => {
  const braveProvider: ProviderAllocation = {
    providerKey: 'brave-search',
    retrievalSurface: 'BRAVE_WEB',
    capability: 'SEARCH_WEB',
    costDomain: 'BRAVE_SEARCH_API',
    continuationOwner: 'PHASE_9'
  };

  const snapshot = providerSnapshot(braveProvider);
  assert.deepEqual(snapshot, braveProvider);
  assert.ok(Object.isFrozen(snapshot));
});

test('malformed provider snapshot is rejected', () => {
  // Missing required fields
  assert.throws(
    () => providerSnapshot({ providerKey: 'brave-search', retrievalSurface: 'BRAVE_WEB' } as any),
    /INVALID_PROVIDER_ALLOCATION_SNAPSHOT/
  );

  // Invalid continuationOwner
  assert.throws(
    () => providerSnapshot({ ...YOUTUBE_SEARCH_PROVIDER, continuationOwner: 'PHASE_8' as any }),
    /INVALID_PROVIDER_ALLOCATION_SNAPSHOT/
  );
});

test('future providers do not default to YouTube identity, YOUTUBE_NATIVE or YOUTUBE_DATA_API when provider fields are omitted', () => {
  const incompleteBrave: Partial<ProviderAllocation> = {
    providerKey: 'brave-search',
    retrievalSurface: 'BRAVE_WEB'
    // costDomain and capability omitted
  };

  assert.throws(
    () => providerSnapshot(incompleteBrave),
    /INVALID_PROVIDER_ALLOCATION_SNAPSHOT/
  );
});

test('unknown provider cannot execute without a registered executor', async () => {
  const braveProvider: ProviderAllocation = {
    providerKey: 'brave-search',
    retrievalSurface: 'BRAVE_WEB',
    capability: 'SEARCH_WEB',
    costDomain: 'BRAVE_SEARCH_API',
    continuationOwner: 'PHASE_9'
  };

  await assert.rejects(
    executeAllocatedRetrievalPage({
      provider: braveProvider,
      query: 'trading',
      country: 'US',
      lane: 'VIDEO',
      cursor: null,
      ordering: 'RELEVANCE'
    }),
    /UNREGISTERED_OR_MISMATCHED/
  );
});

test('hypothetical non-YouTube provider can execute when registered via executor dispatch map with non-100 cost model', async () => {
  const mockBraveProvider: ProviderAllocation = {
    providerKey: 'brave-search-mock',
    retrievalSurface: 'BRAVE_WEB_MOCK',
    capability: 'SEARCH_WEB_MOCK',
    costDomain: 'BRAVE_SEARCH_API_MOCK',
    continuationOwner: 'PHASE_9'
  };

  let reservedUnitsCount = 0;
  const mockExecutor = async (req: RetrievalRequest): Promise<RetrievalPage> => {
    if (req.reserveAdditionalUnits) await req.reserveAdditionalUnits(1);
    return {
      channels: [{
        channelId: 'c_brave_1',
        channelName: 'Brave Trader',
        youtubeUrl: 'https://youtube.com/c/brave',
        description: 'Brave trading channel',
        videoTitles: ['Brave Trading Strategy']
      }],
      rawResultCount: 1,
      nextPageToken: null
    };
  };

  try {
    registerRetrievalExecutor(mockBraveProvider, mockExecutor);

    const result = await executeAllocatedRetrievalPage({
      provider: mockBraveProvider,
      query: 'crypto trading',
      country: 'US',
      lane: 'VIDEO',
      cursor: null,
      ordering: 'RELEVANCE',
      reserveAdditionalUnits: async (units) => {
        reservedUnitsCount += units;
      }
    });

    assert.equal(result.channels.length, 1);
    assert.equal(reservedUnitsCount, 1, 'Brave provider must be able to reserve 1 unit without being forced to 100');
  } finally {
    clearRegisteredExecutorsForTest();
  }
});

test('wrong capability or wrong cost domain is rejected during snapshot/execution', async () => {
  const mismatchedCapability: ProviderAllocation = {
    ...YOUTUBE_SEARCH_PROVIDER,
    capability: 'SEARCH_BRAVE'
  };

  assert.throws(
    () => providerSnapshot(mismatchedCapability),
    /UNREGISTERED_OR_MISMATCHED/
  );

  await assert.rejects(
    executeAllocatedRetrievalPage({
      provider: mismatchedCapability,
      query: 'forex',
      country: 'US',
      lane: 'VIDEO',
      cursor: null,
      ordering: 'RELEVANCE'
    }),
    /UNREGISTERED_OR_MISMATCHED/
  );
});

test('migration 111 is additive, backfills official-only history, protects lineage, and sets no silent YouTube defaults', () => {
  const sql = readFileSync(new URL('./db/migrations/111_provider_aware_phase8_phase9.sql', import.meta.url), 'utf8');
  for (const field of ['provider_key', 'retrieval_surface', 'provider_capability', 'cost_domain', 'provider_reservation_id', 'provider_eligibility_snapshot', 'continuation_owner']) {
    assert.match(sql, new RegExp(field));
  }
  assert.match(sql, /WHERE provider_key IS NULL/);
  assert.match(sql, /IMMUTABLE_PROVIDER_ALLOCATION_LINEAGE/);
  assert.match(sql, /IMMUTABLE_QUERY_RUN_PROVIDER_LINEAGE/);
  assert.doesNotMatch(sql, /DROP TABLE|DROP COLUMN|TRUNCATE/i);
  assert.doesNotMatch(sql, /ALTER COLUMN provider_key SET DEFAULT 'youtube-search'/);
  assert.doesNotMatch(sql, /ALTER COLUMN provider_reserved_amount SET DEFAULT 100/);
});

test('allocated retrieval forwards query-run, request, and job lifecycle identities to the default YouTube executor', () => {
  const retrieval = readFileSync(new URL('./providerAwareRetrieval.ts', import.meta.url), 'utf8');
  const queue = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
  const youtube = readFileSync(new URL('./youtube.ts', import.meta.url), 'utf8');
  assert.match(retrieval, /request\.requestId/);
  assert.match(retrieval, /runId: request\.queryRunId/);
  assert.match(retrieval, /jobId: request\.jobId/);
  assert.match(queue, /requestId:providerRequestBaseId,jobId:job\.id/);
  assert.match(youtube, /providerDispatchAttempt/);
  assert.match(youtube, /buildYouTubeProviderRequestId\(lifecycle\?\.requestId, dispatchAttempt\)/);
  assert.match(youtube, /attempt:dispatchAttempt/);
  assert.match(youtube, /runId:lifecycle\?\.runId,jobId:lifecycle\?\.jobId/);
});

test('production queue worker loads Brave executor registration before dispatch', () => {
  const queue = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
  assert.match(queue, /import ['"]\.\/braveSearch['"]/);
});

test('Phase 8 registry validation and Phase 9 governed dispatch are wired', () => {
  const allocator = readFileSync(new URL('./discoveryFrontierAllocator.ts', import.meta.url), 'utf8');
  const queue = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
  assert.match(allocator, /discovery_provider_registry[\s\S]*FOR SHARE/);
  assert.match(allocator, /providerEligibilitySnapshot/);
  assert.match(queue, /executeAllocatedRetrievalPage/);
  assert.match(queue, /PHASE9_PROVIDER_LINEAGE_MISMATCH/);
  const db = readFileSync(new URL('./db.ts', import.meta.url), 'utf8');
  assert.match(db, /mode IN \('ACTIVE','ACTIVE_GLOBAL','CANARY'\)/);
  assert.match(db, /isShadowBraveCanaryAllowed/);
  assert.match(db, /allowShadowProvider/);
});
