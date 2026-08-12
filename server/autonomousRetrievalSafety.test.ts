import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQuery, planDiverseQueries } from './queryPlanner';

test('ambiguous country-vocabulary instruments are not emitted as standalone autonomous queries', () => {
  const planned = planDiverseQueries({
    country: 'Switzerland',
    count: 12,
    countryVocabulary: {
      country: 'Switzerland',
      languages: ['German', 'French', 'Italian'],
      native_trading_terminology: ['Börsenanalyse Schweiz', 'Devisenhandel'],
      popular_instruments: ['SMI', 'CHF'],
      local_market_phrases: ['SIX Swiss Exchange'],
      common_content_format_names: ['Schweizer Marktupdate']
    },
    learnedVocabulary: [],
    existingQueries: [],
    mode: 'COLD_START'
  });

  const normalized = planned.map(item => normalizeQuery(item.query));
  assert.ok(!normalized.includes('smi'));
  assert.ok(!normalized.includes('chf'));
  assert.ok(planned.some(item => /\bsmi\b/i.test(item.query) && item.query.trim().split(/\s+/u).length > 1));
});

test('the same protection applies to ambiguous vocabulary in any country', () => {
  const planned = planDiverseQueries({
    country: 'Canada',
    count: 12,
    countryVocabulary: {
      country: 'Canada',
      languages: ['English', 'French'],
      native_trading_terminology: ['Technical Analysis', 'TSX trading'],
      popular_instruments: ['Gold', 'Oil'],
      local_market_phrases: ['Toronto open'],
      common_content_format_names: ['Morning prep']
    },
    learnedVocabulary: [],
    existingQueries: [],
    mode: 'COLD_START'
  });

  const normalized = planned.map(item => normalizeQuery(item.query));
  assert.ok(!normalized.includes('gold'));
  assert.ok(!normalized.includes('oil'));
});
