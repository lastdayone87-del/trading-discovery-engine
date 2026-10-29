import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import type { ChannelRecord } from '../src/types';
import { SUPPORTED_DORMANT_COUNTRIES, SUPPORTED_PRODUCTION_COUNTRIES } from '../src/data/initial_countries';
import {
  countTrailingContinuationStreaks,
  computeEffectivePageBudget,
  evaluateContinuationV2,
  resumeModeForProvider,
  shouldCreateContinuationSegment,
} from './continuationPolicy';
import {
  AUTONOMOUS_CONTINUATION_JOB_PRIORITY,
  AUTONOMOUS_NEW_QUERY_JOB_PRIORITY,
  planContinuationResume,
} from './queueManager';
import { resolveAutonomousCountries } from './autonomousDiscovery';
import {
  NATIVE_PROMOTION_MIN_CREATORS,
  NATIVE_PROMOTION_MIN_EXECUTIONS,
  NATIVE_PROMOTION_MIN_YIELD_PER_1000_QUOTA,
  buildNoveltyBaseline,
  classifyNativeCandidate,
  decideLifecycleV2,
  evaluateExternalTermEvidence,
  evaluateNativeTermPromotion,
  evaluateNativeTermPromotionV2,
  getPlannerTerminology,
  observeTerminologyDetailed,
  refreshTerminologyLifecycle,
} from './terminologyIntelligence';
import { admitNativeCandidates, extractVocabularyFromCreator } from './queryIntelligence';
import { computeObservationKey } from './countryNativeIntelligence';
import { capDemandSignalCandidates, planDiverseQueries, normalizeQuery } from './queryPlanner';
import {
  dedupeFreeQuerySignals,
  fetchFreeQuerySignals,
  parseWikidataSearchSignals,
  parseWikipediaSearchSignals,
  resetFreeQuerySignalCacheForTests,
  resolveWikimediaUserAgent,
  isContactBearingWikimediaUserAgent,
  WIKIMEDIA_USER_AGENT_ENV,
  WIKIMEDIA_USER_AGENT_FALLBACK,
} from './freeQuerySignals';
import {
  computeNativeVocabularyMetadataHash,
  computeNativeVocabularyRequestId,
  evaluateNativeVocabularyAiBudget,
} from './nativeVocabularyBudget';
import {
  evaluateCountryDiscoveryHealth,
  gatherCountryDiscoveryHealth,
  gatherCountryDiscoveryMetrics,
  type CountryDiscoveryHealthInput,
} from './countryDiscoveryHealth';
import { maybeRunDiscoveryEvidenceExtraction } from './discovery/evidencePipeline';
import { resolveNativeExtractionEligibility } from './ingestionPipeline';
import { isTerminologyKillSwitchActive } from './terminologyKillSwitch';

/** Explicit operator identity; Wikimedia policy forbids placeholder agents. */
const TEST_WIKIMEDIA_USER_AGENT = 'CountryDiscoveryLoop/1.0 (https://ops.example.org; ops@example.org)';

// ---------------------------------------------------------------------------
// Deterministic fixtures and source readers. The gate is intentionally
// database-free: pure policy functions, narrow fakes, and source contracts
// prove wiring without touching production or requiring a live PostgreSQL.
// ---------------------------------------------------------------------------

type RecordedCall = { text: string; params: unknown[] };
type FakeRunner = {
  calls: RecordedCall[];
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
};

function serverSource(name: string): string {
  return readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
}

function migration161(): string {
  return serverSource('db/migrations/161_country_discovery_loop.sql');
}

function healthySettings(): Record<string, string> {
  return {
    country_discovery_loop_enabled: 'true',
    autonomous_pagination_enabled: 'true',
    autonomous_pagination_v2_enabled: 'true',
    native_evidence_promotion_v2_enabled: 'true',
    native_vocabulary_extraction_enabled: 'true',
    free_query_signals_enabled: 'true',
    wikimedia_pageviews_enabled: 'false',
    query_demand_signals_enabled: 'false',
    youtube_key_daily_cap_enforced: 'true',
    native_vocabulary_ai_daily_cost_microunits: '5000000',
  };
}

function healthyHealthInput(overrides: Partial<CountryDiscoveryHealthInput> = {}): CountryDiscoveryHealthInput {
  return {
    migrationApplied: true,
    missingSchema: [],
    settings: healthySettings(),
    orphanPendingPages: 0,
    providerCanaryOk: true,
    aiActualCostMicrounits: 0,
    aiBudgetMicrounits: 5_000_000,
    ...overrides,
  };
}

const confirmedChannel = {
  country_status: 'CONFIRMED',
  trading_status: 'TRADING_CONFIRMED',
  quality_score: 80,
};

