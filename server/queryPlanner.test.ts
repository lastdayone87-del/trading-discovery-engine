import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtractedTermRecord, QueryRecord } from '../src/types';
import { isCountryScriptCompatible, isRetrievalOrientedQuery, limitRepeatedPrimaryTerms, normalizeQuery, planDiverseQueries, planFrontierTargetedQuery, queriesOutsideCooldown, queryTokenCount, rotateAwayFromMostRecentIntent } from './queryPlanner';
import { ORGANIC_QUERY_POLICY_VERSION } from './organicQueryExpansion';

function query(overrides: Partial<QueryRecord>): QueryRecord {
  return {
    id: overrides.id || 1,
    query: overrides.query || 'DAX market analysis',
    country: overrides.country || 'Germany',
    collection: overrides.collection || 'EXPERIMENTAL',
    intent: overrides.intent || 'market_analysis',
    times_executed: overrides.times_executed || 0,
    total_channels_found: 0,
    unique_channels_found: 0,
    quality_channels_found: 0,
    community_channels_found: 0,
    avg_quality_score: 0,
    performance_score: overrides.performance_score || 0,
    created_at: overrides.created_at || '2026-01-01T00:00:00.000Z',
    status: 'ACTIVE',
    ...overrides
  };
}

function term(id: number, value: string, tier: 2 | 3, occurrences: number): ExtractedTermRecord {
  return { id, country: 'Germany', term: value, category: 'terminology', occurrences, first_extracted: '2026-01-01T00:00:00.000Z', last_extracted: '2026-01-02T00:00:00.000Z', trust_tier: tier, validation_count: tier === 2 ? occurrences : 0 };
}

test('frontier targeted fallback preserves a valid canonical term and rejects unsafe prose', () => {
  const planned = planFrontierTargetedQuery({
    country: 'Australia',
    target: {
      country: 'Australia', language: null, queryIntent: 'market_analysis', primaryTermFamily: 'ASX analysis',
      retrievalLane: 'VIDEO', searchOrdering: 'RELEVANCE', instrumentOrTheme: null, sourceFamily: 'automated_query'
    }
  });
  assert.equal(planned?.query, 'ASX analysis');
  assert.equal(planned?.metadata.queryTemplate, 'FRONTIER_TARGETED');
  assert.equal(planFrontierTargetedQuery({
    country: 'Australia',
    target: {
      country: 'Australia', language: null, queryIntent: 'education', primaryTermFamily: 'investor education weekly market update',
      retrievalLane: 'VIDEO', searchOrdering: 'RELEVANCE', instrumentOrTheme: null, sourceFamily: 'automated_query'
    }
  }), null);
});

test('hard cooldown removes identical historical queries from eligibility', () => {
  const now = new Date('2026-07-28T12:00:00.000Z');
  const recent = query({ id: 1, last_executed: '2026-07-28T11:00:00.000Z' });
  const old = query({ id: 2, query: 'DAX futures education', last_executed: '2026-07-28T03:00:00.000Z' });
  assert.deepEqual(queriesOutsideCooldown([recent, old], now, 360).map(item => item.id), [2]);
  const duplicateWithDifferentCase = query({ id: 3, query: ` ${recent.query.toUpperCase()} `, last_executed: null });
  assert.deepEqual(queriesOutsideCooldown([recent, duplicateWithDifferentCase, old], now, 360).map(item => item.id), [2]);
});

test('primary-term limiter blocks an overused pattern while preserving alternatives', () => {
  const now = new Date('2026-07-28T12:00:00.000Z');
  const overused = query({ id: 1, primary_term: 'market analysis', last_executed: '2026-07-28T11:00:00.000Z' });
  const secondUse = query({ id: 2, query: 'DAX market analysis live', primary_term: 'market analysis', last_executed: '2026-07-28T10:00:00.000Z' });
  const candidateA = query({ id: 3, query: 'AEX market analysis', primary_term: 'market analysis' });
  const candidateB = query({ id: 4, query: 'Options risk lesson', primary_term: 'options risk analysis' });
  assert.deepEqual(limitRepeatedPrimaryTerms([candidateA, candidateB], [overused, secondUse], now, 360, 2).map(item => item.id), [4]);
});

test('intent rotation avoids immediately repeating the most recently executed intent', () => {
  const recent = query({ id: 1, intent: 'forex', last_executed: '2026-07-28T11:00:00.000Z' });
  const forex = query({ id: 2, query: 'EURUSD lesson', intent: 'forex' });
  const psychology = query({ id: 3, query: 'Trading discipline', intent: 'psychology' });
  assert.deepEqual(rotateAwayFromMostRecentIntent([forex, psychology], [recent]).map(item => item.id), [3]);
});

