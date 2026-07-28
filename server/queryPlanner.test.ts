import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtractedTermRecord, QueryRecord } from '../src/types';
import { limitRepeatedPrimaryTerms, normalizeQuery, planDiverseQueries, queriesOutsideCooldown, rotateAwayFromMostRecentIntent } from './queryPlanner';

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

test('planner creates unique, intent-diverse queries with auditable metadata', () => {
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
  assert.ok(new Set(planned.map(item => item.intent)).size >= 12);
  assert.ok(planned.every(item => item.knowledgeTiers.includes(1)));
  assert.ok(planned.every(item => item.generationReason && item.discoveryObjective && item.primaryTerm));
  assert.ok(planned.some(item => item.knowledgeTiers.includes(2)));
  assert.ok(planned.some(item => item.knowledgeTiers.includes(3)));
  assert.ok(planned.filter(item => item.knowledgeTiers.includes(3)).length <= Math.ceil(planned.length / 5));
});

test('planner never recreates an existing normalized query', () => {
  const baseline = planDiverseQueries({ country: 'France', count: 1, learnedVocabulary: [], existingQueries: [] })[0];
  const next = planDiverseQueries({ country: 'France', count: 3, learnedVocabulary: [], existingQueries: [query({ query: `  ${baseline.query.toUpperCase()}  `, country: 'France' })] });
  assert.ok(next.every(item => normalizeQuery(item.query) !== normalizeQuery(baseline.query)));
});
