import assert from 'node:assert/strict';
import test from 'node:test';
import { INITIAL_COUNTRY_VOCABULARIES } from '../src/data/initial_countries';
import { planDiverseQueries, shouldGenerateNativeQueries } from './queryPlanner';

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

test('native replenishment runs below the active floor, not only when the pool is empty', () => {
  const now = new Date('2026-11-08T12:00:00.000Z');
  const old = '2026-11-01T12:00:00.000Z';
  assert.equal(shouldGenerateNativeQueries({
    queries: [{ collection: 'EXPERIMENTAL', created_at: old }, { collection: 'REJECTED', created_at: old }],
    now,
  }), true, 'two active queries are below the floor and the library is stale');
  assert.equal(shouldGenerateNativeQueries({
    queries: Array.from({ length: 10 }, () => ({ collection: 'EXPERIMENTAL' as const, created_at: old })),
    now,
  }), false, 'a healthy inventory does not need replenishment');
  assert.equal(shouldGenerateNativeQueries({
    queries: [{ collection: 'EXPERIMENTAL', created_at: '2026-11-08T09:00:00.000Z' }],
    now,
  }), false, 'the cooldown prevents duplicate generation every cycle');
});
