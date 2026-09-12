import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  INITIAL_COUNTRY_VOCABULARIES,
  SUPPORTED_DORMANT_COUNTRIES,
  SUPPORTED_PRODUCTION_COUNTRIES,
} from '../src/data/initial_countries';
import { assertProductionCountryArchitecture } from './productionCountryArchitecture';
import { canonicalCountry } from './countryInference';
import { getCuratedQueryCountries } from './queryPlanner';
import { COUNTRY_KNOWLEDGE_PACKS, LANGUAGE_KNOWLEDGE_PACKS } from './evidenceEngine/knowledgePacks';
import { resolveScopeEligibility } from './scopeEligibility';
import { resolveAutonomousCountries } from './autonomousDiscovery';

const ALL_20 = [...SUPPORTED_PRODUCTION_COUNTRIES] as string[];

test('supported universe is exactly 20 countries including Norway', () => {
  assert.equal(ALL_20.length, 20);
  assert.ok(ALL_20.includes('Norway'));
  assert.equal(new Set(ALL_20).size, 20);
  const vocab = INITIAL_COUNTRY_VOCABULARIES.find(v => v.country === 'Norway');
  assert.ok(vocab);
  for (const field of [
    'languages',
    'native_trading_terminology',
    'popular_instruments',
    'local_market_phrases',
    'common_content_format_names',
  ] as const) {
    assert.ok(vocab[field].length > 0, `Norway vocabulary.${field} is empty`);
  }
});

test('dormant scope is exactly the five supported-but-unswept countries', () => {
  assert.deepEqual([...SUPPORTED_DORMANT_COUNTRIES].sort(), [
    'Italy',
    'Japan',
    'Norway',
    'Spain',
    'United Arab Emirates',
  ]);
  for (const country of SUPPORTED_DORMANT_COUNTRIES) {
    assert.ok(ALL_20.includes(country), `${country} must stay supported`);
  }
});

test('startup invariant holds at 20 with Norway canonicalized end to end', () => {
  assert.doesNotThrow(assertProductionCountryArchitecture);
  assert.equal(canonicalCountry('NO'), 'Norway');
  assert.equal(canonicalCountry('norge'), 'Norway');
  assert.ok(getCuratedQueryCountries().includes('Norway'));
  assert.ok(COUNTRY_KNOWLEDGE_PACKS['Norway']);
  assert.ok(LANGUAGE_KNOWLEDGE_PACKS['no']);
});

test('scope eligibility separates market validity from country verdicts', () => {
  assert.equal(resolveScopeEligibility('Germany'), 'IN_SCOPE');
  assert.equal(resolveScopeEligibility('Norway'), 'IN_SCOPE');
  assert.equal(resolveScopeEligibility('Italy'), 'IN_SCOPE');
  assert.equal(resolveScopeEligibility('Vietnam'), 'OUT_OF_SCOPE');
  assert.equal(resolveScopeEligibility('Brazil'), 'OUT_OF_SCOPE');
  assert.equal(resolveScopeEligibility(null), 'UNRESOLVED');
  assert.equal(resolveScopeEligibility(''), 'UNRESOLVED');
  assert.equal(resolveScopeEligibility('  germany  '), 'IN_SCOPE');
});

test('autonomous sweep preserves dormant countries but honors explicit targets', () => {
  const vocabs = [...ALL_20];
  const global = resolveAutonomousCountries(vocabs, [], [], 'GLOBAL');
  assert.equal(global.length, 15);
  for (const dormant of SUPPORTED_DORMANT_COUNTRIES) {
    assert.ok(!global.includes(dormant), `${dormant} must not be swept`);
  }
  const selected = resolveAutonomousCountries(
    vocabs,
    [],
    ['Norway', 'Germany'],
    'SELECTED_COUNTRIES',
  );
  assert.deepEqual(selected, ['Germany']);
  assert.deepEqual(
    resolveAutonomousCountries(vocabs, [], [], 'GLOBAL', 'Norway'),
    ['Norway'],
  );
  assert.deepEqual(
    resolveAutonomousCountries(vocabs, ['Germany'], [], 'GLOBAL').filter(c => c === 'Germany'),
    [],
  );
});

test('migration 131 adds scope_eligibility non-destructively', () => {
  const sql = readFileSync('server/db/migrations/131_scope_eligibility.sql', 'utf8');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS scope_eligibility/);
  assert.ok(!/country_status\s*=/.test(sql), 'migration must never write country_status');
  assert.ok(!/confidence_score\s*=/.test(sql), 'migration must never write confidence_score');
  assert.ok(!/DROP\s+(COLUMN|TABLE)/i.test(sql), 'migration must not drop columns or tables');
  assert.ok(sql.includes("'Norway'"), 'backfill IN_SCOPE list must include Norway');
  assert.ok(sql.includes("'IN_SCOPE'") && sql.includes("'OUT_OF_SCOPE'") && sql.includes("'UNRESOLVED'"));
  assert.match(sql, /NOT VALID/);
});
