import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { planDiverseQueries } from './queryPlanner';
import { evaluateAutonomousQueryAuthority } from './autonomousQueryAuthority';
import { resolveAutonomousCountries, resolveScopePromotion, resolveScopePromotionRevocations } from './autonomousDiscovery';
import {
  INITIAL_COUNTRY_VOCABULARIES,
  SUPPORTED_DORMANT_COUNTRIES,
  SUPPORTED_PRODUCTION_COUNTRIES,
} from '../src/data/initial_countries';
import type { CountryVocabulary, QueryRecord } from '../src/types';

/**
 * Dormant-vs-persistent-scope promotion.
 *
 * resolveAutonomousCountries used to apply the dormant hard-exclusion after
 * (and therefore over) the persistent scope filter, so an explicitly
 * scope-selected dormant country was silently skipped by every 5-minute
 * scheduler cycle. Persistent scope selection now takes precedence: selecting
 * a dormant supported country promotes it into active autonomous sweeping,
 * and removing the selection restores the normal dormant behavior. No
 * country is hardcoded; the promotion is driven by the scope mechanism.
 *
 * A second, generic layer covers anchor-less countries (no authorized
 * retrieval anchor): scope promotion lets their vocabulary INSTRUMENT atoms
 * anchor paired templates only, so a future country without curated atoms
 * cannot get stuck dormant-forever either. Bare standalone surfaces stay
 * dormant and every other gate is unchanged.
 */

const DORMANT_FIVE = [...SUPPORTED_DORMANT_COUNTRIES] as string[];
const ALL_20 = [...SUPPORTED_PRODUCTION_COUNTRIES] as string[];

function vocabFor(country: string): CountryVocabulary {
  const found = INITIAL_COUNTRY_VOCABULARIES.find(item => item.country === country);
  assert.ok(found, `fixture vocabulary missing for ${country}`);
  return found;
}

function asQueryRecord(query: string, country: string, metadata: Record<string, unknown>): QueryRecord {
  return { query, country, collection: 'EXPERIMENTAL', generation_metadata: metadata } as QueryRecord;
}

for (const country of DORMANT_FIVE) {
  test(`${country}: scope selection promotes it into the autonomous scheduler countries`, () => {
    const included = resolveAutonomousCountries(ALL_20, [], [country, 'Germany'], 'SELECTED_COUNTRIES');
    assert.ok(included.includes(country), `${country} must be scheduler-eligible once selected`);
    assert.ok(included.includes('Germany'));
  });

  test(`${country}: removing the scope selection restores dormant scheduler behavior`, () => {
    const others = DORMANT_FIVE.filter(item => item !== country);
    const without = resolveAutonomousCountries(ALL_20, [], [...others, 'Germany'], 'SELECTED_COUNTRIES');
    assert.ok(!without.includes(country), `${country} must drop out once deselected`);
    const global = resolveAutonomousCountries(ALL_20, [], [], 'GLOBAL');
    assert.ok(!global.includes(country), `${country} must stay dormant in GLOBAL without selection`);
  });

  test(`${country}: scope promotion plans authority-eligible paired queries`, () => {
    const planned = planDiverseQueries({
      country,
      count: 4,
      countryVocabulary: vocabFor(country),
      learnedVocabulary: [],
      existingQueries: [],
      provenTerminology: [],
      organicCandidates: [],
      mode: 'COLD_START',
      scopePromoted: true
    });
    assert.ok(planned.length >= 1, `${country} must plan at least one candidate once promoted`);
    // At least one planned candidate must be sweepable end-to-end. (Some
    // curated SINGLE_ATOM surfaces can be withheld by the pre-existing
    // standalone-method authority rule; that behavior is unchanged.)
    const sweepable = planned.filter(candidate => {
      const metadata = candidate.metadata as Record<string, unknown>;
      if (metadata.scopePromoted === true) {
        assert.notEqual(metadata.queryTemplate, 'SINGLE_ATOM', 'a promoted primary must never lead a bare standalone surface');
      }
      return evaluateAutonomousQueryAuthority(asQueryRecord(candidate.query, country, metadata)).eligible;
    });
    assert.ok(sweepable.length >= 1, `${country} must plan at least one authority-eligible query once promoted`);
  });
}

