import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtractedTermRecord, QueryRecord } from '../src/types';
import { isCountryScriptCompatible, isRetrievalOrientedQuery, limitRepeatedPrimaryTerms, normalizeQuery, planCountryNativeProposalQuery, planDiverseQueries, planFrontierTargetedQuery, queriesOutsideCooldown, queryTokenCount, rotateAwayFromMostRecentIntent } from './queryPlanner';
import { ORGANIC_QUERY_POLICY_VERSION } from './organicQueryExpansion';
import { evaluateAutonomousQueryAuthority } from './autonomousQueryAuthority';
import { admitQueryRecord } from './queryQuality/admission';

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
  assert.equal(planned?.query, 'trading ASX analysis');
  assert.equal(planned?.metadata.queryTemplate, 'ANCHOR_LEARNED');
  assert.equal((planned?.metadata as any).retrievalSpecificity?.eligibility, 'STANDALONE');
  assert.equal((planned?.metadata as any).atoms?.length, 2);
  assert.equal((planned?.metadata as any).atoms?.[0]?.role, 'ANCHOR');
  assert.equal((planned?.metadata as any).atoms?.[1]?.role, 'MODIFIER');
  assert.equal(planFrontierTargetedQuery({
    country: 'Australia',
    target: {
      country: 'Australia', language: null, queryIntent: 'education', primaryTermFamily: 'investor education weekly market update',
      retrievalLane: 'VIDEO', searchOrdering: 'RELEVANCE', instrumentOrTheme: null, sourceFamily: 'automated_query'
    }
  }), null);
});

test('frontier targeted fallback carries current execution-time authority provenance', () => {
  const planned = planFrontierTargetedQuery({
    country: 'Australia',
    target: {
      country: 'Australia', language: null, queryIntent: 'market_analysis', primaryTermFamily: 'ASX analysis',
      retrievalLane: 'VIDEO', searchOrdering: 'RELEVANCE', instrumentOrTheme: null, sourceFamily: 'automated_query'
    }
  });
  assert.ok(planned);
  const decision = evaluateAutonomousQueryAuthority(query({
    country: 'Australia',
    query: planned.query,
    generation_mode: planned.generationMode,
    generation_metadata: planned.metadata
  }));
  assert.equal(decision.eligible, true);
  assert.ok(decision.reasonCodes.includes('EXECUTION_TIME_REVALIDATION_PASSED'));
});

test('hard cooldown removes identical historical queries from eligibility', () => {
  const now = new Date('2026-07-28T12:00:00.000Z');
  const recent = query({ id: 1, last_executed: '2026-07-28T11:00:00.000Z' });
  const old = query({ id: 2, query: 'DAX futures education', last_executed: '2026-07-28T03:00:00.000Z' });
  assert.deepEqual(queriesOutsideCooldown([recent, old], now, 360).map(item => item.id), [2]);
  const duplicateWithDifferentCase = query({ id: 3, query: ` ${recent.query.toUpperCase()} `, last_executed: null });
  assert.deepEqual(queriesOutsideCooldown([recent, duplicateWithDifferentCase, old], now, 360).map(item => item.id), [2]);
});

test('primary-term limiter blocks recently overused patterns while preserving never-executed candidates and alternatives', () => {
  const now = new Date('2026-07-28T12:00:00.000Z');
  const overused = query({ id: 1, primary_term: 'market analysis', last_executed: '2026-07-28T11:00:00.000Z' });
  const secondUse = query({ id: 2, query: 'DAX market analysis live', primary_term: 'market analysis', last_executed: '2026-07-28T10:00:00.000Z' });
  const candidateA = query({ id: 3, query: 'AEX market analysis', primary_term: 'market analysis' });
  const candidateB = query({ id: 4, query: 'Options risk lesson', primary_term: 'options risk analysis' });
  assert.deepEqual(limitRepeatedPrimaryTerms([candidateA, candidateB], [overused, secondUse], now, 360, 2).map(item => item.id), [3, 4]);
});

test('intent rotation avoids immediately repeating the most recently executed intent', () => {
  const recent = query({ id: 1, intent: 'forex', last_executed: '2026-07-28T11:00:00.000Z' });
  const forex = query({ id: 2, query: 'EURUSD lesson', intent: 'forex' });
  const psychology = query({ id: 3, query: 'Trading discipline', intent: 'psychology' });
  assert.deepEqual(rotateAwayFromMostRecentIntent([forex, psychology], [recent]).map(item => item.id), [3]);
});