/** Narrow observe runner matching observeTerminologyDetailed's query shapes. */
function fakeObserveRunner(channel: Record<string, unknown>, termId = 7): FakeRunner {
  const calls: RecordedCall[] = [];
  return {
    calls,
    query: async (text: string, params: unknown[] = []) => {
      calls.push({ text, params });
      if (text.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (text.startsWith('SELECT id FROM canonical_trading_terms WHERE country')) return { rows: [] };
      if (text.startsWith('INSERT INTO canonical_trading_terms')) return { rows: [{ id: termId }] };
      if (text.startsWith('SELECT id FROM canonical_trading_terms WHERE id=$1 FOR UPDATE')) return { rows: [{ id: termId }] };
      if (text.includes('SELECT country_status, trading_status, quality_score FROM channels')) return { rows: [channel] };
      if (text.includes('SELECT country, country_status, trading_status, quality_score FROM channels')) return { rows: [channel] };
      if (text.includes('FROM terminology_observations') && text.includes('observation_key IS NULL')) return { rows: [] };
      if (text.includes('SELECT id FROM terminology_observations WHERE observation_key')) return { rows: [] };
      if (text.startsWith('INSERT INTO terminology_observations')) {
        return { rows: [{ id: 1, observed_at: new Date().toISOString(), inserted: true }] };
      }
      if (text.startsWith('SELECT t.*')) {
        return {
          rows: [{
            lifecycle_status: 'CANDIDATE', search_eligible: false, term_type: 'TERMINOLOGY',
            distinct_creators: 1, distinct_communities: 0, human_approved: 0,
            decayed_evidence: 1, executions: 0, decayed_yield: 0, trust_tier: 3,
          }],
        };
      }
      if (text.includes('FROM terminology_observations WHERE canonical_term_id=$1')) {
        return { rows: [{ v1: 0, spam: false, novel: false }] };
      }
      if (text.includes('FROM terminology_performance WHERE canonical_term_id=$1')) {
        return { rows: [{ executions: 0, quota: 0, confirmed: 0, nontrading: 0, wrong: 0, review: 0, fresh_confirmed: 0 }] };
      }
      if (text.startsWith('SELECT event_type, reason FROM')) return { rows: [] };
      return { rows: [] };
    },
  };
}

async function observeCase(
  channel: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
  termId = 7,
): Promise<{ result: { termId: number; observationInserted: boolean } | null; runner: FakeRunner; observation?: RecordedCall }> {
  const runner = fakeObserveRunner(channel, termId);
  const result = await observeTerminologyDetailed({
    term: 'Charttechnik',
    country: 'Germany',
    termType: 'TERMINOLOGY',
    observationType: 'VIDEO_TITLE',
    channelId: 'ch-1',
    videoId: 'vid-1',
    sourceCreatorCountry: 'Germany',
    language: 'de',
    locale: 'de-DE',
    promotionEligible: true,
    evidence: { qualityVersion: 'native-v1' },
    ...overrides,
  }, runner as never);
  return {
    result,
    runner,
    observation: runner.calls.find(call => call.text.startsWith('INSERT INTO terminology_observations')),
  };
}

/** Narrow refresh runner for v2 lifecycle reconciliation. */
function fakeRefreshRunner(
  rowOverrides: Record<string, unknown> = {},
  v2Overrides: Record<string, unknown> = {},
  perfOverrides: Record<string, unknown> = {},
  externalRows: Array<Record<string, unknown>> = [],
  qualityOverrides: Record<string, unknown> = {},
): FakeRunner {
  const calls: RecordedCall[] = [];
  return {
    calls,
    query: async (text: string, params: unknown[] = []) => {
      calls.push({ text, params });
      if (text.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (text.includes('SELECT setting_key, setting_value FROM app_settings')) {
        return {
          rows: [
            { setting_key: 'country_discovery_loop_enabled', setting_value: 'true' },
            { setting_key: 'native_evidence_promotion_v2_enabled', setting_value: 'true' },
          ],
        };
      }
      if (text.startsWith('SELECT t.*')) {
        return {
          rows: [{
            id: 1, lifecycle_status: 'SEARCH_TRIAL', search_eligible: true, term_type: 'TERMINOLOGY',
            country: 'Germany', language: 'de', trust_tier: 2, distinct_creators: 3,
            distinct_communities: 0, human_approved: 0, decayed_evidence: 6,
            executions: 0, decayed_yield: 0, ...rowOverrides,
          }],
        };
      }
      if (text.startsWith('UPDATE terminology_observations')) return { rows: [] };
      if (text.includes('native_creators') && text.includes('native_evidence_buckets')) {
        return {
          rows: [{
            native_creators: 0, native_evidence_buckets: 0, distinct_communities: 0,
            human_approved: 0, decayed_evidence: 0, ...v2Overrides,
          }],
        };
      }
      if (text.includes('normalized_alias')) return { rows: [] };
      if (text.includes('external_osint_observations')) return { rows: externalRows };
      if (text.includes('terminology_performance WHERE canonical_term_id')) {
        return { rows: [{ executions: 0, quota: 0, confirmed: 0, nontrading: 0, wrong: 0, review: 0, fresh_confirmed: 0, ...perfOverrides }] };
      }
      if (text.includes('FROM terminology_observations') && text.includes('qualityVersion')) {
        return { rows: [{ v1: 0, spam: false, novel: false, ...qualityOverrides }] };
      }
      if (text.includes('FROM terminology_observations') && text.includes('novel')) {
        return { rows: [{ v1: 0, spam: false, novel: false, ...qualityOverrides }] };
      }
      if (text.startsWith('UPDATE canonical_trading_terms')) return { rows: [] };
      if (text.startsWith('INSERT INTO terminology_lifecycle_events')) return { rows: [] };
      if (text.startsWith('INSERT INTO terminology_score_snapshots')) return { rows: [] };
      return { rows: [] };
    },
  };
}

const baseV2 = {
  pageNumber: 1,
  effectiveMaxPages: 50,
  ceilingBound: 'SAFETY' as const,
  hasNextPage: true,
  distinctCreators: 10,
  cumulativeDistinctCreators: 10,
  newCreators: 3,
  pageConfirmedCreators: 0,
  pageQualityCreators: 0,
  pageNonTradingCreators: 0,
  novelCandidateTerms: 0,
  countryPrecision: 0.8,
  communityDiversity: 0.3,
  duplicateRatio: 0.1,
  priorLowValueStreak: 0,
  priorDuplicateHeavyStreak: 0,
  priorWrongCountryStreak: 0,
  maxLowValuePages: 2,
  maxDuplicateHeavyPages: 2,
  maxWrongCountryPages: 2,
  explorationPagesRemaining: 0,
};

const lowValuePage = {
  ...baseV2,
  newCreators: 0,
  countryPrecision: 0.8,
  communityDiversity: 0.1,
  duplicateRatio: 0.2,
};

const baseLifecycle = {
  current: 'OBSERVED' as const,
  termType: 'TERMINOLOGY' as const,
  decayedEvidence: 4,
  nativeCreators: 3,
  nativeEvidenceBuckets: 3,
  externalSources: 0,
  externalSourceCount: 0,
  externalEligible: false,
  confirmedTradingCreators: 0,
  nonTradingCreators: 0,
  wrongCountryCreators: 0,
  needsReviewCreators: 0,
  executions: 0,
  decayedYield: 0,
  quotaConsumed: 0,
};

// ---------------------------------------------------------------------------
// A. Free signals and query generation (8)
// ---------------------------------------------------------------------------

test('A1: Wikipedia/Wikidata aliases stay scoped to the configured country and language', () => {
  const wiki = parseWikipediaSearchSignals({
    query: {
      search: [
        { title: 'DAX', pageid: 1 },
        { title: 'Börse Frankfurt', pageid: 2 },
        { title: 'Trading', pageid: 3 },
        { title: 'A sentence. With punctuation', pageid: 4 },
      ],
    },
  }, { country: 'Germany', language: 'de-DE' });
  assert.equal(wiki.length, 2);
  assert.deepEqual(wiki.map(signal => [signal.country, signal.language]), [['Germany', 'de'], ['Germany', 'de']]);
  assert.deepEqual(wiki.map(signal => signal.providerSignalId), ['wikipedia:1', 'wikipedia:2']);
  assert.ok(wiki.every(signal => signal.provider === 'WIKIPEDIA'));

  const wikidata = parseWikidataSearchSignals({
    search: [
      { id: 'Q1', label: 'Charttechnik', aliases: [{ value: 'Chartanalyse' }], description: 'German term' },
      { id: 'Q2', label: 'Trading', aliases: [] },
    ],
  }, { country: 'Germany', language: 'de' });
  assert.deepEqual(
    wikidata.map(signal => [signal.country, signal.language, signal.surface]),
    [['Germany', 'de', 'Charttechnik'], ['Germany', 'de', 'Chartanalyse']],
  );
  assert.ok([...wiki, ...wikidata].every(signal => signal.country === 'Germany'));
});

test('A2: repeated free-signal refresh is cache-idempotent and does not refetch', async () => {
  resetFreeQuerySignalCacheForTests();
  let requests = 0;
  const urls: string[] = [];
  const fakeFetch = (async (url: string) => {
    requests += 1;
    urls.push(String(url));
    if (String(url).includes('wikipedia.org')) {
      return { ok: true, json: async () => ({ query: { search: [{ title: 'DAX', pageid: 1 }] } }) } as never;
    }
    return { ok: true, json: async () => ({ search: [{ id: 'Q1', label: 'Charttechnik', aliases: [] }] }) } as never;
  }) as unknown as typeof fetch;
  const now = new Date('2026-10-26T00:00:00Z');
  try {
    const first = await fetchFreeQuerySignals({
      country: 'Germany', language: 'de', fetchImpl: fakeFetch, userAgent: TEST_WIKIMEDIA_USER_AGENT, now,
    });
    const second = await fetchFreeQuerySignals({
      country: 'Germany', language: 'de', fetchImpl: fakeFetch, userAgent: TEST_WIKIMEDIA_USER_AGENT,
      now: new Date(now.getTime() + 1_000),
    });
    assert.equal(requests, 2);
    assert.equal(second.fromCache, true);
    assert.deepEqual(second.signals, first.signals);
    assert.equal(dedupeFreeQuerySignals(first.signals).length, first.signals.length);

    // Localized text must carry both the selected language and the country;
    // English text must never be sent with a non-English language parameter.
    const wikiUrl = new URL(urls[0]);
    const wikidataUrl = new URL(urls[1]);
    assert.equal(wikiUrl.host, 'de.wikipedia.org');
    assert.equal(wikiUrl.searchParams.get('srsearch'), 'Germany Börse Handel');
    assert.equal(wikidataUrl.searchParams.get('search'), 'Germany Börse Handel');
    assert.equal(wikidataUrl.searchParams.get('language'), 'de');
    assert.equal(wikidataUrl.searchParams.get('uselang'), 'de');

    await fetchFreeQuerySignals({
      country: 'Austria', language: 'de', fetchImpl: fakeFetch, userAgent: TEST_WIKIMEDIA_USER_AGENT, now,
    });
    assert.notEqual(
      new URL(urls[2]).searchParams.get('srsearch'),
      wikiUrl.searchParams.get('srsearch'),
      'country-specific context prevents identical generic searches',
    );

    await fetchFreeQuerySignals({
      country: 'Germany', language: 'pt', fetchImpl: fakeFetch, userAgent: TEST_WIKIMEDIA_USER_AGENT, now,
    });
    const fallbackWiki = new URL(urls[4]);
    const fallbackWikidata = new URL(urls[5]);
    assert.equal(fallbackWiki.host, 'en.wikipedia.org');
    assert.equal(fallbackWiki.searchParams.get('srsearch'), 'Germany trading');
    assert.equal(fallbackWikidata.searchParams.get('language'), 'en', 'unlocalized fallback uses an English query');

    const source = serverSource('freeQuerySignals.ts');
    // The pacing slot is reserved synchronously before awaiting; concurrent
    // callers must queue instead of reading the same stale timestamp.
    assert.match(source, /const slotMs = Math\.max\(Date\.now\(\), nextRequestAtMs\)/);
    assert.match(source, /nextRequestAtMs = slotMs \+ MIN_INTERVAL_MS/);
    // Refresh an existing signal in place so it cannot stay stale for its
    // whole TTL; count only rows this call inserted.
    assert.match(source, /ON CONFLICT \(country, normalized_surface, signal_type, provider, \(COALESCE\(provider_signal_id, ''\)\)\)/);
    assert.match(source, /DO UPDATE SET[\s\S]*?fetched_at=EXCLUDED\.fetched_at/);
    assert.match(source, /RETURNING \(xmax = 0\) AS inserted/);
  } finally {
    resetFreeQuerySignalCacheForTests();
  }
});

test('A2b: free-signal cache is scoped by normalized limit', async () => {
  resetFreeQuerySignalCacheForTests();
  let requests = 0;
  const fakeFetch = (async (url: string) => {
    requests += 1;
    if (String(url).includes('wikipedia.org')) {
      return {
        ok: true,
        json: async () => ({
          query: {
            search: [
              { title: 'DAX', pageid: 1 },
              { title: 'Börse Frankfurt', pageid: 2 },
              { title: 'Charttechnik', pageid: 3 },
              { title: 'Risikomanagement', pageid: 4 },
            ],
          },
        }),
      } as never;
    }
    return {
      ok: true,
      json: async () => ({
        search: [
          { id: 'Q1', label: 'Handelsstrategie', aliases: [] },
          { id: 'Q2', label: 'Chartanalyse', aliases: [] },
          { id: 'Q3', label: 'DAX Futures', aliases: [] },
          { id: 'Q4', label: 'Börsenhandel', aliases: [] },
        ],
      }),
    } as never;
  }) as unknown as typeof fetch;
  const now = new Date('2026-10-26T00:00:00Z');
  try {
    const small = await fetchFreeQuerySignals({
      country: 'Germany', language: 'de', limit: 1,
      fetchImpl: fakeFetch, userAgent: TEST_WIKIMEDIA_USER_AGENT, now,
    });
    assert.equal(requests, 2);
    assert.equal(small.signals.length, 2, 'limit 1 returns one signal per provider');

    const large = await fetchFreeQuerySignals({
      country: 'Germany', language: 'de', limit: 8,
      fetchImpl: fakeFetch, userAgent: TEST_WIKIMEDIA_USER_AGENT, now,
    });
    assert.equal(requests, 4, 'a larger limit does not reuse the smaller-limit cache entry');
    assert.equal(large.signals.length, 8);

    const smallAgain = await fetchFreeQuerySignals({
      country: 'Germany', language: 'de', limit: 1,
      fetchImpl: fakeFetch, userAgent: TEST_WIKIMEDIA_USER_AGENT, now,
    });
    assert.equal(requests, 4, 'the smaller-limit entry remains independently cacheable');
    assert.equal(smallAgain.fromCache, true);
    assert.equal(smallAgain.signals.length, 2, 'the cached result is truncated to its own limit');
  } finally {
    resetFreeQuerySignalCacheForTests();
  }
});

test('A3: a native term plus a free alias yields one query with both sources attributed', () => {
  const freeSignals = ['Charttechnik', 'Börse Frankfurt', 'DAX Futures', 'Technische Analyse', 'Handelsstrategie', 'Risikomanagement']
    .map((surface, index) => ({
      surface,
      signalType: 'METHOD' as const,
      country: 'Germany',
      language: 'de',
      provider: 'WIKIPEDIA' as const,
      sourceIds: [`wikipedia:${index}`],
    }));
  const planned = planDiverseQueries({
    country: 'Germany',
    count: 6,
    learnedVocabulary: [],
    existingQueries: [],
    provenTerminology: [{ id: 1, term: 'Charttechnik', score: 0.9, lifecycle: 'SEARCH_TRIAL' }],
    freeSignalCandidates: freeSignals,
  });
  const combined = planned.find(query => query.query === 'DAX Analyse Charttechnik');
  assert.ok(combined, 'combined native/free query exists');
  assert.equal(combined.metadata.source, 'MIXED');
  assert.deepEqual(combined.metadata.sourceTypes, ['SEED', 'FREE_SIGNAL', 'TERMINOLOGY']);
  assert.equal(combined.metadata.terminologyId, 1);
  assert.deepEqual(combined.metadata.freeSignalIds, ['wikipedia:0']);
  assert.equal(combined.metadata.language, 'de');
  assert.ok(planned.every(query => query.metadata.country === 'Germany'));
});

test('A4: normalized duplicate queries upsert one country-scoped query_library row', () => {
  assert.equal(normalizeQuery('DAX  Analyse'), normalizeQuery('dax analyse'));
  const dbCore = serverSource('dbCore.ts');
  assert.match(dbCore, /ON CONFLICT\(country,normalized_query\) DO UPDATE SET/);
  assert.match(dbCore, /generation_metadata=excluded\.generation_metadata/);
  assert.match(dbCore, /primary_term=excluded\.primary_term/);
  const migration = serverSource('db/migrations/008_country_scoped_query_uniqueness.sql');
  assert.match(migration, /UNIQUE\(country, normalized_query\)/);
});

test('A5: the free-signal cap preserves creator-observed terminology', () => {
  const freeSignals = ['Charttechnik', 'Börse Frankfurt', 'DAX Futures', 'Technische Analyse', 'Handelsstrategie', 'Risikomanagement']
    .map((surface, index) => ({
      surface,
      signalType: 'METHOD' as const,
      country: 'Germany',
      language: 'de',
      provider: 'WIKIPEDIA' as const,
      sourceIds: [`wikipedia:${index}`],
    }));
  const planned = planDiverseQueries({
    country: 'Germany',
    count: 6,
    learnedVocabulary: [],
    existingQueries: [],
    provenTerminology: [{ id: 1, term: 'Charttechnik', score: 0.9, lifecycle: 'SEARCH_TRIAL' }],
    freeSignalCandidates: freeSignals,
  });
  const sourceTypes = (query: typeof planned[number]) => query.metadata.sourceTypes as string[];
  const freeSignalQueries = planned.filter(query => sourceTypes(query).includes('FREE_SIGNAL'));
  assert.equal(freeSignalQueries.length, 2, 'at most one third of six slots are free-signal candidates');
  assert.equal(planned.filter(query => sourceTypes(query).includes('TERMINOLOGY')).length, 1, 'creator-observed terminology keeps its slot');
  const freeSource = serverSource('freeQuerySignals.ts');
  assert.ok(!freeSource.includes('terminology_observations'));
  assert.ok(!/promotion_eligible\s*=/.test(freeSource), 'free signals never assign promotion eligibility');
});

test('A5b: a full portfolio cannot push creator-derived candidates out with free signals', () => {
  const freeSignals = ['Charttechnik', 'Börse Frankfurt', 'DAX Futures', 'Technische Analyse', 'Handelsstrategie', 'Risikomanagement']
    .map((surface, index) => ({
      surface,
      signalType: 'METHOD' as const,
      country: 'Germany',
      language: 'de',
      provider: 'WIKIPEDIA' as const,
      sourceIds: [`wikipedia:${index}`],
    }));
  const creatorTerms = ['Charttechnik', 'Handelsstrategie', 'Risikomanagement'].map((term, index) => ({
    id: index + 1, term, score: 0.9, lifecycle: 'SEARCH_TRIAL' as const,
  }));
  const planned = planDiverseQueries({
    country: 'Germany',
    count: 3,
    learnedVocabulary: [],
    existingQueries: [],
    provenTerminology: creatorTerms,
    freeSignalCandidates: freeSignals,
  });
  const sourceTypes = (query: typeof planned[number]) => query.metadata.sourceTypes as string[];
  assert.equal(planned.filter(query => sourceTypes(query).includes('TERMINOLOGY')).length, 3,
    'every requested slot is available to creator-derived terminology');
  assert.equal(planned.filter(query => sourceTypes(query).includes('FREE_SIGNAL')).length, 0,
    'free signals do not displace creator-derived candidates');
});

test('A6: provider rate-limit failure degrades to seeds without failing the cycle', async () => {
  resetFreeQuerySignalCacheForTests();
  const failingFetch = (async () => { throw new Error('HTTP_429'); }) as unknown as typeof fetch;
  const previousUserAgent = process.env[WIKIMEDIA_USER_AGENT_ENV];
  try {
    const result = await fetchFreeQuerySignals({
      country: 'Germany',
      language: 'de',
      fetchImpl: failingFetch,
      userAgent: TEST_WIKIMEDIA_USER_AGENT,
      now: new Date('2026-10-26T00:00:00Z'),
    });
    assert.equal(result.degraded, true);
    assert.equal(result.signals.length, 0);
    assert.match(String(result.error), /WIKIPEDIA:HTTP_429/);
    assert.match(String(result.error), /WIKIDATA:HTTP_429/);

    // A fully degraded fetch must not be cached for 24h: the next cycle must
    // retry both providers and recover without a restart.
    let recoveryRequests = 0;
    const recoveringFetch = (async () => {
      recoveryRequests += 1;
      return {
        ok: true,
        json: async () => ({ query: { search: [] }, search: [] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const recovered = await fetchFreeQuerySignals({
      country: 'Germany',
      language: 'de',
      fetchImpl: recoveringFetch,
      userAgent: TEST_WIKIMEDIA_USER_AGENT,
      now: new Date('2026-10-26T00:00:01Z'),
    });
    assert.equal(recoveryRequests, 2, 'both providers are retried after a degraded fetch');
    assert.equal(recovered.degraded, false);
    assert.notEqual(recovered.fromCache, true);

    // A partial failure with an empty result must not be cached either: the
    // failed provider can recover on the next cycle, and the successful one
    // may simply have had no matches this time.
    resetFreeQuerySignalCacheForTests();
    let partialRequests = 0;
    const partialFetch = (async (url: string) => {
      partialRequests += 1;
      if (String(url).includes('wikipedia.org')) throw new Error('HTTP_500');
      return { ok: true, json: async () => ({ search: [] }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const partial = await fetchFreeQuerySignals({
      country: 'Germany',
      language: 'de',
      fetchImpl: partialFetch,
      userAgent: TEST_WIKIMEDIA_USER_AGENT,
      now: new Date('2026-10-26T00:00:01Z'),
    });
    assert.equal(partial.degraded, false);
    assert.equal(partial.signals.length, 0);
    assert.equal(partialRequests, 2);

    let retryRequests = 0;
    const retryFetch = (async (url: string) => {
      retryRequests += 1;
      if (String(url).includes('wikipedia.org')) {
        return { ok: true, json: async () => ({ query: { search: [{ title: 'DAX', pageid: 1 }] } }) } as unknown as Response;
      }
      return { ok: true, json: async () => ({ search: [{ id: 'Q1', label: 'Charttechnik', aliases: [] }] }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const retried = await fetchFreeQuerySignals({
      country: 'Germany',
      language: 'de',
      fetchImpl: retryFetch,
      userAgent: TEST_WIKIMEDIA_USER_AGENT,
      now: new Date('2026-10-26T00:00:02Z'),
    });
    assert.equal(retryRequests, 2, 'a partial failure with an empty result is retried');
    assert.ok(retried.signals.length > 0);
    assert.match(
      serverSource('freeQuerySignals.ts'),
      /deduped\.length > 0 \|\| errors\.length === 0/,
    );

    // Wikimedia policy requires a real contact/URL. The fallback names the
    // missing deployment prerequisite rather than embedding a fake address.
    assert.ok(!WIKIMEDIA_USER_AGENT_FALLBACK.includes('example.invalid'));
    assert.match(WIKIMEDIA_USER_AGENT_FALLBACK, /WIKIMEDIA_USER_AGENT/);
    assert.equal(
      resolveWikimediaUserAgent(TEST_WIKIMEDIA_USER_AGENT),
      TEST_WIKIMEDIA_USER_AGENT,
    );
    assert.equal(isContactBearingWikimediaUserAgent(TEST_WIKIMEDIA_USER_AGENT), true);
    assert.equal(isContactBearingWikimediaUserAgent('ops@example.org'), true);
    assert.equal(isContactBearingWikimediaUserAgent('WIKIMEDIA_USER_AGENT'), false);
    assert.equal(isContactBearingWikimediaUserAgent('CountryDiscoveryLoop/1.0'), false);
    assert.equal(isContactBearingWikimediaUserAgent('https://example.invalid/contact'), false);
    assert.equal(resolveWikimediaUserAgent('WIKIMEDIA_USER_AGENT'), WIKIMEDIA_USER_AGENT_FALLBACK);

    // With no operator-configured identity, remote fetches are skipped
    // entirely: a placeholder UA would violate the Wikimedia policy.
    resetFreeQuerySignalCacheForTests();
    delete process.env[WIKIMEDIA_USER_AGENT_ENV];
    let skippedRequests = 0;
    const trackingFetch = (async () => {
      skippedRequests += 1;
      return { ok: true, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const skipped = await fetchFreeQuerySignals({
      country: 'Germany',
      language: 'de',
      fetchImpl: trackingFetch,
      now: new Date('2026-10-26T00:00:02Z'),
    });
    assert.equal(skippedRequests, 0, 'no remote call without WIKIMEDIA_USER_AGENT');
    assert.equal(skipped.degraded, true);
    assert.equal(skipped.signals.length, 0);
    assert.match(String(skipped.error), /WIKIMEDIA_USER_AGENT/);
  } finally {
    if (previousUserAgent === undefined) delete process.env[WIKIMEDIA_USER_AGENT_ENV];
    else process.env[WIKIMEDIA_USER_AGENT_ENV] = previousUserAgent;
    resetFreeQuerySignalCacheForTests();
  }
  const planned = planDiverseQueries({
    country: 'Germany',
    count: 4,
    learnedVocabulary: [],
    existingQueries: [],
    provenTerminology: [{ id: 1, term: 'Charttechnik', score: 0.9, lifecycle: 'SEARCH_TRIAL' }],
    freeSignalCandidates: [],
  });
  assert.ok(planned.length > 0);
  assert.ok(planned.some(query => (query.metadata.sourceTypes as string[]).includes('TERMINOLOGY')));
});

test('A7: a free alias never writes terminology evidence or promotion eligibility', () => {
  const planned = planDiverseQueries({
    country: 'Germany',
    count: 3,
    learnedVocabulary: [],
    existingQueries: [],
    freeSignalCandidates: [{
      surface: 'Charttechnik', signalType: 'METHOD', country: 'Germany', language: 'de',
      provider: 'WIKIPEDIA', sourceIds: ['wikipedia:0'],
    }],
  });
  const free = planned.find(query => (query.metadata.sourceTypes as string[]).includes('FREE_SIGNAL'));
  assert.ok(free);
  assert.ok(!(free.metadata.sourceTypes as string[]).includes('TERMINOLOGY'));
  assert.match(String(free.metadata.selectionEvidence), /candidate vocabulary only, never evidence/);
  const freeSource = serverSource('freeQuerySignals.ts');
  assert.ok(!freeSource.includes('observeTerminologyDetailed'));
  assert.ok(!freeSource.includes('canonical_trading_terms'));
});

test('A8: thin Wikipedia coverage invents no alias and still plans seeds', () => {
  const signals = parseWikipediaSearchSignals({ query: { search: [] } }, { country: 'Germany', language: 'de' });
  assert.deepEqual(signals, []);
  const planned = planDiverseQueries({
    country: 'Germany',
    count: 4,
    learnedVocabulary: [],
    existingQueries: [],
    provenTerminology: [{ id: 1, term: 'Charttechnik', score: 0.9, lifecycle: 'SEARCH_TRIAL' }],
    freeSignalCandidates: [],
  });
  assert.ok(planned.length > 0);
  assert.ok(planned.some(query => (query.metadata.sourceTypes as string[]).includes('TERMINOLOGY')));
  assert.ok(planned.every(query => !(query.metadata.sourceTypes as string[]).includes('FREE_SIGNAL')));
});

// ---------------------------------------------------------------------------
// P. Pagination continuation and resumption (17)
// ---------------------------------------------------------------------------

test('P1: a page with new creators continues even with zero confirmed traders', () => {
  const decision = evaluateContinuationV2(baseV2);
  assert.equal(decision.shouldContinue, true);
  assert.equal(decision.productive, true);
  assert.equal(decision.lowValue, false);
  assert.equal(decision.primaryReason, 'CONTINUE_PRODUCTIVE');
  assert.ok(decision.marginalUtility < 0.2, 'utility alone is ranking input, not a stop');
});

test('P2: one grace page, restart-safe streak reconstruction, reset by a productive page, then stop after two lows', () => {
  const page1 = evaluateContinuationV2(lowValuePage);
  assert.equal(page1.shouldContinue, true);
  assert.equal(page1.primaryReason, 'CONTINUE_GRACE');
  assert.equal(page1.streaks.lowValue, 1);

  // Worker restart: only the persisted page row is available.
  const restored = countTrailingContinuationStreaks([{
    marginalUtility: page1.marginalUtility,
    reasonCodes: page1.reasonCodes,
  }]);
  assert.equal(restored.lowValue, 1);

  const page2 = evaluateContinuationV2({
    ...baseV2,
    pageNumber: 2,
    cumulativeDistinctCreators: 12,
    priorLowValueStreak: restored.lowValue,
  });
  assert.equal(page2.primaryReason, 'CONTINUE_PRODUCTIVE');
  assert.equal(page2.streaks.lowValue, 0, 'productive page resets the streak');

  const page3 = evaluateContinuationV2({ ...lowValuePage, pageNumber: 3, priorLowValueStreak: 0 });
  assert.equal(page3.primaryReason, 'CONTINUE_GRACE');
  const page4 = evaluateContinuationV2({ ...lowValuePage, pageNumber: 4, priorLowValueStreak: 1 });
  assert.equal(page4.shouldContinue, false);
  assert.equal(page4.primaryReason, 'MARGINAL_VALUE_LOW');
  assert.ok(page4.reasonCodes.includes('CONSECUTIVE_LOW_YIELD'));
});

test('P2b: pre-v2 legacy rows never invent v2 streaks', () => {
  const legacy = {
    marginalUtility: 0,
    reasonCodes: ['DUPLICATE_HEAVY', 'WRONG_COUNTRY', 'ZERO_CONFIRMED_VALUE'],
    continuationDecisionV2: {},
  };
  assert.deepEqual(countTrailingContinuationStreaks([legacy]), {
    lowValue: 0, duplicateHeavy: 0, wrongCountry: 0,
  });

  const newestV2 = evaluateContinuationV2(lowValuePage);
  const mixed = countTrailingContinuationStreaks([
    { marginalUtility: newestV2.marginalUtility, reasonCodes: newestV2.reasonCodes, continuationDecisionV2: newestV2 },
    { marginalUtility: 0.4, reasonCodes: ['CONTINUE_PRODUCTIVE'], continuationDecisionV2: {} },
  ]);
  assert.deepEqual(mixed, { lowValue: 1, duplicateHeavy: 0, wrongCountry: 0 },
    'reconstruction stops at the first legacy page');
});

test('P3: duplicate-heavy ratio alone does not stop a page with new creators', () => {
  const decision = evaluateContinuationV2({ ...baseV2, duplicateRatio: 0.92, newCreators: 2 });
  assert.equal(decision.shouldContinue, true);
  assert.equal(decision.productive, true);
  assert.equal(decision.duplicateHeavy, false);
  assert.equal(decision.primaryReason, 'CONTINUE_PRODUCTIVE');
});

test('P4: two consecutive duplicate-heavy pages without any productive signal stop DUPLICATE_HEAVY', () => {
  const first = evaluateContinuationV2({
    ...baseV2, duplicateRatio: 0.95, newCreators: 0, countryPrecision: 0.9,
  });
  assert.equal(first.shouldContinue, true);
  assert.equal(first.primaryReason, 'CONTINUE_GRACE');
  assert.equal(first.streaks.duplicateHeavy, 1);

  const second = evaluateContinuationV2({
    ...baseV2, duplicateRatio: 0.95, newCreators: 0, countryPrecision: 0.9,
    priorDuplicateHeavyStreak: 1, priorLowValueStreak: 1,
  });
  assert.equal(second.shouldContinue, false);
  assert.equal(second.primaryReason, 'DUPLICATE_HEAVY', 'specific stop wins over generic low value');
  assert.equal(second.streaks.duplicateHeavy, 2);
});

test('P5: a low-precision page with a confirmed creator continues; two consecutive wrong-country pages stop', () => {
  const first = evaluateContinuationV2({
    ...baseV2, countryPrecision: 0.4, pageConfirmedCreators: 1,
  });
  assert.equal(first.shouldContinue, true);
  assert.equal(first.wrongCountry, false);
  assert.equal(first.primaryReason, 'CONTINUE_PRODUCTIVE');

  const second = evaluateContinuationV2({ ...baseV2, countryPrecision: 0.4, newCreators: 0 });
  assert.equal(second.shouldContinue, true);
  assert.equal(second.primaryReason, 'CONTINUE_GRACE');
  assert.equal(second.streaks.wrongCountry, 1);

  const third = evaluateContinuationV2({
    ...baseV2, countryPrecision: 0.4, newCreators: 0,
    priorWrongCountryStreak: 1, priorLowValueStreak: 1,
  });
  assert.equal(third.shouldContinue, false);
  assert.equal(third.primaryReason, 'WRONG_COUNTRY');
  assert.equal(third.streaks.wrongCountry, 2);

  // A low-precision page that still surfaced a new creator is productive, not
  // wrong-country: the wrong-country streak requires no productive signal.
  const productiveLowPrecision = evaluateContinuationV2({
    ...baseV2, countryPrecision: 0.4, newCreators: 1,
  });
  assert.equal(productiveLowPrecision.wrongCountry, false);
  assert.equal(productiveLowPrecision.streaks.wrongCountry, 0);
});

test('P6: a low-utility page with one new creator continues via the productive floor', () => {
  const decision = evaluateContinuationV2({
    ...baseV2, distinctCreators: 20, newCreators: 1, countryPrecision: 0.8,
    communityDiversity: 0.1, duplicateRatio: 0,
  });
  assert.ok(decision.marginalUtility < 0.2);
  assert.equal(decision.shouldContinue, true);
  assert.equal(decision.productive, true);
  assert.equal(decision.primaryReason, 'CONTINUE_PRODUCTIVE');
});

test('P7: two low-utility pages with no productive signal stop MARGINAL_VALUE_LOW', () => {
  const low = { ...baseV2, newCreators: 0, countryPrecision: 0.8, communityDiversity: 0.1 };
  const first = evaluateContinuationV2(low);
  assert.ok(first.marginalUtility < 0.2);
  assert.equal(first.shouldContinue, true);
  assert.equal(first.primaryReason, 'CONTINUE_GRACE');

  const second = evaluateContinuationV2({ ...low, priorLowValueStreak: 1 });
  assert.equal(second.shouldContinue, false);
  assert.equal(second.primaryReason, 'MARGINAL_VALUE_LOW');
  assert.ok(second.reasonCodes.includes('CONSECUTIVE_LOW_YIELD'));
});

test('P8: a 300-unit run budget allows at most three 100-unit pages', () => {
  const budget = computeEffectivePageBudget({
    safetyMaxPages: 50,
    providerMaxPages: 10,
    pageCostUnits: 100,
    remainingAutonomousQuota: 300,
    pendingCountries: 1,
  });
  assert.equal(budget.runQuotaBudgetUnits, 300);
  assert.equal(budget.effectiveMaxPages, 3);
  assert.equal(budget.bindingBound, 'RUN_BUDGET');
  assert.ok(budget.effectiveMaxPages * 100 <= 300, 'no overspend');
  const stop = evaluateContinuationV2({
    ...baseV2, pageNumber: 3, effectiveMaxPages: budget.effectiveMaxPages, ceilingBound: 'RUN_BUDGET',
  });
  assert.equal(stop.shouldContinue, false);
  assert.equal(stop.primaryReason, 'RUN_BUDGET_EXHAUSTED');

  // An independent treatment/trial cap or the quota-derived budget still wins;
  // there is no per-run page floor that could renew a capped reservation.
  const treatmentBound = computeEffectivePageBudget({
    safetyMaxPages: 50, providerMaxPages: 10, pageCostUnits: 100,
    remainingAutonomousQuota: 1000, pendingCountries: 1,
    treatmentCapPages: 2,
  });
  assert.equal(treatmentBound.effectiveMaxPages, 2);
  assert.equal(treatmentBound.bindingBound, 'TREATMENT');

  const trialBound = computeEffectivePageBudget({
    safetyMaxPages: 50, providerMaxPages: 10, pageCostUnits: 100,
    remainingAutonomousQuota: 1000, pendingCountries: 1,
    trialContinuationCap: 1,
  });
  assert.equal(trialBound.effectiveMaxPages, 1);
  assert.equal(trialBound.bindingBound, 'TRIAL');

  const quotaBound = computeEffectivePageBudget({
    safetyMaxPages: 50, providerMaxPages: 10, pageCostUnits: 100,
    remainingAutonomousQuota: 250, pendingCountries: 1,
  });
  assert.equal(quotaBound.effectiveMaxPages, 2);
  assert.equal(quotaBound.bindingBound, 'RUN_BUDGET');
  assert.ok(quotaBound.effectiveMaxPages * 100 <= 250, 'the run cannot overspend quota');

  // The run's scheduled page reservation is already subtracted from
  // remainingAutonomousQuota. Add the current page back so page one is not
  // charged twice when deriving the continuation budget.
  assert.match(
    serverSource('queueManager.ts'),
    /remainingAutonomousQuota: quotaAvailability\.remainingAutonomousQuota \+ pageCostUnits/,
  );
});

test('P8b: equal treatment/trial caps win ties so segmentation cannot renew them', () => {
  const safetyTie = computeEffectivePageBudget({
    safetyMaxPages: 2, providerMaxPages: 10, pageCostUnits: 100,
    remainingAutonomousQuota: 1000, pendingCountries: 1, treatmentCapPages: 2,
  });
  assert.equal(safetyTie.effectiveMaxPages, 2);
  assert.equal(safetyTie.bindingBound, 'TREATMENT');

  const trialTie = computeEffectivePageBudget({
    safetyMaxPages: 2, providerMaxPages: 10, pageCostUnits: 100,
    remainingAutonomousQuota: 1000, pendingCountries: 1, trialContinuationCap: 2,
  });
  assert.equal(trialTie.effectiveMaxPages, 2);
  assert.equal(trialTie.bindingBound, 'TRIAL');

  const allTie = computeEffectivePageBudget({
    safetyMaxPages: 2, providerMaxPages: 10, pageCostUnits: 100,
    remainingAutonomousQuota: 1000, pendingCountries: 1,
    treatmentCapPages: 2, trialContinuationCap: 2,
  });
  assert.equal(allTie.effectiveMaxPages, 2);
  assert.equal(allTie.bindingBound, 'TRIAL', 'the most specific allocation cap wins');
});

test('P9: quota denial defers a productive page without dropping or stopping the run', () => {
  const decision = evaluateContinuationV2({ ...baseV2, nextPageQuotaAdmitted: false });
  assert.equal(decision.shouldContinue, true);
  assert.equal(decision.defer, true);
  assert.equal(decision.deferReason, 'QUOTA');
  assert.equal(decision.primaryReason, 'QUOTA_DEFERRED');
  const queue = serverSource('queueManager.ts');
  assert.match(queue, /deferAutonomousRunForQuota\(queryRunId/);
  assert.match(queue, /markQueryRunDeferred\(runId, 'DEFERRED_QUOTA'/);
  const pendingStore = serverSource('autonomousPageStore.ts');
  assert.match(pendingStore, /continuation_status IN \('RUNNING','DEFERRED_QUOTA','DEFERRED_TIME'\)/);
  assert.match(pendingStore, /qr\.deferred_until IS NULL OR qr\.deferred_until <= now\(\)/);
});

test('P10: the reconciler enqueues exactly one idempotent child for a missing next page', () => {
  const queue = serverSource('queueManager.ts');
  // Page 1 recovers under either scheduling key; later pages use :page:N.
  assert.match(queue, /const idempotencyKey = firstPage\s*\? \(run\.nextPageToken \? `search-run:\$\{run\.runId\}:page:1` : `search-run:\$\{run\.runId\}`\)\s*: `search-run:\$\{run\.runId\}:page:\$\{nextPage\}`/);
  // Only live work blocks recovery. COMPLETED/FAILED jobs without a page
  // observation must fall through and be reopened by enqueueJob.
  assert.match(queue, /SELECT 1 FROM jobs WHERE idempotency_key = ANY\(\$1\) AND status IN \('PENDING','PROCESSING'\)/);
  assert.match(queue, /const liveKeys = firstPage\s*\? \[`search-run:\$\{run\.runId\}`, `search-run:\$\{run\.runId\}:page:1`\]\s*: \[idempotencyKey\]/);
  assert.match(queue, /pg_try_advisory_lock\(hashtext\(\$1\)\)/);
  assert.match(queue, /if \(existingJob\.rowCount\) \{[\s\S]*?skipped\+\+;[\s\S]*?continue;/);
  // A fresh page 1 is recoverable without a persisted resume mode.
  assert.match(queue, /if \(!firstPage && run\.resumeMode === 'NONE'\) \{/);
  // Recovery must apply the same treatment-page reservation as the worker and
  // reopen terminal jobs so a deferred page is never lost.
  assert.match(queue, /if \(!firstPage && run\.retrievalTreatmentOrigin === 'CANARY_TREATMENT'\) \{[\s\S]*?reserveIncrementalTreatmentPageQuota\(/);
  assert.match(queue, /enqueueChildAndCommitPageReservation\(\{[\s\S]*?pageReservationId: incPageReservationId/);
  assert.match(queue, /reopenTerminal: true/);
  assert.match(queue, /priority: AUTONOMOUS_CONTINUATION_JOB_PRIORITY/);
  assert.match(queue, /enqueued\+\+;/);
  // Report §6.7: the reconciler must never resume a run whose country is no
  // longer in the active autonomous scope, even with a valid cursor.
  assert.match(queue, /const activeCountryKeys = await resolveActiveAutonomousCountryKeys\(\)/);
  assert.match(queue, /const countryKey = autonomousCountryKey\(run\.country\)/);
  assert.match(queue, /if \(!activeCountryKeys\.has\(countryKey\)\) \{[\s\S]*?markQueryRunResumeUnavailable\(run\.runId, 'COUNTRY_INACTIVE'\)[\s\S]*?unavailable\+\+;[\s\S]*?continue;/);
  assert.match(queue, /resolveAutonomousCountries\(\s*vocabs\.map\(vocab => vocab\.country\),\s*excluded\.map\(item => item\.country_name\),\s*scope\.selectedCountries,\s*scope\.scope,\s*\)/);
  // Orphan resumption preserves the run's original treatment depth; using the
  // run-local page number would shrink a CANARY_TREATMENT cap mid-run.
  assert.match(queue, /requestedPageDepth: run\.requestedPageDepth \?\? nextPage/);
  assert.match(queue, /const metadata = run\.runMetadata \|\| \{\}/);
  assert.match(queue, /\.\.\.\(trial \? \{ trial \} : \{\}\)/);
  assert.match(queue, /\.\.\.\(selectionExperiment \? \{ selectionExperiment \} : \{\}\)/);
  assert.match(queue, /\.\.\.\(searchWindow \? \{ searchWindow \} : \{\}\)/);
  assert.match(serverSource('autonomousPageStore.ts'), /qr\.requested_page_depth/);
  assert.match(serverSource('autonomousPageStore.ts'), /qr\.metadata/);
  // Return a ranked fallback list per country and let the caller rotate over
  // the full country set. A global LIMIT here would permanently exclude
  // alphabetically later countries when pending countries exceed the limit.
  const pageStore = serverSource('autonomousPageStore.ts');
  assert.match(pageStore, /ROW_NUMBER\(\) OVER \(\s*PARTITION BY LOWER\(candidates\.country\)/);
  assert.match(pageStore, /WHERE country_rank <= \$1\s+ORDER BY LOWER\(country\) ASC,\s*country_rank ASC/);
  assert.ok(!/SELECT \* FROM ranked[\s\S]{0,400}?LIMIT \$1/.test(pageStore), 'no global LIMIT before fairness rotation');
  assert.match(queue, /listPendingAutonomousRuns\(\)/);
  assert.match(queue, /planContinuationResume\([\s\S]*?AUTONOMOUS_CONTINUATION_CANDIDATES_PER_COUNTRY/);
  assert.match(serverSource('dbCore.ts'), /requested_page_depth/);
  assert.match(serverSource('dbCore.ts'), /jsonb_set\(metadata,'\{searchWindow\}'/);
  assert.match(migration161(), /ADD COLUMN IF NOT EXISTS requested_page_depth INTEGER/);
});

test('P10b: the continuation sweep rotates across every pending country', () => {
  const countries = ['Austria', 'Belgium', 'Chile', 'Denmark', 'Egypt', 'Finland'];
  const runs = countries.map(country => ({ country, runId: `${country}-0`, marginalUtility: 0.5 }));
  const covered: string[] = [];
  let cursor = 0;
  for (let sweep = 0; sweep < 3; sweep++) {
    const plan = planContinuationResume(runs, cursor, countries.length, 2);
    assert.equal(plan.selected.length, 2);
    assert.equal(plan.selected.length + plan.deferred.length, runs.length, 'no run is dropped');
    covered.push(...plan.selected.map(run => run.country));
    cursor = plan.nextFairnessCursor;
  }
  // Three two-country sweeps cover all six countries instead of revisiting
  // the alphabetically first two.
  assert.deepEqual(covered, countries);
  assert.equal(cursor, 0);
});

test('P10c: a blocked country candidate falls back to the next ranked run', () => {
  const runs = [
    { country: 'Germany', runId: 'g-best', marginalUtility: 0.9 },
    { country: 'Germany', runId: 'g-fallback', marginalUtility: 0.5 },
    { country: 'France', runId: 'f-best', marginalUtility: 0.7 },
  ];
  const plan = planContinuationResume(runs, 0, 2, 2, 2);
  assert.deepEqual(plan.selected.map(run => run.runId), ['f-best', 'g-best', 'g-fallback']);
  // If g-best cannot obtain its treatment reservation, the reconciler can try
  // g-fallback in the same sweep; after one success the loop skips the rest
  // of Germany via countriesThisSweep.
  assert.equal(plan.selected.filter(run => run.country === 'Germany').length, 2);
  assert.equal(plan.selected.length + plan.deferred.length, runs.length);
});

test('P10d: the plan ranks by the same resume age as the SQL shortlist', () => {
  // SQL orders a country by COALESCE(last_page_at, started_at, scheduled_at).
  // The reconciler must use the same anchor: a run with no lastPageAt but an
  // older start must rank ahead of a newer last-page run, or a truncated
  // shortlist can retain the run the SQL ranking would omit.
  const runs = [
    { country: 'Germany', runId: 'g-never-paged', marginalUtility: 0.5, lastPageAt: null, resumeAt: '2026-10-01T00:00:00Z' },
    { country: 'Germany', runId: 'g-recent', marginalUtility: 0.5, lastPageAt: '2026-10-02T00:00:00Z', resumeAt: '2026-10-02T00:00:00Z' },
  ];
  const plan = planContinuationResume(runs, 0, 1, 1, 2);
  assert.deepEqual(plan.selected.map(run => run.runId), ['g-never-paged', 'g-recent']);
  const pageStore = serverSource('autonomousPageStore.ts');
  assert.match(pageStore, /COALESCE\(qr\.last_page_at, qr\.started_at, qr\.scheduled_at\) AS resume_at/);
  assert.match(pageStore, /resumeAt: row\.resume_at \? new Date\(row\.resume_at as string\)\.toISOString\(\) : null/);
  assert.match(serverSource('queueManager.ts'), /const anchor = run\.resumeAt \?\? run\.lastPageAt/);
});

test('P10e: a treatment-cap denial is deferred, not retried every sweep', () => {
  const queue = serverSource('queueManager.ts');
  const reconcilerTreatmentAt = queue.indexOf("run.retrievalTreatmentOrigin === 'CANARY_TREATMENT'");
  assert.ok(reconcilerTreatmentAt > 0);
  const denialAt = queue.indexOf('if (!incRes.authorized)', reconcilerTreatmentAt);
  assert.ok(denialAt > reconcilerTreatmentAt);
  const denialBlock = queue.slice(denialAt, queue.indexOf('incPageReservationId = incRes.pageReservationId', denialAt));
  // Daily caps cannot clear before the quota day resets; transient errors get
  // a short bounded backoff. Either way the run is deferred rather than left
  // RUNNING with no job, which would retry every sweep and look orphaned.
  assert.match(denialBlock, /CAP_EXCEEDED\|QUOTA_EXHAUSTED/);
  assert.match(denialBlock, /deferAutonomousRunForQuota\(run\.runId/);
  assert.match(denialBlock, /deferAutonomousRunForTime\(run\.runId/);
});

test('P10f: orphan health ignores runs with a live page job', () => {
  // The reconciler already treats PENDING/PROCESSING page jobs as non-orphans.
  // The health query must use the same exclusion, otherwise queue backlog
  // older than 15 minutes fails orphan_pending_pages and returns 503.
  const health = serverSource('countryDiscoveryHealth.ts');
  const orphanQueryStart = health.indexOf('SELECT COUNT(*)::int AS count,');
  const orphanQueryEnd = health.indexOf('`,', orphanQueryStart);
  assert.ok(orphanQueryStart > 0 && orphanQueryEnd > orphanQueryStart);
  const orphanQuery = health.slice(orphanQueryStart, orphanQueryEnd);
  assert.match(orphanQuery, /NOT EXISTS \(\s*SELECT 1 FROM jobs j/);
  assert.match(orphanQuery, /j\.status IN \('PENDING','PROCESSING'\)/);
  assert.match(orphanQuery, /search-run:'\|\|query_runs\.id/);
});

test('P11: official YouTube resume uses the durable next-page token without a rewalk', () => {
  assert.equal(resumeModeForProvider('youtube-search'), 'TOKEN');
  const queue = serverSource('queueManager.ts');
  assert.match(queue, /const pageToken = run\.resumeMode === 'REWALK'\s*\? \(run\.nextPageToken \|\| String\(nextPage\)\)\s*: run\.nextPageToken/);
  assert.match(queue, /resumeRewalkCount: \(progress\?\.resumeRewalkCount \|\| 0\) \+ \(run\.resumeMode === 'REWALK' \? 1 : 0\)/);
  assert.match(serverSource('providerAwareRetrieval.ts'), /request\.cursor/);
});

test('P12: InnerTube resume rewinds from page 1 and skips recorded pages without duplicate creators', () => {
  assert.equal(resumeModeForProvider('youtube-innertube'), 'REWALK');
  const provider = serverSource('youtubeInnertubeProvider.ts');
  assert.match(provider, /for \(let walked = 1; walked < pageNumber; walked\+\+\)/);
  assert.match(provider, /walk uses live continuations/);
  const queue = serverSource('queueManager.ts');
  // A segment child's stored token is the absolute provider page ("11"), not
  // its run-local page number (1); prefer the token so a rewalk does not
  // replay pages the parent already consumed.
  assert.match(queue, /const pageToken = run\.resumeMode === 'REWALK'\s*\? \(run\.nextPageToken \|\| String\(nextPage\)\)\s*: run\.nextPageToken/);
  assert.match(queue, /if \(await autonomousPageExists\(run\.runId, nextPage\)\)/);
});

test('P13: provider exhaustion ends the run with no child', () => {
  const noNext = evaluateContinuationV2({ ...baseV2, hasNextPage: false });
  assert.equal(noNext.shouldContinue, false);
  assert.equal(noNext.primaryReason, 'NO_NEXT_PAGE');
  const exhausted = evaluateContinuationV2({ ...baseV2, providerExhausted: true });
  assert.equal(exhausted.shouldContinue, false);
  assert.equal(exhausted.primaryReason, 'PROVIDER_EXHAUSTED');
});

test('P14: an InnerTube deadline defers resumably and never fabricates a page-N observation', () => {
  const decision = evaluateContinuationV2({
    ...baseV2, timeBudgetExhausted: true, priorLowValueStreak: 1,
  });
  assert.equal(decision.shouldContinue, true);
  assert.equal(decision.defer, true);
  assert.equal(decision.deferReason, 'TIME');
  assert.equal(decision.primaryReason, 'TIME_BUDGET_EXHAUSTED');
  assert.equal(decision.streaks.lowValue, 1, 'timed-out page is transparent to streaks');

  const queue = serverSource('queueManager.ts');
  const timeoutStart = queue.indexOf("String(error?.code || '').toUpperCase() === INNERTUBE_TIMEOUT_CODE");
  const timeoutEnd = queue.indexOf('if (queryRunId && error instanceof QuotaAllocationExhaustedError)');
  assert.ok(timeoutStart > 0 && timeoutEnd > timeoutStart);
  const timeoutBlock = queue.slice(timeoutStart, timeoutEnd);
  assert.match(timeoutBlock, /APPROVED LIMITATION \(P14\)/);
  assert.match(timeoutBlock, /no page observation is written/);
  assert.match(timeoutBlock, /deferAutonomousRunForTime\(queryRunId/);
  assert.ok(!timeoutBlock.includes('recordAutonomousPage('));
  assert.match(serverSource('youtubeInnertubeProvider.ts'), /APPROVED LIMITATION \(P14\)/);
});

test('P15: pending pages across all active countries share quota fairly under the per-country cap', () => {
  const budget = computeEffectivePageBudget({
    safetyMaxPages: 50,
    providerMaxPages: 10,
    pageCostUnits: 100,
    remainingAutonomousQuota: 1600,
    pendingCountries: 16,
  });
  assert.equal(budget.runQuotaBudgetUnits, 100);
  assert.equal(budget.effectiveMaxPages, 1);
  assert.equal(budget.bindingBound, 'RUN_BUDGET');

  // There is no per-run minimum that could hand one country more than its
  // fair share: the quota allocation is derived solely from the remaining
  // budget and the number of pending countries. A dead min_run_pages knob was
  // removed rather than revived, because raising it here would starve others.
  const queue = serverSource('queueManager.ts');
  assert.doesNotMatch(queue, /autonomous_pagination_min_run_pages/);
  const policy = serverSource('continuationPolicy.ts');
  assert.doesNotMatch(policy, /minRunPages/);

  const countries = [...new Set(
    SUPPORTED_PRODUCTION_COUNTRIES
      .filter(country => !SUPPORTED_DORMANT_COUNTRIES.includes(country))
      .slice(0, 15)
      .concat('Germany'),
  )];
  const runs = countries.map((country, index) => ({
    country,
    runId: `${country}-${index}`,
    marginalUtility: 0.1 + index / 100,
    lastPageAt: `2026-10-${String((index % 9) + 1).padStart(2, '0')}T00:00:00Z`,
  }));
  runs.push(
    { country: 'Germany', runId: 'Germany-extra-1', marginalUtility: 0.9, lastPageAt: '2026-10-01T00:00:00Z' },
    { country: 'Germany', runId: 'Germany-extra-2', marginalUtility: 0.8, lastPageAt: '2026-10-02T00:00:00Z' },
  );
  const plan = planContinuationResume(runs, 0, countries.length);
  assert.equal(plan.selected.length, countries.length);
  assert.equal(new Set(plan.selected.map(run => run.country.toLowerCase())).size, countries.length);
  assert.equal(plan.perCountryCap, Math.ceil(runs.length / countries.length) + 1);
  assert.equal(plan.selected.length + plan.deferred.length, runs.length, 'no run is dropped');
  assert.ok(plan.deferred.every(run => run.country === 'Germany'));
  assert.ok(plan.selected.some(run => run.runId === 'Germany-extra-1'), 'utility ordering picks the best Germany run');
});

test('P16: a creator seen on pages 1 and 2 is counted once with a cross-page repeat', async () => {
  const runner: FakeRunner = {
    calls: [],
    query: async (text, params = []) => {
      runner.calls.push({ text, params });
      if (text.includes('WITH first_sighting AS')) {
        return {
          rows: [{
            page_distinct: 2, marginal_new: 0, marginal_confirmed: 1, marginal_quality: 1,
            marginal_non_trading: 0, cross_page_repeat: 1, cumulative_unique: 3,
            cumulative_confirmed: 2, cumulative_quality: 1, cumulative_non_trading: 0,
          }],
        };
      }
      return { rows: [] };
    },
  };
  const { getAutonomousPageMarginalMetrics } = await import('./autonomousPageStore');
  const metrics = await getAutonomousPageMarginalMetrics('run-1', 2, runner as never);
  assert.equal(metrics.pageDistinctCreators, 2);
  assert.equal(metrics.marginalNewCreators, 0);
  assert.equal(metrics.crossPageRepeatCreators, 1);
  assert.equal(metrics.cumulativeUniqueCreators, 3, 'not the sum of per-page distinct counts');
  assert.equal(metrics.cumulativeConfirmedCreators, 2);
  const sql = runner.calls[0].text;
  assert.match(sql, /MIN\(s\.page_number\) AS first_page/);
  assert.match(sql, /fs\.first_page <= \$2/);
  assert.match(sql, /fs\.first_page < \$2 AND ps\.channel_id IS NOT NULL/);
  // Run metrics must use the persisted cumulative unique count, not the sum
  // of overlapping per-page distinct populations.
  const pageStore = serverSource('autonomousPageStore.ts');
  assert.match(pageStore, /SELECT page_metrics, cumulative_unique_creators FROM autonomous_query_page_observations/);
  assert.match(pageStore, /cumulativeUniqueCreators: cumulative/);
  // Novel-term attribution is exact to the run/page that observed it, not to
  // any other run that happens to share the channel or time window.
  assert.match(pageStore, /o\.query_run_id=\$1\s*AND o\.query_page_number=\$2/);
  assert.match(
    serverSource('terminologyIntelligence.ts'),
    /query_run_id=COALESCE\(terminology_observations\.query_run_id, EXCLUDED\.query_run_id\)/,
  );
  assert.match(migration161(), /ADD COLUMN IF NOT EXISTS query_run_id TEXT/);
});

test('P17: the 50-page safety ceiling preserves a resumable linked segment', () => {
  assert.equal(shouldCreateContinuationSegment({
    paginationEnabled: true, usingV2: true, primaryReason: 'PAGE_CEILING',
    bindingBound: 'SAFETY', hasNextPage: true,
  }), true);
  for (const args of [
    { paginationEnabled: false, usingV2: true, primaryReason: 'PAGE_CEILING', bindingBound: 'SAFETY', hasNextPage: true },
    { paginationEnabled: true, usingV2: false, primaryReason: 'PAGE_CEILING', bindingBound: 'SAFETY', hasNextPage: true },
    { paginationEnabled: true, usingV2: true, primaryReason: 'PAGE_CEILING', bindingBound: 'PROVIDER', hasNextPage: true },
    { paginationEnabled: true, usingV2: true, primaryReason: 'PAGE_CEILING', bindingBound: 'TREATMENT', hasNextPage: true },
    { paginationEnabled: true, usingV2: true, primaryReason: 'PAGE_CEILING', bindingBound: 'TRIAL', hasNextPage: true },
    { paginationEnabled: true, usingV2: true, primaryReason: 'PAGE_CEILING', bindingBound: 'SAFETY', hasNextPage: false },
    { paginationEnabled: true, usingV2: true, primaryReason: 'RUN_BUDGET_EXHAUSTED', bindingBound: 'SAFETY', hasNextPage: true },
  ]) {
    assert.equal(shouldCreateContinuationSegment(args), false);
  }
  const queue = serverSource('queueManager.ts');
  assert.match(queue, /shouldCreateContinuationSegment\(\{/);
  assert.match(queue, /const segment = await createContinuationRunSegment\(\{/);
  assert.match(queue, /nextPageToken: searchPage!\.nextPageToken!/);
  assert.match(queue, /queryRunId: segment\.childRunId,[\s\S]*?pageNumber: 1,[\s\S]*?pageToken: searchPage!\.nextPageToken!/);
  // The first-page binding bound is persisted and reused. Recomputing it from
  // live quota could relabel a stored SAFETY ceiling as RUN_BUDGET after a
  // mid-run quota change, which would silently skip the linked segment.
  assert.match(queue, /progress\?\.effectiveBindingBound \|\| budget\.bindingBound/);
  assert.match(queue, /effectiveBindingBound: bindingBound/);
  // A segment is a new run: it computes and persists its own fair-share
  // budget on its first page. Copying the parent's full budget would let the
  // segment spend the same fair-share allocation twice (report §6.4).
  const segmentCallStart = queue.indexOf('const segment = await createContinuationRunSegment');
  const segmentCallEnd = queue.indexOf('});', segmentCallStart);
  assert.ok(segmentCallStart >= 0 && segmentCallEnd > segmentCallStart);
  assert.doesNotMatch(queue.slice(segmentCallStart, segmentCallEnd), /runQuotaBudgetUnits/);
  const dbCore = serverSource('dbCore.ts');
  const segmentFnStart = dbCore.indexOf('export async function createContinuationRunSegment');
  const segmentFnEnd = dbCore.indexOf('export interface AutonomousQuotaAvailability', segmentFnStart);
  assert.ok(segmentFnStart >= 0 && segmentFnEnd > segmentFnStart);
  const segmentFn = dbCore.slice(segmentFnStart, segmentFnEnd);
  assert.doesNotMatch(segmentFn, /runQuotaBudgetUnits/);
  assert.match(segmentFn, /'SCHEDULED',now\(\),0,\$2,\$3,0,0,'RUNNING',\$4,\$1,\$5,requested_page_depth/);
  assert.match(dbCore, /continued_from_run_id/);
  assert.match(dbCore, /continued_to_run_id/);
  assert.match(dbCore, /continuation_segment/);
  assert.match(dbCore, /effective_binding_bound/);
  assert.match(dbCore, /effectiveBindingBound/);
  const migration = migration161();
  assert.match(migration, /ADD COLUMN IF NOT EXISTS effective_binding_bound TEXT/);
  assert.match(migration, /effective_binding_bound IN \('SAFETY', 'PROVIDER', 'RUN_BUDGET', 'TREATMENT', 'TRIAL'\)/);
});

// ---------------------------------------------------------------------------
// T. Terminology and lifecycle (16)
// ---------------------------------------------------------------------------

test('T1: a native literal term creates canonical evidence and promotion eligibility when gates pass', async () => {
  const { result, observation } = await observeCase(confirmedChannel);
  assert.deepEqual(result, { termId: 7, observationInserted: true });
  assert.ok(observation);
  assert.equal(observation.params[15], 'NATIVE_OBSERVED');
  assert.equal(observation.params[16], 'CREATOR_METADATA');
  assert.equal(observation.params[19], true);
});

test('T2: an AI paraphrase that is not present verbatim is rejected', () => {
  const baseline = buildNoveltyBaseline({
    country: 'Germany', vocab: undefined, vocabOk: false, existingTerms: [], existingOk: true,
  });
  assert.equal(baseline.ok, false);
  const verdict = classifyNativeCandidate(
    'Börsenanalyse Frankfurt',
    [{ kind: 'CHANNEL_NAME', index: 0, text: 'Börsenanalyse LuxX' }],
    { ok: true, country: 'Germany', curatedTerms: [], existingTerms: [], failed: [] },
    {},
  );
  assert.equal(verdict.admit, false);
  assert.equal((verdict as { reason: string }).reason, 'non-literal');
});

test('T3: seed/bootstrap/translated/generated surfaces never become promotion-eligible evidence', async () => {
  const bootstrap = await observeCase(confirmedChannel, {
    nativeEvidenceStatus: 'BOOTSTRAP_SEED', sourceProvenanceFamily: 'CREATOR_METADATA',
  });
  assert.equal(bootstrap.observation?.params[15], 'BOOTSTRAP_SEED');
  assert.equal(bootstrap.observation?.params[19], false);
  const translated = await observeCase(confirmedChannel, { nativeEvidenceStatus: 'TRANSLATED_SEED' });
  assert.equal(translated.observation?.params[15], 'TRANSLATED_SEED');
  assert.equal(translated.observation?.params[19], false);

  const dbCore = serverSource('dbCore.ts');
  assert.match(dbCore, /export async function seedCountryVocabularyIfMissing/);
  assert.ok(dbCore.includes("const empty = (column: string) => `(${column} IS NULL OR ${column} = '[]'::jsonb)`;"));
  assert.ok(dbCore.includes("languages = CASE WHEN ${empty('country_vocabularies.languages')} THEN EXCLUDED.languages ELSE country_vocabularies.languages END"));
  assert.match(dbCore, /ON CONFLICT\(country\) DO UPDATE SET/);
});

test('T4: three independent native creators validate without any Discord community gate', () => {
  const decision = decideLifecycleV2(baseLifecycle);
  assert.equal(decision.status, 'MULTI_CREATOR_VALIDATED');
  assert.equal(decision.searchEligible, false);
});

test('T5: two native creators do not validate', () => {
  const decision = decideLifecycleV2({ ...baseLifecycle, nativeCreators: 2, nativeEvidenceBuckets: 2 });
  assert.equal(decision.status, 'OBSERVED');
  assert.equal(decision.searchEligible, false);
});

test('T6: three creators sharing one community fingerprint count as one independence bucket', () => {
  const decision = decideLifecycleV2({ ...baseLifecycle, nativeCreators: 3, nativeEvidenceBuckets: 1 });
  assert.equal(decision.status, 'OBSERVED');
  assert.equal(decision.searchEligible, false);
});

test('T7: two independent external sources/families validate; a single source or family does not', async () => {
  const now = new Date('2026-10-26T00:00:00Z');
  const two = evaluateExternalTermEvidence({
    term: 'Charttechnik', aliases: [], language: 'de', script: 'LATIN', now,
    rows: [
      { sourceId: 's1', sourceFamily: 'PUBLICATION', correlationKey: 'a', observedAt: '2026-10-25T00:00:00Z', confidence: 0.9, reliability: 0.9, relevance: 0.9, surface: 'charttechnik', language: 'de', script: 'LATIN' },
      { sourceId: 's2', sourceFamily: 'PUBLIC_COMMUNITY', correlationKey: 'b', observedAt: '2026-10-25T00:00:00Z', confidence: 0.8, reliability: 0.8, relevance: 0.8, surface: 'Charttechnik', language: 'de', script: 'LATIN' },
    ],
  });
  assert.equal(two.eligible, true);
  assert.equal(two.independentSources, 2);
  assert.deepEqual(two.families, ['PUBLICATION', 'PUBLIC_COMMUNITY']);

  const single = evaluateExternalTermEvidence({
    term: 'Charttechnik', aliases: [], language: 'de', script: 'LATIN', now,
    rows: [{ sourceId: 's1', sourceFamily: 'PUBLICATION', correlationKey: 'a', observedAt: '2026-10-25T00:00:00Z', confidence: 0.9, reliability: 0.9, relevance: 0.9, surface: 'charttechnik', language: 'de', script: 'LATIN' }],
  });
  assert.equal(single.eligible, false);
  assert.ok(single.reasons.includes('INSUFFICIENT_INDEPENDENT_SOURCES'));

  // Future-dated rows are not fresh corroboration: an age-only check would
  // treat a bad clock or forged timestamp as valid indefinitely.
  const futureDated = evaluateExternalTermEvidence({
    term: 'Charttechnik', aliases: [], language: 'de', script: 'LATIN', now,
    rows: [
      { sourceId: 's1', sourceFamily: 'PUBLICATION', correlationKey: 'a', observedAt: '2026-10-27T00:00:00Z', confidence: 0.9, reliability: 0.9, relevance: 0.9, surface: 'charttechnik', language: 'de', script: 'LATIN' },
      { sourceId: 's2', sourceFamily: 'PUBLIC_COMMUNITY', correlationKey: 'b', observedAt: '2026-10-27T00:00:00Z', confidence: 0.8, reliability: 0.8, relevance: 0.8, surface: 'Charttechnik', language: 'de', script: 'LATIN' },
    ],
  });
  assert.equal(futureDated.eligible, false);
  assert.deepEqual(futureDated.reasons, ['NO_MATCHING_LOCAL_SURFACE']);

  const decision = decideLifecycleV2({
    ...baseLifecycle, nativeCreators: 0, nativeEvidenceBuckets: 0,
    externalSources: 2, externalSourceCount: 2, externalEligible: true,
  });
  assert.equal(decision.status, 'MULTI_CREATOR_VALIDATED');

  // External evidence is stored outside terminology_observations, so the
  // native decayed-evidence score is always zero for an external-only term.
  // Qualified independent external buckets contribute trial units directly;
  // five buckets reach the same 5-unit trial threshold without native data.
  const externalRows = Array.from({ length: 5 }, (_, index) => ({
    source_id: `source-${index + 1}`,
    source_family: ['PUBLICATION', 'PUBLIC_COMMUNITY', 'EDUCATOR_DIRECTORY', 'BROKER_TERMINOLOGY', 'PUBLICATION'][index],
    correlation_key: `bucket-${index + 1}`,
    observed_at: new Date().toISOString(),
    confidence: 0.9,
    reliability: 0.9,
    relevance: 0.9,
    original_surface: 'Charttechnik',
    language: 'de',
    script: 'LATIN',
  }));
  const externalOnly = fakeRefreshRunner(
    {
      canonical_term: 'Charttechnik', lifecycle_status: 'OBSERVED',
      search_eligible: false, trust_tier: 3, decayed_evidence: 0,
    },
    { native_creators: 0, native_evidence_buckets: 0, decayed_evidence: 0 },
    {},
    externalRows,
  );
  await refreshTerminologyLifecycle(1, undefined, externalOnly as never);
  const lifecycle = externalOnly.calls.find(call => call.text.startsWith('UPDATE canonical_trading_terms'));
  assert.equal(lifecycle?.params[1], 'SEARCH_TRIAL');
  assert.equal(lifecycle?.params[2], true);
  // Corroboration is filtered by the local surface in SQL before the LIMIT;
  // a country-wide LIMIT in JavaScript could hide valid evidence behind 1,000
  // newer rows for other terms.
  const terminology = serverSource('terminologyIntelligence.ts');
  assert.match(terminology, /AND canonical_concept = ANY\(\$2::text\[\]\)/);
  assert.ok(!/lower\(btrim\(regexp_replace\(normalize\(original_surface, NFKC\)/.test(terminology), 'SQL surface matching must not depend on database lower() collation');
  assert.match(migration161(), /idx_external_osint_surface_country[\s\S]*?\(country, canonical_concept, observed_at DESC\)/);
});

test('T8: two native plus one external validates; one native plus one external does not', () => {
  const mixed = decideLifecycleV2({
    ...baseLifecycle, nativeCreators: 2, nativeEvidenceBuckets: 2,
    externalSources: 1, externalSourceCount: 1, externalEligible: false,
  });
  assert.equal(mixed.status, 'MULTI_CREATOR_VALIDATED');
  const insufficient = decideLifecycleV2({
    ...baseLifecycle, nativeCreators: 1, nativeEvidenceBuckets: 1,
    externalSources: 1, externalSourceCount: 1, externalEligible: false,
  });
  assert.equal(insufficient.status, 'OBSERVED');
});

test('T9: a 0.30 wrong-country share demotes an existing trial', () => {
  const decision = decideLifecycleV2({
    ...baseLifecycle, current: 'SEARCH_TRIAL', decayedEvidence: 6,
    confirmedTradingCreators: 7, wrongCountryCreators: 3,
  });
  assert.equal(decision.status, 'DEMOTED');
  assert.equal(decision.searchEligible, false);
});

test('T9b: the fresh-creator bar does not distort wrong-country or review shares', () => {
  // 90 confirmed sightings include repeat creators; only 10 are fresh. The
  // wrong-country and review shares must use the full 90-creator base, not the
  // fresh 10, or a useful term is demoted for evidence it did not produce.
  const decision = decideLifecycleV2({
    ...baseLifecycle, current: 'SEARCH_TRIAL', decayedEvidence: 6,
    confirmedTradingCreators: 90, freshConfirmedTradingCreators: 10,
    wrongCountryCreators: 10, needsReviewCreators: 10,
  });
  assert.equal(decision.searchEligible, true);
  assert.match(decision.reason, /controlled exploration/);
});

test('T9c: repeat sightings do not inflate promotion yield', () => {
  // Six confirmed sightings include three repeats; only three are fresh. The
  // fresh yield is 0.6 per 1,000 quota units, below the 1.0 bar, even though
  // the repeat-inflated count would be 1.2. Shares keep the full base.
  const v1 = evaluateNativeTermPromotion({
    novel: true, spamConfirmed: false, executions: 3, quotaConsumed: 5000,
    confirmedTradingCreators: 6, freshConfirmedTradingCreators: 3,
    nonTradingCreators: 0, wrongCountryCreators: 0, needsReviewCreators: 0,
    distinctCreators: 3, distinctCommunities: 2, coordinatedBurst: false,
  });
  assert.equal(v1.metrics.yieldPer1000Quota, 0.6);
  assert.equal(v1.metrics.confirmedShare, 1);
  assert.equal(v1.decision, 'HOLD');
  assert.ok(v1.reasons.some(reason => reason.startsWith('yield-below-bar:')));

  const v2 = evaluateNativeTermPromotionV2({
    novel: true, spamConfirmed: false, executions: 3, quotaConsumed: 5000,
    confirmedTradingCreators: 6, freshConfirmedTradingCreators: 3,
    nonTradingCreators: 0, wrongCountryCreators: 0, needsReviewCreators: 0,
    validationBasis: true, decayedEvidence: 6, decayedYield: 0.5,
  });
  assert.equal(v2.metrics.yieldPer1000Quota, 0.6);
  assert.equal(v2.metrics.confirmedShare, 1);
  assert.equal(v2.decision, 'HOLD');
  assert.ok(v2.reasons.some(reason => reason.startsWith('yield-below-bar:')));
});

test('T10: a 0.30 review share revokes an existing trial without a new promotion', () => {
  const decision = decideLifecycleV2({
    ...baseLifecycle, current: 'SEARCH_TRIAL', decayedEvidence: 6,
    confirmedTradingCreators: 7, needsReviewCreators: 3,
  });
  assert.equal(decision.status, 'MULTI_CREATOR_VALIDATED');
  assert.equal(decision.searchEligible, false);
});

test('T11: a 0.40 confirmed-trader share cannot promote but keeps an existing trial', () => {
  const decision = decideLifecycleV2({
    ...baseLifecycle, current: 'SEARCH_TRIAL', decayedEvidence: 6,
    confirmedTradingCreators: 4, nonTradingCreators: 6,
  });
  assert.equal(decision.status, 'SEARCH_TRIAL');
  assert.equal(decision.searchEligible, true);
});

test('T12: a coordinated burst holds at three buckets and releases at a fourth', () => {
  const held = decideLifecycleV2({
    ...baseLifecycle, decayedEvidence: 6, confirmedTradingCreators: 6, coordinatedBurst: true,
  });
  assert.equal(held.status, 'MULTI_CREATOR_VALIDATED');
  assert.equal(held.searchEligible, false);
  assert.match(held.reason, /fourth independent bucket/);

  const released = decideLifecycleV2({
    ...baseLifecycle, nativeEvidenceBuckets: 4, decayedEvidence: 6,
    confirmedTradingCreators: 6, coordinatedBurst: true,
  });
  assert.equal(released.status, 'SEARCH_TRIAL');
  assert.equal(released.searchEligible, true);
});

test('T13: the proven gate promotes with validation, executions, yield, and shares', async () => {
  const decision = decideLifecycleV2({
    ...baseLifecycle, decayedEvidence: 6, confirmedTradingCreators: 6,
    executions: 3, decayedYield: 0.30, quotaConsumed: 5000, nativeNovel: true,
  });
  assert.equal(decision.status, 'PROVEN_SEARCH_TERM');
  assert.equal(decision.searchEligible, true);

  // Repeat-only sightings must not promote: bound confirmed traders by the
  // persisted fresh-creator count, exactly like the legacy gate.
  const repeatOnly = fakeRefreshRunner(
    { lifecycle_status: 'OBSERVED', search_eligible: false, trust_tier: 3, decayed_evidence: 6, decayed_yield: 0.3 },
    { native_creators: 3, native_evidence_buckets: 3, decayed_evidence: 6 },
    { executions: 3, quota: 5000, confirmed: 6, nontrading: 0, wrong: 0, review: 0, fresh_confirmed: 0 },
  );
  await refreshTerminologyLifecycle(1, undefined, repeatOnly as never);
  const lifecycle = repeatOnly.calls.find(call => call.text.startsWith('UPDATE canonical_trading_terms'));
  assert.equal(lifecycle?.params[1], 'MULTI_CREATOR_VALIDATED');
  assert.equal(lifecycle?.params[2], false);
});

test('T13c: native promotion requires an affirmative novelty verdict', async () => {
  const perf = { executions: 3, quota: 5000, confirmed: 6, nontrading: 0, wrong: 0, review: 0, fresh_confirmed: 6 };
  const noQuality = fakeRefreshRunner(
    { lifecycle_status: 'OBSERVED', search_eligible: false, trust_tier: 3, decayed_evidence: 6, decayed_yield: 0.3 },
    { native_creators: 3, native_evidence_buckets: 3, decayed_evidence: 6 },
    perf,
  );
  await refreshTerminologyLifecycle(1, undefined, noQuality as never);
  const blocked = noQuality.calls.find(call => call.text.startsWith('UPDATE canonical_trading_terms'));
  assert.equal(blocked?.params[1], 'SEARCH_TRIAL', 'missing native quality evidence cannot prove a term');
  assert.equal(blocked?.params[2], true);

  const affirmative = fakeRefreshRunner(
    { lifecycle_status: 'OBSERVED', search_eligible: false, trust_tier: 3, decayed_evidence: 6, decayed_yield: 0.3 },
    { native_creators: 3, native_evidence_buckets: 3, decayed_evidence: 6 },
    perf,
    [],
    { v1: 3, spam: false, novel: true },
  );
  await refreshTerminologyLifecycle(1, undefined, affirmative as never);
  const promoted = affirmative.calls.find(call => call.text.startsWith('UPDATE canonical_trading_terms'));
  assert.equal(promoted?.params[1], 'PROVEN_SEARCH_TERM');
  assert.equal(promoted?.params[2], true);

  const spamDecision = decideLifecycleV2({
    ...baseLifecycle, decayedEvidence: 6, confirmedTradingCreators: 6,
    executions: 3, decayedYield: 0.30, quotaConsumed: 5000,
    nativeNovel: true, spamConfirmed: true,
  });
  assert.notEqual(spamDecision.status, 'PROVEN_SEARCH_TERM', 'spam-confirmed native evidence can never prove a term');
});

test('T13b: new non-traders cannot lend fresh credit to repeat confirmed traders', async () => {
  // The aggregate counts alone cannot distinguish this from six fresh
  // confirmed traders: min(confirmed,new) would be 6 and wrongly promote.
  // The exact intersection recorded by attribution is zero.
  const repeatPlusNewNonTraders = fakeRefreshRunner(
    { lifecycle_status: 'OBSERVED', search_eligible: false, trust_tier: 3, decayed_evidence: 6, decayed_yield: 0.3 },
    { native_creators: 3, native_evidence_buckets: 3, decayed_evidence: 6 },
    { executions: 3, quota: 5000, confirmed: 6, nontrading: 6, wrong: 0, review: 0, fresh_confirmed: 0 },
  );
  await refreshTerminologyLifecycle(1, undefined, repeatPlusNewNonTraders as never);
  const lifecycle = repeatPlusNewNonTraders.calls.find(call => call.text.startsWith('UPDATE canonical_trading_terms'));
  assert.equal(lifecycle?.params[1], 'MULTI_CREATOR_VALIDATED');
  assert.equal(lifecycle?.params[2], false);
  const perfQuery = repeatPlusNewNonTraders.calls.find(call => call.text.includes('SUM(fresh_confirmed_trading_creators)'));
  assert.match(String(perfQuery?.text), /fresh_confirmed_trading_creators/);
  assert.ok(!/Math\.min\(Number\(perfRow\.confirmed/.test(serverSource('terminologyIntelligence.ts')));
});

test('T14: sustained low yield demotes a proven term', () => {
  const decision = decideLifecycleV2({
    ...baseLifecycle, decayedEvidence: 6, confirmedTradingCreators: 6,
    executions: 5, decayedYield: 0.05, quotaConsumed: 5000,
  });
  assert.equal(decision.status, 'DEMOTED');
  assert.equal(decision.searchEligible, false);
});

test('T15: a lower-quality creator observation is stored without promotion or legacy-vocabulary writes', async () => {
  const saved: unknown[] = [];
  const observed: Array<{ promotionEligible?: boolean }> = [];
  const report = await admitNativeCandidates({
    channel: {
      channel_id: 'ch-1', channel_name: 'Charttechnik Frankfurt', country: 'Germany',
      country_status: 'CONFIRMED', trading_status: 'TRADING_CONFIRMED', quality_score: 40,
      discord_invite: null,
    } as unknown as ChannelRecord,
    sources: [{ kind: 'CHANNEL_NAME', index: 0, text: 'Charttechnik Frankfurt' }],
    parsed: { terminology: ['Charttechnik'] },
    baseline: { ok: true, country: 'Germany', curatedTerms: [], existingTerms: [], failed: [] },
    language: 'de', locale: 'de-DE', humanApproved: false, humanObservation: 'ENRICHMENT',
    promotionEligible: false, persistLegacyTerm: false,
    deps: {
      saveTerm: async (...args: unknown[]) => { saved.push(args); return {}; },
      observeTerm: async (args) => { observed.push(args as { promotionEligible?: boolean }); return { termId: 1, observationInserted: true }; },
    },
  });
  assert.equal(report.admitted, 1);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].promotionEligible, false);
  assert.equal(saved.length, 0, 'legacy extracted_vocabulary is not incremented');

  // Classification is independent of the promotion gate: an ineligible
  // creator still records NATIVE_OBSERVED provenance, with the eligibility
  // flag false. Otherwise its evidence would be invisible to the v2 aggregate.
  const ineligible = await observeCase(confirmedChannel, { promotionEligible: false });
  assert.equal(ineligible.observation?.params[15], 'NATIVE_OBSERVED');
  assert.equal(ineligible.observation?.params[19], false);

  assert.equal(NATIVE_PROMOTION_MIN_CREATORS, 3);
  assert.equal(NATIVE_PROMOTION_MIN_EXECUTIONS, 3);
  assert.equal(NATIVE_PROMOTION_MIN_YIELD_PER_1000_QUOTA, 1.0);
});

test('T16: migration 161 backfills eligibility conservatively and does not demote legacy terms', () => {
  const migration = migration161();
  assert.match(migration, /SET promotion_eligible = true/);
  assert.match(migration, /o\.promotion_eligible = false/);
  assert.match(migration, /c\.country_status = 'CONFIRMED'/);
  assert.match(migration, /c\.trading_status = 'TRADING_CONFIRMED'/);
  assert.match(migration, /COALESCE\(c\.quality_score, 0\) >= 55/);
  assert.match(migration, /lower\(c\.country\) = lower\(t\.country\)/);
  assert.match(migration, /o\.native_evidence_status IS NULL OR o\.native_evidence_status = 'NATIVE_OBSERVED'/);
  assert.match(migration, /COALESCE\(o\.is_code_switched, false\) = false/);
  const legacy = decideLifecycleV2({
    ...baseLifecycle, nativeCreators: 0, nativeEvidenceBuckets: 0,
    externalSources: 0, externalSourceCount: 0, externalEligible: false,
    decayedEvidence: 6, current: 'OBSERVED',
  });
  assert.equal(legacy.status, 'OBSERVED');
  assert.equal(legacy.searchEligible, false);
});

// ---------------------------------------------------------------------------
// C. Country isolation (3)
// ---------------------------------------------------------------------------

test('C1: the same term observed in the US and UK creates two country-scoped canonical rows', async () => {
  const us = await observeCase(
    confirmedChannel,
    { term: 'Order Flow', country: 'United States', sourceCreatorCountry: 'United States', language: 'en', locale: 'en-US' },
    11,
  );
  const uk = await observeCase(
    confirmedChannel,
    { term: 'Order Flow', country: 'United Kingdom', sourceCreatorCountry: 'United Kingdom', language: 'en', locale: 'en-GB' },
    12,
  );
  assert.equal(us.result?.termId, 11);
  assert.equal(uk.result?.termId, 12);
  const usInsert = us.runner.calls.find(call => call.text.startsWith('INSERT INTO canonical_trading_terms'));
  const ukInsert = uk.runner.calls.find(call => call.text.startsWith('INSERT INTO canonical_trading_terms'));
  assert.equal(usInsert?.params[2], 'United States');
  assert.equal(ukInsert?.params[2], 'United Kingdom');
  assert.notEqual(us.result?.termId, uk.result?.termId);
  assert.match(serverSource('db/migrations/012_continuous_terminology_intelligence.sql'), /UNIQUE\(country, normalized_term\)/);
});

test('C2: a channel reclassified away from the target clears stale promotion eligibility', async () => {
  const runner = fakeRefreshRunner();
  await refreshTerminologyLifecycle(1, undefined, runner as never);
  const clear = runner.calls.find(call => call.text.startsWith('UPDATE terminology_observations'));
  assert.ok(clear);
  assert.deepEqual(clear.params, [1, 'Germany', 'de']);
  assert.match(clear.text, /SET promotion_eligible=false/);
  assert.match(clear.text, /lower\(c\.country\) <> lower\(\$2\)/);
  const lifecycle = runner.calls.find(call => call.text.startsWith('UPDATE canonical_trading_terms'));
  assert.deepEqual(lifecycle?.params, [1, 'CANDIDATE', false, 3]);
  // NULL term_language means the writer did not record one; the v2 aggregate
  // must treat it as eligible, matching the demotion query and backfill.
  assert.match(serverSource('terminologyIntelligence.ts'), /o\.term_language IS NULL OR o\.term_language=\$4/);
});

test('C3: a LIKELY-country creator remains observation-only and never native promotion evidence', async () => {
  const { observation } = await observeCase({
    country_status: 'LIKELY', trading_status: 'TRADING_CONFIRMED', quality_score: 80,
  });
  assert.equal(observation?.params[15], null);
  assert.equal(observation?.params[19], false);
});

// ---------------------------------------------------------------------------
// D. Duplicate avoidance (2)
// ---------------------------------------------------------------------------

test('D1: repeated creator/video observations converge on one observation key', () => {
  const base = {
    canonicalTermId: 7, channelId: 'ch-1', videoId: 'vid-1', observationType: 'VIDEO_TITLE',
    evidence: { qualityVersion: 'native-v1', novel: true, generic: false, sourceRef: { kind: 'VIDEO_TITLE', index: 0, span: 'Charttechnik', videoId: 'vid-1' } },
  };
  const first = computeObservationKey(base);
  const reingested = computeObservationKey({
    ...base,
    evidence: { ...base.evidence, novel: false, generic: true, extractor: 'GROQ', sourceRef: { kind: 'VIDEO_TITLE', index: 3, span: 'Charttechnik', videoId: 'vid-1' } },
  });
  assert.equal(first, reingested);
  assert.notEqual(first, computeObservationKey({ ...base, videoId: 'vid-2' }));
  const terminology = serverSource('terminologyIntelligence.ts');
  assert.match(terminology, /ON CONFLICT\(observation_key\) DO UPDATE SET/);
  assert.match(terminology, /COUNT\(DISTINCT source_channel_id\)/);
});

test('D2: syndicated copies of one external source collapse into one independence bucket', () => {
  const result = evaluateExternalTermEvidence({
    term: 'Charttechnik', aliases: [], language: 'de', script: 'LATIN',
    now: new Date('2026-10-26T00:00:00Z'),
    rows: [
      { sourceId: 's1', sourceFamily: 'NEWS', correlationKey: 'same', observedAt: '2026-10-25T00:00:00Z', confidence: 0.9, reliability: 0.9, relevance: 0.9, surface: 'charttechnik', language: 'de', script: 'LATIN' },
      { sourceId: 's2', sourceFamily: 'NEWS', correlationKey: 'same', observedAt: '2026-10-25T00:00:00Z', confidence: 0.9, reliability: 0.9, relevance: 0.9, surface: 'charttechnik', language: 'de', script: 'LATIN' },
    ],
  });
  assert.equal(result.eligible, false);
  assert.equal(result.independentSources, 1);
  assert.deepEqual(result.families, ['NEWS']);
  assert.ok(result.reasons.includes('INSUFFICIENT_INDEPENDENT_SOURCES'));
  assert.ok(result.reasons.includes('INSUFFICIENT_SOURCE_FAMILIES'));
});

// ---------------------------------------------------------------------------
// E. Expanded extraction and AI budget (6)
// ---------------------------------------------------------------------------

test('E1: with CDL/v2 flags off, only the existing quality>=55 path remains', () => {
  const eligibility = resolveNativeExtractionEligibility({
    cdlEnabled: false, nativeExtractionFlagEnabled: true, promotionV2Enabled: true,
    qualityScore: 80, source: 'search', countryStatus: 'CONFIRMED',
    countryInScope: true, tradingStatus: 'TRADING_CONFIRMED',
  });
  assert.equal(eligibility.nativeExtractionEnabled, false);
  assert.equal(eligibility.promotionEligible, undefined);
  assert.equal(eligibility.persistLegacyTerm, true);
  assert.equal(eligibility.nativeEligible, true, 'legacy quality>=55 path still runs');
  assert.equal(eligibility.termHarvestEnabled, true);
  const ingestion = serverSource('ingestionPipeline.ts');
  const helper = ingestion.slice(
    ingestion.indexOf('export function resolveNativeExtractionEligibility'),
    ingestion.indexOf('export interface Inge'),
  );
  assert.ok(!helper.includes('discovery_extraction_enabled'));
  // The AI ledger is the only authorized provider-spend path. Turning the
  // native gates off preserves the legacy quality path but must not bypass the
  // daily cap, so there is no uncharged AI branch left to select.
  const query = serverSource('queryIntelligence.ts');
  assert.ok(!query.includes('budgetDisabled'));
  assert.ok(!query.includes('aiBudgetEnabled'));
  assert.ok(!ingestion.includes('aiBudgetEnabled'));
  assert.match(query, /reservation = await reserveNativeVocabularyAiRun\(/);
  assert.match(query, /if \(!replayRun && aiRun\) \{/);
});

test('E2: an active country-valid low-quality trader runs extraction without promotion or legacy vocabulary', () => {
  const eligibility = resolveNativeExtractionEligibility({
    cdlEnabled: true, nativeExtractionFlagEnabled: true, promotionV2Enabled: true,
    qualityScore: 40, source: 'search', countryStatus: 'CONFIRMED',
    countryInScope: true, tradingStatus: 'TRADING_CONFIRMED',
  });
  assert.equal(eligibility.nativeExtractionEnabled, true);
  assert.equal(eligibility.nativeEligible, true);
  assert.equal(eligibility.promotionEligible, false);
  assert.equal(eligibility.persistLegacyTerm, false);
  assert.equal(eligibility.termHarvestEnabled, false);
});

test('E3: the 201st AI call is budget-skipped while rule evidence persists', () => {
  const decision = evaluateNativeVocabularyAiBudget({
    requestId: 'req-201',
    snapshot: { globalCalls: 200, countryCalls: 0, actualCostMicrounits: 0, outstandingReservationMicrounits: 0 },
  });
  assert.equal(decision.admit, false);
  assert.equal(decision.status, 'BUDGET_SKIPPED');
  assert.match(decision.reason, /GLOBAL_CALL_CAP:200>=200/);
  const source = serverSource('queryIntelligence.ts');
  assert.match(source, /Rule-based evidence retained/);
  const ruleHitsAt = source.indexOf('for (const hit of findRuleInstrumentHits(');
  const reservationAt = source.indexOf('reservation = await reserveNativeVocabularyAiRun(');
  assert.ok(ruleHitsAt > 0 && reservationAt > ruleHitsAt, 'rule evidence is persisted before any AI budget call');
});

test('E4: a country at its 21st call is skipped while other countries keep the global budget', () => {
  const capped = evaluateNativeVocabularyAiBudget({
    requestId: 'req-country',
    snapshot: { globalCalls: 50, countryCalls: 20, actualCostMicrounits: 0, outstandingReservationMicrounits: 0 },
  });
  assert.equal(capped.admit, false);
  assert.match(capped.reason, /COUNTRY_CALL_CAP:20>=20/);
  const other = evaluateNativeVocabularyAiBudget({
    requestId: 'req-other-country',
    snapshot: { globalCalls: 50, countryCalls: 0, actualCostMicrounits: 0, outstandingReservationMicrounits: 0 },
  });
  assert.equal(other.admit, true);
  assert.equal(other.status, 'RESERVED');
});

test('E5: identical creator metadata re-ingested is one logical AI request with no duplicate spend', () => {
  const hash = computeNativeVocabularyMetadataHash(['Channel', 'desc', 'title', 'de', 'de-DE']);
  const first = computeNativeVocabularyRequestId({ channelId: 'ch-1', metadataHash: hash, budgetDay: '2026-10-26' });
  const second = computeNativeVocabularyRequestId({ channelId: 'ch-1', metadataHash: hash, budgetDay: '2026-10-26' });
  assert.equal(first, second);
  const skipped = evaluateNativeVocabularyAiBudget({
    requestId: first,
    existingStatus: 'SUCCEEDED',
    snapshot: { globalCalls: 1, countryCalls: 1, actualCostMicrounits: 25_000, outstandingReservationMicrounits: 0 },
  });
  assert.equal(skipped.admit, false);
  assert.equal(skipped.reason, 'IDEMPOTENT_SUCCEEDED');
});

test('E6: absent/OFF discovery_extraction_enabled never invokes the staging pipeline', async () => {
  const summary = await maybeRunDiscoveryEvidenceExtraction(
    { channelId: 'ch-1', fallbackCountry: 'Germany' },
    { readSetting: async () => '' },
  );
  assert.equal(summary.skipped, true);
  assert.equal(summary.reason, 'FLAG_OFF');
  assert.equal(summary.stagedCount, 0);
  const ingestion = serverSource('ingestionPipeline.ts');
  const helper = ingestion.slice(
    ingestion.indexOf('export function resolveNativeExtractionEligibility'),
    ingestion.indexOf('export interface Inge'),
  );
  assert.ok(!helper.includes('discovery_extraction_enabled'));
});

// ---------------------------------------------------------------------------
// Q. Coverage and quota (6)
// ---------------------------------------------------------------------------

test('Q1: every configured active country gets a turn and unselected dormant countries are not swept', () => {
  const all = [...SUPPORTED_PRODUCTION_COUNTRIES];
  const global = resolveAutonomousCountries(all, [], [], 'GLOBAL');
  assert.equal(global.length, 15);
  assert.ok(SUPPORTED_DORMANT_COUNTRIES.every(country => !global.includes(country)));
  assert.ok(global.every(country => SUPPORTED_PRODUCTION_COUNTRIES.includes(country)));

  const active = all.filter(country => !SUPPORTED_DORMANT_COUNTRIES.includes(country));
  const selectedActive = resolveAutonomousCountries(all, [], active, 'SELECTED_COUNTRIES');
  assert.equal(selectedActive.length, 15);
  assert.ok(SUPPORTED_DORMANT_COUNTRIES.every(country => !selectedActive.includes(country)));

  const selectedWithDormant = resolveAutonomousCountries(all, [], [...active, 'Italy'], 'SELECTED_COUNTRIES');
  assert.equal(selectedWithDormant.length, 16);
  assert.ok(selectedWithDormant.includes('Italy'));
});

test('Q2: a deferred continuation is scheduled before a new query', () => {
  const producer = serverSource('autonomousDiscovery.ts');
  const resumeAt = producer.indexOf('resumeOrphanedAutonomousPages({ force: true })');
  const snapshotAt = producer.indexOf('const snapshot = await reconcileYouTubeQuotaRolloverAndGetAutonomousSnapshot(now)');
  assert.ok(resumeAt > 0 && snapshotAt > resumeAt, 'resume sweep runs before the queue snapshot');
  assert.ok(AUTONOMOUS_CONTINUATION_JOB_PRIORITY > AUTONOMOUS_NEW_QUERY_JOB_PRIORITY);
  const plan = planContinuationResume([{ country: 'Germany', runId: 'g1' }], 0, 15);
  assert.deepEqual(plan.selected.map(run => run.runId), ['g1']);
  const queue = serverSource('queueManager.ts');
  assert.match(queue, /priority: AUTONOMOUS_CONTINUATION_JOB_PRIORITY/);
  assert.match(queue, /priority: source === 'manual_search' \? 100 : AUTONOMOUS_NEW_QUERY_JOB_PRIORITY/);
});

test('Q3: a country with many pending pages is capped, and excess work is deferred rather than dropped', () => {
  const runs = [
    ...Array.from({ length: 6 }, (_, index) => ({ country: 'Germany', runId: `g${index}`, marginalUtility: index / 10 })),
    ...Array.from({ length: 2 }, (_, index) => ({ country: 'France', runId: `f${index}`, marginalUtility: index / 10 })),
    { country: 'United Kingdom', runId: 'u0', marginalUtility: 0.5 },
  ];
  const plan = planContinuationResume(runs, 0, 3);
  assert.equal(plan.selected.length, 3);
  assert.equal(plan.deferred.length, 6);
  assert.equal(plan.selected.length + plan.deferred.length, runs.length);
  assert.equal(new Set(plan.selected.map(run => run.country)).size, 3);
  assert.equal(plan.perCountryCap, Math.ceil(runs.length / 3) + 1);
  const queue = serverSource('queueManager.ts');
  assert.match(queue, /const countriesThisSweep = new Set<string>\(\)/);
  assert.match(queue, /if \(countriesThisSweep\.has\(countryKey\)\)/);
  assert.match(queue, /if \(grants >= perCountryCap\)/);
  assert.match(queue, /deferred/);
});

test('Q4: concurrent runs share the global hard cap; allocation percent is not a partition', () => {
  const dbCore = serverSource('dbCore.ts');
  assert.match(dbCore, /Allocation percentages are scheduling preferences, not hard partitions\./);
  assert.match(dbCore, /actual_used \+ row\.reserved_total \+ args\.units > args\.dailyBudget/);
  assert.match(dbCore, /SELECT id FROM quota_tracker WHERE id='youtube' FOR UPDATE/);
  assert.match(dbCore, /await client\.query\('ROLLBACK'\);\s*return false;/);
  assert.match(serverSource('quotaKeyCapShadow.ts'), /ENFORCED_KEY = 'youtube_key_daily_cap_enforced'/);
  const health = evaluateCountryDiscoveryHealth(healthyHealthInput());
  assert.equal(health.healthy, true);
  assert.equal(health.checks.find(check => check.id === 'youtube_hard_cap')?.status, 'PASS');
});

test('Q5: InnerTube pages cost 0 YouTube units, official pages 100, and Brave uses its own ledger', () => {
  const innerTube = computeEffectivePageBudget({
    safetyMaxPages: 50, providerMaxPages: 10, pageCostUnits: 0,
    remainingAutonomousQuota: 0, pendingCountries: 16,
  });
  assert.equal(innerTube.quotaPages, 50);
  assert.equal(innerTube.effectiveMaxPages, 10);
  assert.equal(innerTube.bindingBound, 'PROVIDER');

  const official = computeEffectivePageBudget({
    safetyMaxPages: 50, providerMaxPages: 10, pageCostUnits: 100,
    remainingAutonomousQuota: 300, pendingCountries: 1,
  });
  assert.equal(official.effectiveMaxPages, 3);
  assert.equal(official.bindingBound, 'RUN_BUDGET');

  const queue = serverSource('queueManager.ts');
  assert.match(queue, /providerQuotaUnits=100/);
  assert.match(queue, /quotaFreeInnertubeProvider=allocatedProvider\.costDomain==='YOUTUBE_INNERTUBE_FREE'/);
  assert.match(queue, /braveProvider=allocatedProvider\.costDomain==='BRAVE_SEARCH_API'/);
  assert.match(queue, /settleProviderRequest\(providerRequestId!, 'SUCCEEDED', providerCostUsd\)/);
  assert.match(queue, /providerPageCostUnits: providerQuotaUnits/);
});

test('Q6: a country with zero confirmed creators still bootstraps, but nothing promotes without evidence', () => {
  const planned = planDiverseQueries({
    country: 'Germany', count: 5, learnedVocabulary: [], existingQueries: [],
  });
  assert.ok(planned.length > 0);
  assert.ok(planned.every(query => !(query.metadata.sourceTypes as string[]).includes('TERMINOLOGY')));
  const decision = decideLifecycleV2({
    ...baseLifecycle, current: 'CANDIDATE', decayedEvidence: 0,
    nativeCreators: 0, nativeEvidenceBuckets: 0,
    externalSources: 0, externalSourceCount: 0, externalEligible: false,
  });
  assert.equal(decision.status, 'CANDIDATE');
  assert.equal(decision.searchEligible, false);
});

// ---------------------------------------------------------------------------
// O. Activation and observability (4)
// ---------------------------------------------------------------------------

test('O1: migration 161 activates core paths, keeps paid demand off, and preserves unrelated settings', () => {
  const migration = migration161();
  for (const setting of [
    'country_discovery_loop_enabled',
    'autonomous_pagination_enabled',
    'autonomous_pagination_v2_enabled',
    'native_evidence_promotion_v2_enabled',
    'native_vocabulary_extraction_enabled',
    'free_query_signals_enabled',
  ]) {
    assert.match(migration, new RegExp(`\\('${setting}', 'true'\\)`));
  }
  assert.match(migration, /\('query_demand_signals_enabled', 'false'\)/);
  assert.match(migration, /WHERE setting_key = 'autonomous_pagination_max_pages'\s+AND setting_value = '10'/);
  assert.match(migration, /ON CONFLICT\(setting_key\) DO NOTHING/);
  assert.ok(!/^\s*\('youtube_key_daily_cap_enforced'/m.test(migration));
  assert.ok(!/setting_key\s*=\s*'youtube_key_daily_cap_enforced'/m.test(migration));
  assert.ok(!/^\s*\('discovery_extraction_enabled'/m.test(migration));
  for (const preserved of ['frontier_allocation_enabled', 'adaptive_discovery_pilot_enabled']) {
    const assignments = migration.split('\n').filter(line => line.includes(preserved) && !line.trim().startsWith('--'));
    assert.deepEqual(assignments, [], `${preserved} is preserved and never assigned`);
  }
  assert.ok(!/DROP TABLE|DROP COLUMN|DELETE FROM/.test(migration));
});

test('O2: a failed migration, orphan page, or provider canary makes the deploy gate unhealthy', () => {
  const migration = evaluateCountryDiscoveryHealth(healthyHealthInput({ migrationApplied: false }));
  assert.equal(migration.healthy, false);
  assert.equal(migration.status, 'UNHEALTHY');
  assert.equal(migration.checks.find(check => check.id === 'migration_161')?.status, 'FAIL');

  const orphan = evaluateCountryDiscoveryHealth(healthyHealthInput({ orphanPendingPages: 2, oldestOrphanAgeMinutes: 42 }));
  assert.equal(orphan.healthy, false);
  assert.equal(orphan.checks.find(check => check.id === 'orphan_pending_pages')?.status, 'FAIL');

  const canary = evaluateCountryDiscoveryHealth(healthyHealthInput({ providerCanaryOk: false }));
  assert.equal(canary.healthy, false);
  assert.equal(canary.checks.find(check => check.id === 'provider_canary')?.status, 'FAIL');

  const invalidScope = evaluateCountryDiscoveryHealth(healthyHealthInput({
    settings: { ...healthySettings(), query_intelligence_discovery_scope: 'SELECTED' },
  }));
  assert.equal(invalidScope.healthy, false, 'an invalid persisted scope stops scheduling and must fail health');
  assert.equal(invalidScope.checks.find(check => check.id === 'discovery_scope')?.status, 'FAIL');
  assert.match(invalidScope.checks.find(check => check.id === 'discovery_scope')?.detail || '', /GLOBAL or SELECTED_COUNTRIES/);

  const invalidSelection = evaluateCountryDiscoveryHealth(healthyHealthInput({
    settings: { ...healthySettings(), query_intelligence_discovery_scope: 'SELECTED_COUNTRIES', query_intelligence_selected_countries: '{not-json' },
  }));
  assert.equal(invalidSelection.healthy, false);
  assert.equal(invalidSelection.checks.find(check => check.id === 'discovery_scope')?.status, 'FAIL');

  const providerSpike = evaluateCountryDiscoveryHealth(healthyHealthInput({ providerErrorRate: 0.3 }));
  assert.equal(providerSpike.healthy, false);
  assert.equal(providerSpike.checks.find(check => check.id === 'provider_spike')?.status, 'FAIL');

  const duplicateWindows = evaluateCountryDiscoveryHealth(healthyHealthInput({
    duplicateRatioWindows: { recent: 0.95, prior: 0.92 },
  }));
  assert.equal(duplicateWindows.healthy, false);
  assert.equal(duplicateWindows.checks.find(check => check.id === 'duplicate_ratio_two_windows')?.status, 'FAIL');

  const wrongCountryWindows = evaluateCountryDiscoveryHealth(healthyHealthInput({
    wrongCountryPrecisionWindows: { recent: 0.3, prior: 0.4 },
  }));
  assert.equal(wrongCountryWindows.healthy, false);
  assert.equal(wrongCountryWindows.checks.find(check => check.id === 'wrong_country_two_windows')?.status, 'FAIL');

  // An empty window is unknown, not a healthy zero: no check is emitted when
  // neither window has observations, and one measured window can only WARN.
  const unmeasured = evaluateCountryDiscoveryHealth(healthyHealthInput({
    duplicateRatioWindows: { recent: null, prior: null },
    wrongCountryPrecisionWindows: { recent: null, prior: null },
  }));
  assert.equal(unmeasured.checks.some(check => check.id === 'duplicate_ratio_two_windows'), false);
  assert.equal(unmeasured.checks.some(check => check.id === 'wrong_country_two_windows'), false);
  const oneMeasured = evaluateCountryDiscoveryHealth(healthyHealthInput({
    duplicateRatioWindows: { recent: null, prior: 0.95 },
  }));
  assert.equal(oneMeasured.checks.find(check => check.id === 'duplicate_ratio_two_windows')?.status, 'WARN');
  assert.match(String(oneMeasured.checks.find(check => check.id === 'duplicate_ratio_two_windows')?.detail), /not measured/);

  const quotaSpike = evaluateCountryDiscoveryHealth(healthyHealthInput({
    quotaDeferralsRecent: 20,
    quotaDeferralsPrior: 2,
  }));
  assert.equal(quotaSpike.healthy, true);
  assert.equal(quotaSpike.status, 'DEGRADED');
  assert.equal(quotaSpike.checks.find(check => check.id === 'quota_reservation_failures')?.status, 'WARN');

  const aiSkips = evaluateCountryDiscoveryHealth(healthyHealthInput({ aiBudgetSkips: 20, aiCalls: 30 }));
  assert.equal(aiSkips.status, 'DEGRADED');
  assert.equal(aiSkips.checks.find(check => check.id === 'ai_budget_skips')?.status, 'WARN');

  const uaMissing = evaluateCountryDiscoveryHealth(healthyHealthInput({ wikimediaUserAgentConfigured: false }));
  assert.equal(uaMissing.status, 'DEGRADED');
  assert.equal(uaMissing.checks.find(check => check.id === 'wikimedia_user_agent')?.status, 'WARN');

  const coverage = evaluateCountryDiscoveryHealth(healthyHealthInput({ activeCountriesWithoutPage: 1 }));
  assert.equal(coverage.status, 'DEGRADED');
  assert.equal(coverage.checks.find(check => check.id === 'active_country_coverage')?.status, 'WARN');

  const healthSource = serverSource('countryDiscoveryHealth.ts');
  for (const id of [
    'quota_reservation_failures',
    'duplicate_ratio_two_windows',
    'wrong_country_two_windows',
    'provider_spike',
    'ai_budget_skips',
    'active_country_coverage',
    'wikimedia_user_agent',
  ]) {
    assert.match(healthSource, new RegExp(id));
  }
  assert.match(healthSource, /resolveAutonomousCountries/);
  assert.match(healthSource, /WIKIMEDIA_USER_AGENT_ENV/);
  assert.match(healthSource, /isContactBearingWikimediaUserAgent/, 'a placeholder agent must not pass the prerequisite');
  // The canary must count discovery search calls only; unrelated Gemini/Groq
  // telemetry must not make search look unhealthy.
  assert.match(healthSource, /provider IN \('youtube','youtube-innertube'\) AND operation='search'/);
  assert.match(healthSource, /provider='brave-search' AND operation='search'/);
  // Empty windows stay NULL through aggregation and are skipped by evaluator.
  assert.match(healthSource, /\(AVG\(duplicate_ratio\) FILTER/);
  assert.match(healthSource, /recent: safetyRow\.duplicate_recent == null \? null/);
  // Pending age is filtered to pending runs: completed runs must not inflate
  // the age of an idle country. Official YouTube telemetry and run usage use
  // different provider names, so the metrics join normalizes them.
  assert.match(
    healthSource,
    /FILTER \(WHERE qr\.continuation_status IN \('RUNNING','DEFERRED_QUOTA','DEFERRED_TIME'\)\),0\)::float AS oldest_pending_age_minutes/,
  );
  assert.match(healthSource, /provider_key='youtube-search' THEN 'youtube'/);

  const server = serverSource('../server.ts');
  assert.match(server, /app\.get\('\/api\/country-discovery\/health'/);
  assert.match(server, /res\.status\(report\.healthy \? 200 : 503\)\.json\(report\)/);
});

test('O2b: missing migration/schema is reported without querying dependent tables', async () => {
  const calls: string[] = [];
  const runner = {
    query: async (text: string) => {
      calls.push(text);
      if (text.includes('FROM app_settings')) return { rows: [] };
      if (text.includes('schema_migrations')) return { rows: [] };
      if (text.includes('information_schema.columns')) return { rows: [] };
      throw new Error(`unexpected dependent query: ${text.slice(0, 60)}`);
    },
  };
  const report = await gatherCountryDiscoveryHealth(runner as never);
  assert.equal(report.status, 'UNHEALTHY');
  assert.equal(report.checks.find(check => check.id === 'migration_161')?.status, 'FAIL');
  assert.equal(report.checks.find(check => check.id === 'required_schema')?.status, 'FAIL');
  assert.equal(calls.some(text => /FROM query_runs|FROM native_vocabulary_ai_runs|FROM autonomous_query_page_observations|FROM provider_call_events/.test(text)), false,
    'dependent queries must not run before schema readiness is established');
});

test('O3: page, run, country, source, provider, AI, and lifecycle metrics are queryable without nulls', async () => {
  const runner = {
    query: async (text: string) => {
      if (text.includes('pages_last_24h')) {
        return {
          rows: [{
            pages: 5, pages_last_24h: 3, raw_results: 500, distinct_creators: 100,
            new_creators: 40, confirmed_creators: 20, quality_creators: 10, cross_page_repeats: 5,
            average_duplicate_ratio: 0.2, average_country_precision: 0.9, average_trading_precision: 0.7,
            average_relevance: 0.8, quota_units: 300, provider_cost_usd: 1.5,
            average_elapsed_ms: 120, average_retrieval_ms: 80, average_processing_ms: 40,
            average_marginal_utility: 0.4, missing_decisions: 0, resumed_pages: 2, deferred_pages: 1,
            runs: 2, running: 1, deferred_quota: 0, deferred_time: 0, complete: 1, failed: 0,
            pages_completed: 7, average_effective_max_pages: 4, run_quota_budget_units: 900,
            run_quota_consumed_units: 700, cumulative_unique_creators: 90, run_confirmed_creators: 18,
            run_quality_creators: 9, resume_count: 3, resume_rewalks: 1, continuation_segments: 0,
            elapsed_seconds: 1200,
          }],
        };
      }
      if (text.includes('SELECT primary_reason')) {
        return { rows: [{ primary_reason: 'CONTINUE_PRODUCTIVE', count: 3 }] };
      }
      if (text.includes('LEFT JOIN LATERAL')) {
        return { rows: [{ reason: 'NO_NEXT_PAGE', count: 1 }] };
      }
      if (text.includes('GROUP BY qr.country')) {
        return {
          rows: [{
            country: 'Germany', runs: 2, queries_executed: 5, queries_generated: 20,
            pages: 5, quota_units: 300, new_creators: 4, confirmed_creators: 2,
            quality_creators: 1, wrong_country_share: 0.1, duplicate_rate: 0.2,
            pending_continuations: 1, oldest_pending_age_minutes: 2,
          }],
        };
      }
      if (text.includes('zero_yield_streak')) {
        return { rows: [{ country: 'Germany', zero_yield_streak: 2 }] };
      }
      if (text.includes("generation_metadata->>'source'")) {
        return {
          rows: [{
            source: 'MIXED', runs: 2, pages: 5, new_creators: 4, confirmed_creators: 2,
            quality_creators: 1, acceptance_rate: 0.6, cost_per_quality_creator: 0.15,
          }],
        };
      }
      if (text.includes('PERCENTILE_CONT')) {
        return {
          rows: [{
            provider: 'youtube-search', calls: 10, successes: 8, errors: 1, rate_limited: 0,
            timeouts: 1, average_latency_ms: 100, p50_latency_ms: 90, p95_latency_ms: 200,
            cost_usd: 0.5, pages: 4, quota_units: 400, provider_cost_usd: 0.4,
          }],
        };
      }
      if (text.includes('native_vocabulary_ai_runs') && text.includes('GROUP BY country')) {
        return { rows: [{ country: 'Germany', calls: 2, actual_cost: 500 }] };
      }
      if (text.includes('native_vocabulary_ai_runs')) {
        return { rows: [{ calls: 4, attempts: 6, budget_skips: 1, successes: 3, failures: 0, actual_cost: 1000 }] };
      }
      if (text.includes('FROM terminology_observations')) {
        return { rows: [{ observations: 10, promotion_eligible: 4 }] };
      }
      if (text.includes('FROM canonical_trading_terms')) {
        return {
          rows: [
            { lifecycle_status: 'PROVEN_SEARCH_TERM', count: 2 },
            { lifecycle_status: 'SEARCH_TRIAL', count: 3 },
            { lifecycle_status: 'DEMOTED', count: 1 },
          ],
        };
      }
      if (text.includes('terminology_lifecycle_events')) {
        return { rows: [{ promotions: 3, demotions: 1 }] };
      }
      if (text.includes('terminology_performance')) {
        return { rows: [{ unique_creators: 100, wrong_country_creators: 5, needs_review_creators: 10 }] };
      }
      return { rows: [] };
    },
  };
  const metrics = await gatherCountryDiscoveryMetrics(runner as never);
  assert.equal(metrics.page.pages, 5);
  assert.equal(metrics.page.pagesLast24h, 3);
  assert.equal(metrics.page.rawResults, 500);
  assert.equal(metrics.page.averageRetrievalMs, 80);
  assert.equal(metrics.page.resumedPages, 2);
  assert.equal(metrics.page.decisions[0].reason, 'CONTINUE_PRODUCTIVE');
  assert.equal(metrics.page.missingDecisions, 0);
  assert.equal(metrics.run.pagesCompleted, 7);
  assert.equal(metrics.run.cumulativeUniqueCreators, 90);
  assert.equal(metrics.run.resumeRewalks, 1);
  assert.equal(metrics.run.stopReasons[0].reason, 'NO_NEXT_PAGE');
  assert.equal(metrics.countries.length, 1);
  assert.equal(metrics.countries[0].country, 'Germany');
  assert.equal(metrics.countries[0].queriesGenerated, 20);
  assert.equal(metrics.countries[0].zeroYieldStreak, 2);
  assert.equal(metrics.countries[0].quotaUnits, 300);
  assert.equal(metrics.sources.length, 1);
  assert.equal(metrics.sources[0].source, 'MIXED');
  assert.equal(metrics.sources[0].acceptanceRate, 0.6);
  assert.equal(metrics.sources[0].costPerQualityCreator, 0.15);
  assert.equal(metrics.providers.length, 1);
  assert.equal(metrics.providers[0].p95LatencyMs, 200);
  assert.equal(metrics.providers[0].successRate, 0.8);
  assert.equal(metrics.ai.calls, 4);
  assert.equal(metrics.ai.attempts, 6);
  assert.equal(metrics.ai.budgetSkips, 1);
  assert.equal(metrics.ai.countries[0].country, 'Germany');
  assert.equal(metrics.lifecycle.observations, 10);
  assert.equal(metrics.lifecycle.promotionEligible, 4);
  assert.equal(metrics.lifecycle.promotionEligibleShare, 0.4);
  assert.equal(metrics.lifecycle.stages.PROVEN_SEARCH_TERM, 2);
  assert.equal(metrics.lifecycle.stages.DEMOTED, 1);
  assert.equal(metrics.lifecycle.stageConversion.PROVEN_SEARCH_TERM, 0.4);
  assert.equal(metrics.lifecycle.stageConversion.SEARCH_TRIAL, 1);
  assert.equal(metrics.lifecycle.stageConversion.CANDIDATE, 1);
  assert.equal(metrics.lifecycle.promotions, 3);
  assert.equal(metrics.lifecycle.demotions, 1);
  assert.equal(metrics.lifecycle.wrongCountryShare, 0.05);
  assert.equal(metrics.lifecycle.reviewShare, 0.1);
  assert.ok(!JSON.stringify(metrics).includes('null'), 'required metric fields are non-null');

  // Dashboard/health readers coalesce through a short TTL; explicit runners
  // (tests, diagnostics) always read live data.
  const healthSource = serverSource('countryDiscoveryHealth.ts');
  assert.match(healthSource, /METRICS_CACHE_TTL_MS = 30_000/);
  assert.match(healthSource, /if \(clientOverride\) return gatherCountryDiscoveryMetricsUncached\(clientOverride\)/);
  assert.match(healthSource, /resetCountryDiscoveryMetricsCacheForTests/);
});

test('O4: each kill switch disables only its path and leaves data/rollback intact', async () => {
  assert.equal(await isTerminologyKillSwitchActive({ readSetting: async () => 'true' }), true);
  assert.equal(await isTerminologyKillSwitchActive({ readSetting: async () => ' false ' }), false);
  assert.equal(await isTerminologyKillSwitchActive({ readSetting: async () => { throw new Error('settings unavailable'); } }), false);

  const oneOff = evaluateCountryDiscoveryHealth(healthyHealthInput({
    settings: { ...healthySettings(), free_query_signals_enabled: 'false' },
  }));
  assert.equal(oneOff.healthy, true);
  assert.equal(oneOff.status, 'DEGRADED');
  const killSwitch = oneOff.checks.find(check => check.id === 'core_kill_switches');
  assert.equal(killSwitch?.status, 'WARN');
  assert.match(String(killSwitch?.detail), /free_query_signals_enabled/);
  assert.match(String(killSwitch?.detail), /Data remains intact and only that path is off/);

  const paidOn = evaluateCountryDiscoveryHealth(healthyHealthInput({
    settings: { ...healthySettings(), query_demand_signals_enabled: 'true' },
  }));
  assert.equal(paidOn.healthy, false);
  assert.equal(paidOn.status, 'UNHEALTHY');

  const migration = migration161();
  assert.ok(!/DROP TABLE|DROP COLUMN|DELETE FROM/.test(migration));
  assert.match(migration, /It never drops a table\/column/);
});

// ---------------------------------------------------------------------------
// R. Recovery and safety (3)
// ---------------------------------------------------------------------------

test('R1: transient AI failure retries up to three attempts while rule evidence stays durable', () => {
  const source = serverSource('queryIntelligence.ts');
  assert.match(source, /async function callGeminiSafe<T>\(promptFn: \(\) => Promise<T>, retries = 2, delayMs = 1500\)/);
  assert.match(source, /for \(let attempt = 0; attempt <= retries; attempt\+\+\)/);
  assert.match(source, /e\?\.status === 429/);
  assert.match(source, /errStr\.includes\('RESOURCE_EXHAUSTED'\)/);
  const ruleHitsAt = source.indexOf('for (const hit of findRuleInstrumentHits(');
  const reservationAt = source.indexOf('reservation = await reserveNativeVocabularyAiRun(');
  assert.ok(ruleHitsAt > 0 && reservationAt > ruleHitsAt, 'rule evidence is durable before the AI reservation');

  // The logical call is not marked successful until admission persists its
  // terms. The parsed response is durable first, so a persistence retry
  // replays it without another provider request.
  assert.match(source, /recordNativeVocabularyAiResponse\(\{/);
  assert.match(source, /provider: parsedSource,/);
  assert.match(source, /reservation\?\.reason === 'REPLAY_RESPONSE'/);
  assert.match(source, /if \(!parsed\) \{\s*await finishAiRun\('FAILED'/);
  assert.match(source, /onRequestAttempt: \(\) => \{/);
  const db = serverSource('dbCore.ts');
  assert.match(db, /NATIVE_VOCABULARY_AI_LEASE_SECONDS = 15 \* 60/);
  assert.match(db, /reason: 'REPLAY_RESPONSE'/);
  assert.match(db, /provider=COALESCE\(\$5,provider\)/, 'the provider is durable with the response');
  assert.match(db, /provider: existingRow\.provider/, 'replay restores the recorded provider');
  assert.match(db, /actual_cost_microunits=actual_cost_microunits\+\$5/);
  // Lease fencing: response and completion writes present the admission token,
  // so a worker whose reservation was reclaimed cannot mutate the replacement.
  assert.match(db, /lease_token=\$6/);
  assert.match(db, /lease_token=\$2, lease_expires_at/);
  assert.match(db, /reason: 'RESERVED', requestId: args\.requestId, leaseToken/);
  assert.match(db, /args\.leaseToken/);
  // Retained spend is counted on RESERVED rows too, not hidden until the
  // replacement reservation completes. The exported snapshot must use the
  // same all-status sum as admission, or it reports less spend than the cap.
  assert.match(db, /COALESCE\(SUM\(actual_cost_microunits\),0\)::bigint AS actual_cost/);
  const snapshotStart = db.indexOf('export async function getNativeVocabularyAiBudgetSnapshot');
  const snapshotEnd = db.indexOf('async function readNativeVocabularyAiBudgetPolicy');
  assert.ok(snapshotStart > 0 && snapshotEnd > snapshotStart);
  const snapshotSource = db.slice(snapshotStart, snapshotEnd);
  assert.match(snapshotSource, /COALESCE\(SUM\(actual_cost_microunits\),0\)::bigint AS actual_cost/);
  assert.ok(!/SUM\(actual_cost_microunits\) FILTER/.test(snapshotSource), 'snapshot actual cost must not filter by status');
  // A reservation with zero provider attempts is released instead of charged
  // or counted against the daily call cap. A reopened reservation that already
  // carries actual spend from its expired owner must keep that spend and its
  // call-cap slot, or later calls can reuse budget that was already spent.
  assert.match(db, /export async function releaseNativeVocabularyAiRun/);
  const releaseStart = db.indexOf('export async function releaseNativeVocabularyAiRun');
  const releaseEnd = db.indexOf('export interface QueryRunProgress', releaseStart);
  assert.ok(releaseStart > 0 && releaseEnd > releaseStart);
  const releaseSource = db.slice(releaseStart, releaseEnd);
  assert.match(releaseSource, /status=CASE WHEN actual_cost_microunits > 0 THEN 'FAILED' ELSE 'BUDGET_SKIPPED' END/);
  assert.match(releaseSource, /reserved_cost_microunits=0/);
  assert.ok(!/actual_cost_microunits\s*=\s*0/.test(releaseSource), 'release must preserve retained actual spend');
  assert.match(source, /aiRun\.attempts === 0/);
  assert.match(source, /releaseNativeVocabularyAiRun/);
  // A ledger outage degrades to rule-only extraction after rule evidence is
  // already durable; it must not abort creator ingestion.
  assert.match(source, /AI budget ledger unavailable/);
  assert.match(source, /try \{\s*reservation = await reserveNativeVocabularyAiRun/);
  assert.match(source, /ownsReservation/);
  assert.match(source, /leaseToken: aiRun\.leaseToken/);
  assert.match(source, /leaseToken: replayRun\.leaseToken/);
  assert.match(source, /attemptedProvider = 'GEMINI'/);
  assert.match(source, /finishAiRun\('FAILED', attemptedProvider\)/);
  const ledgerMigration = migration161();
  assert.match(ledgerMigration, /response_payload JSONB/);
  assert.match(ledgerMigration, /lease_expires_at TIMESTAMPTZ/);
  assert.match(ledgerMigration, /lease_token TEXT/);

  const base = {
    canonicalTermId: 7, channelId: 'ch-1', videoId: 'vid-1', observationType: 'VIDEO_TITLE',
    evidence: { qualityVersion: 'native-v1', novel: true, sourceRef: { kind: 'VIDEO_TITLE', index: 0, span: 'Charttechnik', videoId: 'vid-1' } },
  };
  assert.equal(computeObservationKey(base), computeObservationKey(base));
  assert.match(serverSource('terminologyIntelligence.ts'), /ON CONFLICT\(observation_key\) DO UPDATE SET/);
});

test('R2: the terminology kill switch stops rule/AI extraction and planner serving with no DB/provider calls', async () => {
  const channel = {
    channel_id: 'ch-1', channel_name: 'DAX Analyse', country: 'Germany',
    trading_status: 'TRADING_CONFIRMED',
  } as unknown as ChannelRecord;
  const extracted = await extractVocabularyFromCreator(
    channel, ['DAX Analyse'], 'description', false, undefined, undefined, undefined,
    { isKillSwitchActive: async () => true },
  );
  assert.deepEqual(extracted, []);

  let queries = 0;
  const runner = {
    query: async () => { queries += 1; return { rows: [] }; },
  };
  const planned = await getPlannerTerminology('Germany', runner as never, { isKillSwitchActive: async () => true });
  assert.deepEqual(planned, []);
  assert.equal(queries, 0);

  const source = serverSource('queryIntelligence.ts');
  assert.ok(source.indexOf('isTerminologyKillSwitchActive') < source.indexOf('getAIClient()'));
});

test('R3: an optional paid-provider failure cannot block the free-first cycle or consume YouTube quota', () => {
  const planned = planDiverseQueries({
    country: 'Germany', count: 4, learnedVocabulary: [], existingQueries: [],
    demandSignalCandidates: [],
  });
  assert.ok(planned.length > 0);
  assert.ok(planned.every(query => query.metadata.source !== 'DEMAND_SIGNAL'));
  assert.ok(planned.every(query => !(query.metadata.sourceTypes as string[]).includes('DEMAND_SIGNAL')));

  // Demand signals are supplementary: a small portfolio may have no room for
  // them. Forcing one candidate violates the 30% share instead of enforcing it.
  assert.deepEqual(capDemandSignalCandidates(['a', 'b', 'c'], 3), []);
  assert.deepEqual(capDemandSignalCandidates(['a', 'b', 'c'], 4), ['a']);

  const migration = migration161();
  assert.match(migration, /\('query_demand_signals_enabled', 'false'\)/);
  const health = evaluateCountryDiscoveryHealth(healthyHealthInput({
    settings: { ...healthySettings(), query_demand_signals_enabled: 'true' },
  }));
  assert.equal(health.healthy, false);

  const source = serverSource('queryIntelligence.ts');
  const start = source.indexOf('const demandSignalsEnabled');
  const end = source.indexOf('const planned = planDiverseQueries');
  const block = source.slice(start, end);
  assert.match(block, /query_demand_signals_enabled', 'false'/);
  assert.ok(
    !/tryReserveQuota\(|fetch\(|reserveProviderRequest\(|settleProviderRequest\(|searchYouTube/.test(block),
    'paid signal read has no quota/provider side effect',
  );
  assert.ok(!serverSource('queueManager.ts').includes('query_demand_signals'));
});