test('anchor-less countries stay dormant without selection, sweep once promoted', () => {
  // Synthetic anchor-less registry entry (no curated atoms exist for it):
  // without promotion cold start must plan nothing; with promotion it must
  // plan paired, authority-eligible queries and never a bare standalone.
  const vocab: CountryVocabulary = {
    country: 'Testland',
    languages: ['Testish'],
    native_trading_terminology: ['testhandel', 'testanalyse'],
    popular_instruments: ['TSTX', 'Testoil'],
    local_market_phrases: ['Testland open'],
    common_content_format_names: ['daily test review']
  };
  const base = {
    country: 'Testland',
    count: 4,
    countryVocabulary: vocab,
    learnedVocabulary: [],
    existingQueries: [],
    provenTerminology: [],
    organicCandidates: [],
    mode: 'COLD_START' as const
  };
  assert.equal(planDiverseQueries(base).length, 0, 'anchor-less country must stay dormant without scope promotion');
  const promoted = planDiverseQueries({ ...base, scopePromoted: true });
  assert.ok(promoted.length >= 1, 'anchor-less country must plan once promoted');
  assert.ok(promoted.every(item => {
    const metadata = item.metadata as Record<string, unknown>;
    return metadata.scopePromoted === true && metadata.queryTemplate !== 'SINGLE_ATOM';
  }), 'every promoted candidate must be a marked pair, never a bare standalone');
  for (const candidate of promoted) {
    const decision = evaluateAutonomousQueryAuthority(
      asQueryRecord(candidate.query, 'Testland', candidate.metadata as Record<string, unknown>)
    );
    assert.equal(decision.eligible, true, `promoted "${candidate.query}" must pass authority (${decision.reasonCodes.join(',')})`);
  }
});

test('promotion never authorizes a bare standalone vocabulary surface', () => {
  const bare = asQueryRecord('OBX', 'Norway', {
    queryTemplate: 'SINGLE_ATOM',
    scopePromoted: true,
    retrievalSpecificity: { policyVersion: 'retrieval-specificity-v2', eligibility: 'MODIFIER_ONLY', specificity: 62, ambiguity: 48, reasonCodes: ['UNGOVERNED_ENTITY_REQUIRES_TRADING_ANCHOR'] },
    atoms: [{ term: 'OBX', type: 'INSTRUMENT', retrievalPolicy: { policyVersion: 'retrieval-specificity-v2', eligibility: 'MODIFIER_ONLY' } }]
  });
  assert.equal(evaluateAutonomousQueryAuthority(bare).eligible, false, 'bare promoted surface must stay rejected');
});

test('active countries behave identically with and without promotion (no-op)', () => {
  for (const country of ['Germany', 'United States', 'France']) {
    const vocab = vocabFor(country);
    const base = { country, count: 4, countryVocabulary: vocab, learnedVocabulary: [], existingQueries: [], provenTerminology: [], organicCandidates: [], mode: 'COLD_START' as const };
    const plain = planDiverseQueries(base).map(item => item.query);
    const promoted = planDiverseQueries({ ...base, scopePromoted: true }).map(item => item.query);
    assert.deepEqual(promoted, plain, `${country} output must be unchanged by promotion`);
  }
});

test('unsupported countries stay excluded even when scope-selected', () => {
  const resolved = resolveAutonomousCountries([...ALL_20, 'Brazil', 'Atlantis'], [], ['Brazil', 'Atlantis', 'Norway', 'Germany'], 'SELECTED_COUNTRIES');
  assert.ok(!resolved.includes('Brazil'), 'custom vocab must not be swept');
  assert.ok(!resolved.includes('Atlantis'), 'unknown vocab must not be swept');
  assert.ok(resolved.includes('Norway'), 'selected dormant country must be promoted');
  assert.ok(resolved.includes('Germany'));
  const excluded = resolveAutonomousCountries(ALL_20, ['India', 'Norway'], ['Norway', 'Germany'], 'SELECTED_COUNTRIES');
  assert.ok(!excluded.includes('Norway'), 'hard-excluded country must never pass, even when selected');
});

test('GLOBAL scope keeps supported/excluded distinction; dormant stays dormant', () => {
  const resolved = resolveAutonomousCountries(ALL_20, ['India'], [], 'GLOBAL');
  assert.ok(!resolved.includes('India'));
  for (const dormant of DORMANT_FIVE) {
    assert.ok(!resolved.includes(dormant), `${dormant} must stay dormant in GLOBAL without selection`);
  }
  assert.equal(resolved.length, ALL_20.length - DORMANT_FIVE.length);
});