test('unvalidated legacy vocabulary cannot bypass the governed terminology lifecycle', () => {
  const planned = planDiverseQueries({
    country: 'Germany',
    count: 20,
    countryVocabulary: {
      country: 'Germany', languages: ['German'], native_trading_terminology: ['Börsenanalyse', 'Marktstruktur'],
      popular_instruments: ['DAX 40', 'Bund Futures'], local_market_phrases: ['Börse Frankfurt'], common_content_format_names: ['Tagesanalyse']
    },
    learnedVocabulary: [term(10, 'liquidity', 3, 12), term(11, 'orderflow', 2, 4)],
    existingQueries: [],
    mode: 'EXPLORATION'
  });
  assert.equal(planned.some(item => normalizeQuery(item.query).includes('liquidity')), false);
  assert.equal(planned.some(item => normalizeQuery(item.query).includes('orderflow')), true);
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

test('multilingual query plans rotate supported provider languages with explicit lineage', () => {
  const planned = planDiverseQueries({
    country: 'Switzerland',
    count: 6,
    countryVocabulary: {
      country: 'Switzerland', languages: ['German', 'French', 'Italian'], native_trading_terminology: ['Börsenanalyse Schweiz', 'Devisenhandel'],
      popular_instruments: ['SMI', 'CHF'], local_market_phrases: ['SIX Swiss Exchange'], common_content_format_names: ['Schweizer Marktupdate']
    },
    learnedVocabulary: [], existingQueries: [], mode: 'COLD_START'
  });
  const selected = planned.map(item => (item.metadata.languageLineage as any)?.selectedLanguage);
  assert.deepEqual(selected.slice(0, 3), ['de', 'fr', 'it']);
  assert.ok(selected.every(language => ['de', 'fr', 'it'].includes(language)));
  assert.deepEqual((planned[1].metadata.languageLineage as any).supportedLanguages, ['de', 'fr', 'it']);
  assert.equal((planned[1].metadata.languageLineage as any).ordinal, 2);
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

test('planner produces novel local instrument-market variants when every current Belgium query is in cooldown', () => {
  const countryVocabulary = {
    country: 'Belgium',
    languages: ['Dutch', 'French', 'German'],
    native_trading_terminology: ['beursanalyse België', 'technische analyse', 'analyse boursière belge', 'handel in aandelen'],
    popular_instruments: ['BEL 20', 'EURUSD', 'Euronext Brussels'],
    local_market_phrases: ['Brusselse beurs', 'Bourse de Bruxelles'],
    common_content_format_names: ['marktupdate', 'analyse hebdomadaire']
  };
  const existing = [
    'BEL20', 'Beursanalyse', 'BEL 20', 'EURUSD', 'Brusselse beurs Beursanalyse',
    'BEL20 Beursanalyse', 'BEL20 ES', 'BEL20 beursanalyse België', 'EURUSD Beursanalyse',
    'EURUSD beursanalyse België', 'EURUSD technische analyse', 'Euronext Brussels Beursanalyse',
    'BEL 20 Beursanalyse', 'Beursanalyse ETH', 'BEL20 technische analyse'
  ].map((value, id) => query({ id: id + 1, country: 'Belgium', query: value, last_executed: '2026-08-23T10:29:30.000Z' }));
  const planned = planDiverseQueries({
    country: 'Belgium',
    count: 8,
    countryVocabulary,
    learnedVocabulary: [],
    existingQueries: existing,
    provenTerminology: [],
    organicCandidates: [],
    mode: 'EXPLORATION'
  });
  assert.equal(planned.length, 8);
  assert.ok(planned.every(item => !existing.some(saved => normalizeQuery(saved.query) === normalizeQuery(item.query))));
  // Ambiguous native market/broker surfaces must never become singles; they
  // remain useful as companion-shaped queries. The instrument-market fallback
  // must still be available for a fully cooling-down library.
  const instrumentMarket = planned.filter(item => item.metadata.queryTemplate === 'INSTRUMENT_MARKET');
  assert.ok(instrumentMarket.length > 0, 'no novel instrument-market fallback was planned');
  assert.ok(instrumentMarket.every(item => /BEL|EURUSD/i.test(item.query)));
  assert.equal(planned.some(item => normalizeQuery(item.query) === normalizeQuery('Bolero aandelen')), false);
  assert.ok(planned.some(item => /Bolero aandelen/.test(item.query)
    && ((item.metadata as any).atoms as unknown[]).length >= 2));
});

test('accepted extracted queries are planned as standalone surfaces and pass admission/authority', () => {
  const candidate = {
    id: 9001,
    candidateText: 'QQQ Entries with Volume Profile',
    language: 'en',
    intent: 'strategy',
    confidence: 0.8,
    sourceTitle: 'How to Time QQQ Entries with Volume Profile + GEX',
  };
  const planned = planDiverseQueries({
    country: 'United States',
    count: 8,
    learnedVocabulary: [],
    existingQueries: [],
    standaloneExtractedCandidates: [candidate],
  });
  const extracted = planned.find(item => item.metadata.queryTemplate === 'EXTRACTED_STANDALONE');
  assert.ok(extracted, `no extracted standalone query: ${planned.map(item => `${item.metadata.queryTemplate}:${item.query}`).join(' | ')}`);
  assert.equal(extracted.query, candidate.candidateText);
  assert.equal((extracted.metadata as any).extractedCandidateId, candidate.id);
  const admitted = admitQueryRecord({
    query: extracted.query,
    country: 'United States',
    primary_term: extracted.primaryTerm,
    generation_metadata: extracted.metadata,
  });
  assert.equal(admitted.eligible, true, admitted.reasonCodes.join(','));
  const authority = evaluateAutonomousQueryAuthority({
    id: 1,
    query: extracted.query,
    country: 'United States',
    collection: 'EXPERIMENTAL',
    intent: extracted.intent,
    times_executed: 0,
    total_channels_found: 0,
    unique_channels_found: 0,
    quality_channels_found: 0,
    community_channels_found: 0,
    avg_quality_score: 0,
    performance_score: 0,
    created_at: '2026-08-01T00:00:00.000Z',
    status: 'ACTIVE',
    primary_term: extracted.primaryTerm,
    generation_metadata: extracted.metadata,
  });
  assert.equal(authority.eligible, true, authority.reasonCodes.join(','));
  const forged = evaluateAutonomousQueryAuthority(query({
    id: 3,
    query: extracted.query,
    country: 'United States',
    generation_metadata: { ...extracted.metadata, extractedCandidateId: undefined },
  }));
  assert.equal(forged.eligible, false);
  assert.ok(forged.reasonCodes.includes('CURRENT_RETRIEVAL_SHAPE_FAILED'), forged.reasonCodes.join(','));
  const blockedProse = planDiverseQueries({
    country: 'United States',
    count: 8,
    learnedVocabulary: [],
    existingQueries: [],
    standaloneExtractedCandidates: [{
      id: 9009,
      candidateText: 'weekly trade breakdown',
      language: 'en',
      intent: 'strategy',
      confidence: 0.8,
      sourceTitle: 'weekly trade breakdown',
    }],
  });
  assert.ok(!blockedProse.some(item => item.metadata.queryTemplate === 'EXTRACTED_STANDALONE'));
});

test('non-Latin extracted standalone queries plan, admit and keep execution authority', () => {
  const candidate = {
    id: 9002,
    candidateText: 'தங்கம் விலை பகுப்பாய்வு',
    language: 'ta',
    intent: 'market_analysis',
    confidence: 0.8,
    sourceTitle: 'தங்கம் விலை பகுப்பாய்வு',
  };
  const planned = planDiverseQueries({
    country: 'Singapore',
    count: 8,
    learnedVocabulary: [],
    existingQueries: [],
    standaloneExtractedCandidates: [candidate],
  });
  const extracted = planned.find(item => item.metadata.queryTemplate === 'EXTRACTED_STANDALONE');
  assert.ok(extracted, `no native extracted standalone query: ${planned.map(item => `${item.metadata.queryTemplate}:${item.query}`).join(' | ')}`);
  assert.equal(extracted.query, candidate.candidateText);
  assert.equal((extracted.metadata as any).extractedCandidateId, candidate.id);
  assert.equal(isCountryScriptCompatible('Singapore', extracted.query), true);
  assert.equal((extracted.metadata as any).preferredLanguage, 'ta');
  assert.equal((extracted.metadata as any).languageLineage.selectedLanguage, 'ta');
  const admitted = admitQueryRecord({
    query: extracted.query,
    country: 'Singapore',
    primary_term: extracted.primaryTerm,
    generation_metadata: extracted.metadata,
  });
  assert.equal(admitted.eligible, true, admitted.reasonCodes.join(','));
  const authority = evaluateAutonomousQueryAuthority({
    id: 2,
    query: extracted.query,
    country: 'Singapore',
    collection: 'EXPERIMENTAL',
    intent: extracted.intent,
    times_executed: 0,
    total_channels_found: 0,
    unique_channels_found: 0,
    quality_channels_found: 0,
    community_channels_found: 0,
    avg_quality_score: 0,
    performance_score: 0,
    created_at: '2026-08-01T00:00:00.000Z',
    status: 'ACTIVE',
    primary_term: extracted.primaryTerm,
    generation_metadata: extracted.metadata,
  });
  assert.equal(authority.eligible, true, authority.reasonCodes.join(','));
});

test('extracted standalone queries survive creator-derived reservation pressure', () => {
  const terminology: ExtractedTermRecord[] = ['DAX', 'Orderflow', 'Footprint', 'Liquidität', 'Risikomanagement', 'Chartanalyse', 'Scalping', 'Breakout']
    .map((value, index) => term(index + 1, value, 2, 5));
  const planned = planDiverseQueries({
    country: 'Germany',
    count: 4,
    learnedVocabulary: terminology,
    existingQueries: [],
    standaloneExtractedCandidates: [{
      id: 9003,
      candidateText: 'Footprint Trading DAX',
      language: 'de',
      intent: 'strategy',
      confidence: 0.8,
      sourceTitle: 'Footprint Trading DAX Orderflow',
    }],
  });
  assert.ok(
    planned.some(item => item.metadata.queryTemplate === 'EXTRACTED_STANDALONE' && item.query === 'Footprint Trading DAX'),
    planned.map(item => `${item.metadata.queryTemplate}:${item.query}`).join(' | '),
  );
});

test('blocked extracted text does not consume the 40% planner slot', () => {
  const planned = planDiverseQueries({
    country: 'Germany',
    count: 4,
    learnedVocabulary: [],
    existingQueries: [query({ id: 77, query: 'Footprint Trading DAX', country: 'Germany' })],
    standaloneExtractedCandidates: [
      { id: 9101, candidateText: 'Footprint Trading DAX', language: 'de', intent: 'strategy', confidence: 0.9, sourceTitle: 'x' },
      { id: 9102, candidateText: 'DAX Orderflow Strategie', language: 'de', intent: 'strategy', confidence: 0.7, sourceTitle: 'y' },
    ],
  });
  const extracted = planned.filter(item => item.metadata.queryTemplate === 'EXTRACTED_STANDALONE');
  assert.equal(extracted.length, 1, planned.map(item => `${item.metadata.queryTemplate}:${item.query}`).join(' | '));
  assert.equal(extracted[0].query, 'DAX Orderflow Strategie');
  assert.equal((extracted[0].metadata as any).extractedCandidateId, 9102);
});

test('ambiguous short modifiers are not used by frontier target fallback', () => {
  const base = {
    country: 'United States',
    language: 'en',
    queryIntent: 'strategy' as const,
    primaryTermFamily: 'ES',
    retrievalLane: 'VIDEO' as const,
    searchOrdering: 'RELEVANCE' as const,
    instrumentOrTheme: null,
    sourceFamily: 'automated_query',
  };
  assert.equal(planFrontierTargetedQuery({ country: 'United States', target: base }), null);
  assert.equal(planFrontierTargetedQuery({ country: 'United States', target: { ...base, primaryTermFamily: 'SL' } }), null);
  assert.equal(planFrontierTargetedQuery({ country: 'United States', target: { ...base, primaryTermFamily: 'LIVE' } }), null);
});

test('ambiguous short modifiers are not planned as learned query atoms', () => {
  const learned = ['ES', 'SL', 'LIVE'].map((term, index) => ({
    id: index + 1,
    country: 'United States',
    term,
    category: 'instrument' as const,
    occurrences: 10,
    first_extracted: '2026-01-01T00:00:00.000Z',
    last_extracted: '2026-01-02T00:00:00.000Z',
    trust_tier: 2 as const,
    validation_count: 5,
  }));
  const planned = planDiverseQueries({
    country: 'United States',
    count: 40,
    learnedVocabulary: learned,
    existingQueries: [],
  });
  for (const value of ['ES', 'SL', 'LIVE']) {
    assert.equal(
      planned.some(item => String((item.metadata as any).learnedTerm || '').toUpperCase() === value),
      false,
      `${value} must not be planned as a learned modifier`,
    );
  }
  const suppressed = planned.flatMap(item => (item.metadata as any).terminologyGate?.suppressed || []);
  for (const value of ['ES', 'SL', 'LIVE']) {
    assert.ok(
      suppressed.some((item: any) => String(item.term || '').toUpperCase() === value && item.reasons?.includes('ambiguous-short-modifier')),
      `${value} must be recorded with the ambiguous-short-modifier reason`,
    );
  }
  assert.equal(planCountryNativeProposalQuery({ country: 'United States', nativeTerm: 'SL', targetIntent: 'strategy', allocationLineage: {} }), null);
});

test('bare short tickers require qualifying market context', () => {
  for (const ticker of ['NG', 'ES', 'NQ', 'AI', 'ICT', 'SMI', 'LuxX', 'SEK']) {
    assert.equal(isRetrievalOrientedQuery('United States', ticker), false, ticker);
  }
  assert.equal(isRetrievalOrientedQuery('United States', 'NQ Futures'), true);
  assert.equal(isRetrievalOrientedQuery('United States', 'ICT strategy'), true);
  assert.equal(isRetrievalOrientedQuery('Japan', '板読み'), true);
  assert.equal(isRetrievalOrientedQuery('Germany', 'DAX Trading'), true);
});

test('short-ticker atoms survive to form qualified pairs but never search alone', () => {
  assert.equal(isRetrievalOrientedQuery('Norway', 'OBX'), false);
  const planned = planDiverseQueries({
    country: 'Norway',
    count: 12,
    learnedVocabulary: [],
    existingQueries: [],
  });
  const queries = planned.map(item => item.query);
  assert.ok(
    queries.some(query => /\bOBX\b/i.test(query) && query.trim().split(/\s+/).length > 1),
    `expected a qualified OBX pair among: ${queries.join(' | ')}`,
  );
  assert.ok(queries.every(query => isRetrievalOrientedQuery('Norway', query)));
});


test('ambiguous reviewed-native market and broker surfaces are never planned as standalone queries', () => {
  const singapore = planDiverseQueries({ country: 'Singapore', count: 12, learnedVocabulary: [], existingQueries: [] });
  const belgium = planDiverseQueries({ country: 'Belgium', count: 12, learnedVocabulary: [], existingQueries: [] });
  const all = [...singapore, ...belgium];

  const normalized = all.map(item => normalizeQuery(item.query));
  assert.equal(normalized.includes(normalizeQuery('STI analysis')), false);
  assert.equal(normalized.includes(normalizeQuery('Bolero aandelen')), false);
  assert.equal(normalized.includes(normalizeQuery('DBS Vickers')), false);

  for (const item of all.filter(entry => /sti analysis|bolero aandelen|dbs vickers/i.test(normalizeQuery(entry.query)))) {
    const atoms = (item.metadata as any).atoms as Array<Record<string, unknown>>;
    assert.ok(atoms.length >= 2, `${item.query} must retain an authorized companion`);
  }
});

test('reviewed native trading methods remain standalone while ambiguous markets do not', () => {
  const spain = planDiverseQueries({ country: 'Spain', count: 20, learnedVocabulary: [], existingQueries: [] });
  assert.ok(spain.some(item => normalizeQuery(item.query) === normalizeQuery('velas japonesas')
    && item.metadata.queryTemplate === 'SINGLE_ATOM'));
  assert.ok(spain.some(item => normalizeQuery(item.query) === normalizeQuery('operativa intradía')
    && item.metadata.queryTemplate === 'SINGLE_ATOM'));

  const singapore = planDiverseQueries({ country: 'Singapore', count: 12, learnedVocabulary: [], existingQueries: [] });
  assert.equal(singapore.some(item => normalizeQuery(item.query) === normalizeQuery('STI analysis')), false);
});


test('specific multi-token native market phrases remain standalone without stuttering pairs', () => {
  const germany = planDiverseQueries({ country: 'Germany', count: 20, learnedVocabulary: [], existingQueries: [] });
  const singapore = planDiverseQueries({ country: 'Singapore', count: 12, learnedVocabulary: [], existingQueries: [] });
  assert.ok(germany.some(item => normalizeQuery(item.query) === normalizeQuery('DAX Analyse heute')
    && item.metadata.queryTemplate === 'SINGLE_ATOM'));
  assert.ok(singapore.some(item => normalizeQuery(item.query) === normalizeQuery('Singapore market outlook')
    && item.metadata.queryTemplate === 'SINGLE_ATOM'));
  for (const item of [...germany, ...singapore]) {
    const normalized = normalizeQuery(item.query);
    assert.notEqual(normalized, normalizeQuery('DAX Orderflow DAX'));
    assert.notEqual(normalized, normalizeQuery('DAX XTB DAX'));
  }
});
