import assert from 'node:assert/strict';
import test from 'node:test';
import { INITIAL_COUNTRY_VOCABULARIES } from '../src/data/initial_countries';
import { planDiverseQueries, shouldGenerateNativeQueries } from './queryPlanner';
import { admitQueryRecord } from './queryQuality/admission';
import { generateNativeQueriesWithLlm, shouldRegenerateCachedGeneration } from './nativeQueryGeneration';

function vocabulary(country: string) {
  const found = INITIAL_COUNTRY_VOCABULARIES.find(item => item.country === country);
  assert.ok(found, `missing vocabulary for ${country}`);
  return found;
}

function planned(country: string): string[] {
  return planDiverseQueries({
    country,
    count: 40,
    countryVocabulary: vocabulary(country),
    learnedVocabulary: [],
    existingQueries: [],
    provenTerminology: [],
    mode: 'COLD_START',
  }).map(item => item.query);
}

test('native query atoms reach the planner for representative non-English markets', () => {
  const cases: Array<[string, RegExp]> = [
    ['France', /Boursorama|Bourse Direct|carnet|analyse technique CAC/i],
    ['Germany', /Trade Republic|DAX Analyse heute|Charttechnik DAX|Orderflow DAX/i],
    ['Netherlands', /Nico Bakker|Tostrams|opties AEX|technische analyse AEX/i],
    ['Japan', /日経225先物|板読み|日経225 デイトレード|ドル円 デイトレード/],
    ['Spain', /análisis técnico IBEX|IBEX 35 hoy|Bolsamanía/i],
    ['Italy', /analisi tecnica FTSE|FTSE MIB oggi|Milano Finanza|Teleborsa/i],
  ];
  for (const [country, pattern] of cases) {
    const queries = planned(country);
    assert.ok(queries.some(query => pattern.test(query)), `${country} planner did not emit a native surface: ${queries.join(' | ')}`);
  }
});

test('selected dormant countries can admit their native standalone surfaces', () => {
  const planned = planDiverseQueries({
    country: 'Spain',
    count: 8,
    countryVocabulary: vocabulary('Spain'),
    learnedVocabulary: [],
    existingQueries: [],
    mode: 'EXPLORATION',
    scopePromotionBasis: 'PERSISTENT_SCOPE_SELECTION',
  });
  const native = planned.find(item => item.metadata.queryTemplate === 'SINGLE_ATOM');
  assert.ok(native, 'no native standalone surface was planned');
  assert.equal(native.metadata.scopePromoted, true);
  const decision = admitQueryRecord({
    query: native.query,
    country: 'Spain',
    primary_term: native.primaryTerm,
    generation_metadata: native.metadata,
  });
  assert.equal(decision.eligible, true, decision.reasonCodes.join(','));
});

test('underfilled cache regenerates only when memory removed candidates', () => {
  assert.equal(shouldRegenerateCachedGeneration({ requested: 10, accepted: 4, lostToMemory: 6 }), true);
  assert.equal(shouldRegenerateCachedGeneration({ requested: 10, accepted: 4, lostToMemory: 0 }), false);
  assert.equal(shouldRegenerateCachedGeneration({ requested: 10, accepted: 10, lostToMemory: 0 }), false);
});

function inMemoryGenerationStore() {
  const batches = new Map<string, Record<string, unknown>>();
  return {
    getGenerationBatch: async (key: string) => batches.get(key) || null,
    rememberQueryCandidates: async () => 0,
    upsertGenerationBatch: async (input: { batchKey: string; payload: Record<string, unknown> }) => {
      batches.set(input.batchKey, input.payload);
    },
  };
}

test('duplicateRate counts duplicate decisions only, not validation failures', async () => {
  let call = 0;
  const result = await generateNativeQueriesWithLlm({
    memoryStore: inMemoryGenerationStore(),
    context: {
      country: 'France',
      language: 'fr',
      mode: 'OPEN_WORLD',
      existingQueries: [],
      candidateMemory: [],
      coverageGaps: [],
      autocompleteSuggestions: [],
      localVocabulary: [],
    },
    count: 2,
    generateText: async () => {
      call += 1;
      const queries = call === 1
        ? [
            { query: 'analyse technique CAC 40', intent: 'market_analysis', confidence: 0.8 },
            { query: 'subscribe to my trading channel', intent: 'education', confidence: 0.8 },
          ]
        : [
            { query: 'bourse direct avis', intent: 'strategy', confidence: 0.8 },
          ];
      return { text: JSON.stringify({ queries }), provider: 'test', model: 'test' };
    },
  });
  assert.equal(result.candidates.length, 2);
  // One CTA was rejected by validation, but no candidate was rejected as a
  // duplicate. The old rejection-rate metric would have reported 1/3.
  assert.equal(result.duplicateRate, 0);
});

test('a failed replacement pass keeps the valid cached subset', async () => {
  const memoryStore = inMemoryGenerationStore();
  const context = {
    country: 'France',
    language: 'fr',
    mode: 'OPEN_WORLD' as const,
    existingQueries: [],
    candidateMemory: [],
    coverageGaps: [],
    autocompleteSuggestions: [],
    localVocabulary: [],
  };
  const first = await generateNativeQueriesWithLlm({
    context,
    count: 2,
    memoryStore,
    generateText: async () => ({
      text: JSON.stringify({ queries: [
        { query: 'analyse technique CAC 40', intent: 'market_analysis', confidence: 0.8 },
        { query: 'bourse direct avis', intent: 'strategy', confidence: 0.8 },
      ] }),
      provider: 'test',
      model: 'test',
    }),
  });
  assert.equal(first.candidates.length, 2);
  const admitted = first.candidates[0];
  const second = await generateNativeQueriesWithLlm({
    context: {
      ...context,
      candidateMemory: [{
        country: 'France',
        language: 'fr',
        source: 'LLM',
        mode: 'OPEN_WORLD',
        normalizedQuery: admitted.query,
        semanticKey: admitted.query,
        status: 'ADMITTED',
        reasonCodes: [],
        batchKey: first.batchId,
        metadata: { intent: admitted.intent },
        firstSeenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      }],
    },
    count: 2,
    memoryStore,
    generateText: async () => ({
      text: JSON.stringify({ queries: [{ query: 'subscribe to my trading channel', intent: 'education' }] }),
      provider: 'test',
      model: 'test',
    }),
  });
  // The admitted candidate is removed, but the other cached candidate must
  // survive the failed replacement pass instead of being replaced by an
  // empty 14-day cache entry.
  assert.deepEqual(second.candidates.map(candidate => candidate.query), [first.candidates[1].query]);
});

test('native replenishment runs below the eligible floor, not only when the pool is empty', () => {
  const now = new Date('2026-11-08T12:00:00.000Z');
  assert.equal(shouldGenerateNativeQueries({
    active: 2,
    lastAttemptAt: '2026-11-01T12:00:00.000Z',
    now,
  }), true, 'two permanently eligible queries are below the floor');
  assert.equal(shouldGenerateNativeQueries({
    active: 10,
    lastAttemptAt: '2026-11-01T12:00:00.000Z',
    now,
  }), false, 'a healthy eligible inventory does not need replenishment');
  assert.equal(shouldGenerateNativeQueries({
    active: 1,
    lastAttemptAt: '2026-11-08T09:00:00.000Z',
    now,
  }), false, 'the persisted attempt cooldown prevents duplicate generation every cycle');
  assert.equal(shouldGenerateNativeQueries({
    active: 1,
    lastAttemptAt: null,
    now,
  }), true, 'a missing attempt record allows the first replenishment');
});