test('planner creates short, unique, attributable retrieval queries', () => {
  const planned = planDiverseQueries({
    country: 'Germany',
    count: 15,
    countryVocabulary: {
      country: 'Germany', languages: ['German'], native_trading_terminology: ['Börsenanalyse', 'Marktstruktur'],
      popular_instruments: ['DAX 40', 'Bund Futures'], local_market_phrases: ['Börse Frankfurt'], common_content_format_names: ['Tagesanalyse', 'Morgenbriefing']
    },
    learnedVocabulary: [term(1, 'Liquiditätszone', 2, 4), term(2, 'Creator catchphrase', 3, 1)],
    existingQueries: [],
    mode: 'COLD_START'
  });
  assert.equal(planned.length, 15);
  assert.equal(new Set(planned.map(item => normalizeQuery(item.query))).size, 15);
  assert.ok(new Set(planned.map(item => item.intent)).size >= 4);
  assert.ok(planned.every(item => queryTokenCount(item.query) <= 3));
  assert.ok(planned.every(item => isRetrievalOrientedQuery('Germany', item.query)));
  assert.ok(planned.every(item => item.knowledgeTiers.includes(1)));
  assert.ok(planned.every(item => item.generationReason && item.discoveryObjective && item.primaryTerm));
  assert.ok(planned.every(item => Array.isArray(item.metadata.atoms) && item.metadata.retrievalOptimized === true));
  assert.ok(planned.some(item => item.knowledgeTiers.includes(2)));
  assert.ok(planned.every(item => !item.query.toLowerCase().includes('creator catchphrase')));
  assert.ok(planned.filter(item => item.knowledgeTiers.includes(3)).length <= Math.ceil(planned.length / 5));
});

test('planner uses native compact vocabulary in every supported market', () => {
  const expected: Record<string, RegExp> = {
    'United States': /NQ Futures|ES Futures|Order Flow/,
    'United Kingdom': /FTSE Trading|GBPUSD|London Session/,
    Germany: /DAX Analyse|Börsenanalyse|Technische Analyse/,
    France: /CAC40 Analyse|Analyse Technique|Euronext/,
    Spain: /IBEX35|Análisis Técnico|Trading Forex/,
    Netherlands: /AEX Trading|Technische Analyse|Opties Handelen/,
    Italy: /FTSE MIB|Analisi Tecnica|Trading Futures/,
    Australia: /ASX Trading|ASX 200|AUDUSD/,
    Canada: /TSX Trading|TSX 60|USDCAD/,
    Japan: /日経225|FX トレード|オーダーフロー/
  };
  for (const [country, pattern] of Object.entries(expected)) {
    const planned = planDiverseQueries({ country, count: 5, learnedVocabulary: [], existingQueries: [] });
    assert.equal(planned.length, 5, country);
    assert.ok(planned.some(item => pattern.test(item.query)), country);
    assert.ok(planned.every(item => queryTokenCount(item.query) <= 3), country);
    assert.ok(planned.every(item => isCountryScriptCompatible(country, item.query)), country);
  }
});

test('script policy rejects cross-market scripts and Japanese prose-like Latin text', () => {
  assert.equal(isCountryScriptCompatible('France', '日経225'), false);
  assert.equal(isCountryScriptCompatible('Japan', 'market analysis lesson'), false);
  assert.equal(isCountryScriptCompatible('Japan', 'USDJPY'), true);
  assert.equal(isCountryScriptCompatible('Japan', 'テクニカル分析'), true);
});

test('planner never emits the previous descriptive multi-concept pattern', () => {
  const planned = planDiverseQueries({
    country: 'France', count: 10, learnedVocabulary: [], existingQueries: [],
    countryVocabulary: {
      country: 'France', languages: ['French'], native_trading_terminology: ['analyse technique'],
      popular_instruments: ['CAC 40'], local_market_phrases: ['Ouverture Bourse de Paris'],
      common_content_format_names: ['Analyse hebdomadaire', 'Debriefing marché']
    }
  });
  assert.ok(planned.every(item => !/AMF France strategy breakdown|Euronext Paris weekly market review/i.test(item.query)));
  assert.ok(planned.every(item => item.query.length <= 40 && queryTokenCount(item.query) <= 3));
});

test('planner never recreates an existing normalized query', () => {
  const baseline = planDiverseQueries({ country: 'France', count: 1, learnedVocabulary: [], existingQueries: [] })[0];
  const next = planDiverseQueries({ country: 'France', count: 3, learnedVocabulary: [], existingQueries: [query({ query: `  ${baseline.query.toUpperCase()}  `, country: 'France' })] });
  assert.ok(next.every(item => normalizeQuery(item.query) !== normalizeQuery(baseline.query)));
});

test('planner expands from governed multisource concepts with complete provenance', () => {
  const planned = planDiverseQueries({ country: 'Spain', count: 4, learnedVocabulary: [], existingQueries: [], organicCandidates: [{
    candidateId: 'playlist-topic-1', conceptId: 'concept-market-profile', surface: 'Perfil de mercado', sourceType: 'PLAYLIST_TOPIC',
    sourceRefs: ['playlist:PL1:title:0-17', 'video:V2:title:5-22'], independentSourceIds: ['creator:A', 'creator:B'],
    language: 'es', script: 'Latn', locale: 'es-ES', intent: 'strategy', lifecycle: 'PROVEN',
    validation: { language: true, script: true, safety: true, retrievalShape: true, policyVersion: ORGANIC_QUERY_POLICY_VERSION },
    catalog: { versionId: 'catalog-v7', checksum: 'catalog-checksum', pointerVersion: 3 }
  }] });
  const organic = planned.find(item => item.metadata.queryTemplate === 'ANCHOR_ORGANIC');
  assert.match(organic?.query||'',/Perfil de mercado/);
  assert.deepEqual((organic?.metadata.organicProvenance as any).sourceRefs, ['playlist:PL1:title:0-17', 'video:V2:title:5-22']);
  assert.equal((organic?.metadata.organicProvenance as any).conceptId, 'concept-market-profile');
});