test('scheduler threads scope promotion through selection and generation', () => {
  // The per-candidate promotion decision is covered at runtime below; the
  // scheduler loop body itself needs a database, so only the thin wiring
  // (computed flag passed into selection, selection into generation) is
  // asserted here by contract.
  assert.equal(resolveScopePromotion('SELECTED_COUNTRIES', ['Norway', 'Germany'], 'Norway'), true);
  assert.equal(resolveScopePromotion('SELECTED_COUNTRIES', ['Germany'], 'Norway'), false);
  assert.equal(resolveScopePromotion('GLOBAL', [], 'Norway'), false);
  assert.equal(resolveScopePromotion('GLOBAL', [], 'Norway', 'Norway'), true, 'direct on-demand target promotes');
  assert.equal(resolveScopePromotion('SELECTED_COUNTRIES', ['norway'], 'NORWAY'), true, 'matching is case-insensitive');
  const scheduler = readFileSync(new URL('./autonomousDiscovery.ts', import.meta.url), 'utf8');
  assert.match(scheduler, /const scopePromoted = resolveScopePromotion\(scope\.scope, scope\.selectedCountries, legacyCountry, targetCountry\);/);
  assert.match(scheduler, /selectNextQueryForCountry\(country, \{[^}]*scopePromoted[^}]*\}\)/);
  assert.match(scheduler, /selectNextQueryForCountry\(legacyCountry, \{ scopePromoted \}\)/);
  const intelligence = readFileSync(new URL('./queryIntelligence.ts', import.meta.url), 'utf8');
  assert.match(intelligence, /generateCandidateQueriesForCountry\(country, 4, 'COLD_START', \{ scopePromoted: options\.scopePromoted \}\)/);
  assert.match(intelligence, /scopePromoted: options\.scopePromoted/);
  const planner = readFileSync(new URL('./queryPlanner.ts', import.meta.url), 'utf8');
  assert.match(planner, /scopePromoted\?: boolean/);
});

test('deselection revokes stored promotion markers', () => {
  assert.deepEqual(
    resolveScopePromotionRevocations({ scope: 'GLOBAL', selectedCountries: [] }).sort(),
    [...SUPPORTED_DORMANT_COUNTRIES].sort(),
    'GLOBAL revokes every dormant marker'
  );
  assert.deepEqual(
    resolveScopePromotionRevocations({ scope: 'SELECTED_COUNTRIES', selectedCountries: ['Norway', 'Germany'] }),
    [...SUPPORTED_DORMANT_COUNTRIES].filter(country => country !== 'Norway'),
    'retained selections keep their markers'
  );
  assert.deepEqual(
    resolveScopePromotionRevocations({ scope: 'SELECTED_COUNTRIES', selectedCountries: [...SUPPORTED_DORMANT_COUNTRIES, 'Germany'] }),
    [],
    'full dormant selection revokes nothing'
  );
  const discovery = readFileSync(new URL('./autonomousDiscovery.ts', import.meta.url), 'utf8');
  assert.match(discovery, /generation_metadata - 'scopePromoted' - 'promotionBasis'/);
});

test('promotion allowlist matches planner-emitted promoted shapes', () => {
  const authority = readFileSync(new URL('./autonomousQueryAuthority.ts', import.meta.url), 'utf8');
  const setLiteral = authority.slice(
    authority.indexOf('SCOPE_PROMOTED_PAIR_TEMPLATES = new Set('),
    authority.indexOf(']);', authority.indexOf('SCOPE_PROMOTED_PAIR_TEMPLATES = new Set(')) + 3
  );
  const listed = [...setLiteral.matchAll(/'([A-Z_]+)'/g)].map(match => match[1]);
  assert.deepEqual(
    [...new Set(listed)].sort(),
    ['COMPACT_PAIR', 'INSTRUMENT_MARKET'],
    'authority must accept exactly the pair shapes the planner can emit for promoted anchors'
  );
});

test('existing country safety and rejection logic remain intact', () => {
  const staleProvenance = asQueryRecord('OBX Aksjehandel', 'Norway', {
    queryTemplate: 'COMPACT_PAIR',
    scopePromoted: true,
    retrievalSpecificity: { policyVersion: 'retrieval-specificity-v1', eligibility: 'MODIFIER_ONLY', specificity: 62, ambiguity: 48, reasonCodes: [] },
    atoms: [
      { term: 'OBX', type: 'INSTRUMENT', retrievalPolicy: { policyVersion: 'retrieval-specificity-v1', eligibility: 'MODIFIER_ONLY' } },
      { term: 'Aksjehandel', type: 'METHOD', retrievalPolicy: { policyVersion: 'retrieval-specificity-v1', eligibility: 'MODIFIER_ONLY' } }
    ]
  });
  assert.equal(evaluateAutonomousQueryAuthority(staleProvenance).eligible, false, 'stale provenance must still reject even when promoted');
  const rejected = asQueryRecord('OBX Aksjehandel', 'Norway', {
    queryTemplate: 'COMPACT_PAIR',
    scopePromoted: true,
    retrievalSpecificity: { policyVersion: 'retrieval-specificity-v2', eligibility: 'MODIFIER_ONLY', specificity: 62, ambiguity: 48, reasonCodes: [] },
    atoms: [
      { term: 'OBX', type: 'INSTRUMENT', retrievalPolicy: { policyVersion: 'retrieval-specificity-v2', eligibility: 'MODIFIER_ONLY' } },
      { term: 'Aksjehandel', type: 'METHOD', retrievalPolicy: { policyVersion: 'retrieval-specificity-v2', eligibility: 'MODIFIER_ONLY' } }
    ]
  });
  assert.equal(
    evaluateAutonomousQueryAuthority({ ...rejected, collection: 'REJECTED' }).eligible,
    false,
    'REJECTED collection must still reject even when promoted'
  );
});
