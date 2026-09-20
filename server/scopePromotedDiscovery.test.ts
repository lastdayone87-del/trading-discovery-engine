import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { planDiverseQueries } from './queryPlanner';
import { evaluateAutonomousQueryAuthority, isScopePromotedRecord } from './autonomousQueryAuthority';
import { resolveAutonomousCountries, resolveScopePromotion, resolveScopePromotionForScope, parseDiscoveryScopeMode, parseDiscoveryScopeSelection } from './autonomousDiscovery';
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
      scopePromotionBasis: 'PERSISTENT_SCOPE_SELECTION'
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
  const promoted = planDiverseQueries({ ...base, scopePromotionBasis: 'PERSISTENT_SCOPE_SELECTION' });
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
    scopePromotionBasis: 'PERSISTENT_SCOPE_SELECTION',
    retrievalSpecificity: { policyVersion: 'retrieval-specificity-v2', eligibility: 'MODIFIER_ONLY', specificity: 62, ambiguity: 48, reasonCodes: ['UNGOVERNED_ENTITY_REQUIRES_TRADING_ANCHOR'] },
    atoms: [{ term: 'OBX', type: 'INSTRUMENT', retrievalPolicy: { policyVersion: 'retrieval-specificity-v2', eligibility: 'MODIFIER_ONLY' } }]
  });
  assert.equal(evaluateAutonomousQueryAuthority(bare).eligible, false, 'bare promoted surface must stay rejected');
});

test('active countries behave identically with and without promotion (no-op)', () => {
  // Norway is pinned explicitly here: it carries curated atoms, so its
  // authorized anchors make the promotion fallback a provable no-op and its
  // coverage provably comes from the resolver/scope mechanism, not the
  // planner fallback (which exists generically for anchor-less countries).
  for (const country of ['Germany', 'United States', 'France', 'Norway']) {
    const vocab = vocabFor(country);
    const base = { country, count: 4, countryVocabulary: vocab, learnedVocabulary: [], existingQueries: [], provenTerminology: [], organicCandidates: [], mode: 'COLD_START' as const };
    const plain = planDiverseQueries(base).map(item => item.query);
    const promoted = planDiverseQueries({ ...base, scopePromotionBasis: 'PERSISTENT_SCOPE_SELECTION' }).map(item => item.query);
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

test('GLOBAL with a retained stale selection still sweeps no dormant country', () => {
  // Production keeps the selected_countries setting after a mode flip to
  // GLOBAL; the dormant spare must require an active SELECTED scope.
  const resolved = resolveAutonomousCountries(ALL_20, [], ['Norway', 'Germany'], 'GLOBAL');
  for (const dormant of DORMANT_FIVE) {
    assert.ok(!resolved.includes(dormant), `${dormant} must stay dormant in GLOBAL despite a stale selection`);
  }
  assert.equal(resolved.length, ALL_20.length - DORMANT_FIVE.length);
});

test('deliberate direct targets bypass scope/dormant filters but keep their basis', () => {
  // Contract: a deliberate single-target override passes the pure resolver by
  // design (even in GLOBAL, even for a dormant country, even for an
  // out-of-registry country deliberately requested). Hard-excluded countries
  // resolve to nothing here, and are additionally blocked outside this pure
  // function — runAutonomousDiscoveryCycle asserts the target via
  // assertCountryAllowed before resolving, and the worker asserts every job
  // country again before spending quota.
  assert.deepEqual(resolveAutonomousCountries(ALL_20, [], [], 'GLOBAL', 'Norway'), ['Norway']);
  assert.deepEqual(
    resolveAutonomousCountries(ALL_20, ['India', 'Norway'], ['Germany'], 'SELECTED_COUNTRIES', 'Norway'),
    [],
    'a hard-excluded direct target resolves to nothing (callers also gate via assertCountryAllowed)',
  );
  assert.deepEqual(resolveAutonomousCountries(ALL_20, [], [], 'GLOBAL', 'Atlantis'), ['Atlantis']);
  assert.equal(resolveScopePromotion('GLOBAL', [], 'Norway', 'Norway'), 'DIRECT_TARGET');
  assert.equal(resolveScopePromotion('SELECTED_COUNTRIES', ['Germany'], 'Norway', 'Norway'), 'DIRECT_TARGET');
  assert.equal(resolveScopePromotion('GLOBAL', [], 'Germany', 'Norway'), null, 'a non-target country is never directly promoted');
});

test('scheduler and worker resolve promotion through one shared helper (runtime arguments)', () => {
  // The per-candidate promotion decision is resolved through the exact helper
  // both call sites use, with realistic scope objects as returned by
  // getDiscoveryScope — so incorrect promotion values fail here instead of
  // passing behind a source-text match.
  assert.equal(
    resolveScopePromotionForScope({ scope: 'SELECTED_COUNTRIES', selectedCountries: ['Norway', 'Germany'] }, 'Norway'),
    'PERSISTENT_SCOPE_SELECTION',
  );
  assert.equal(
    resolveScopePromotionForScope({ scope: 'SELECTED_COUNTRIES', selectedCountries: ['Germany'] }, 'Norway'),
    null,
  );
  assert.equal(resolveScopePromotionForScope({ scope: 'GLOBAL', selectedCountries: [] }, 'Norway'), null);
  assert.equal(
    resolveScopePromotionForScope({ scope: 'GLOBAL', selectedCountries: ['Norway'] }, 'Norway'),
    null,
    'GLOBAL with a stale selection must never promote',
  );
  assert.equal(
    resolveScopePromotionForScope({ scope: 'GLOBAL', selectedCountries: [] }, 'Norway', 'Norway'),
    'DIRECT_TARGET',
    'direct on-demand target promotes',
  );
  // The worker resolves without a targetCountry (one-shot DIRECT_TARGET
  // lifetime is carried by the stored metadata basis, not live scope), while
  // the scheduler resolves with it: both shapes are covered through the same
  // helper.
  assert.equal(
    resolveScopePromotionForScope({ scope: 'SELECTED_COUNTRIES', selectedCountries: ['Norway'] }, 'Norway', 'Norway'),
    'DIRECT_TARGET',
  );
  assert.equal(resolveScopePromotion('SELECTED_COUNTRIES', ['norway'], 'NORWAY'), 'PERSISTENT_SCOPE_SELECTION', 'matching is case-insensitive');
  // The generation seam stamps the basis into planned metadata at runtime:
  // both bases must be distinguishable in audit records.
  for (const basis of ['PERSISTENT_SCOPE_SELECTION', 'DIRECT_TARGET'] as const) {
    const planned = planDiverseQueries({
      country: 'Testland',
      count: 4,
      countryVocabulary: {
        country: 'Testland',
        languages: ['Testish'],
        native_trading_terminology: ['testhandel', 'testanalyse'],
        popular_instruments: ['TSTX', 'Testoil'],
        local_market_phrases: ['Testland open'],
        common_content_format_names: ['daily test review'],
      },
      learnedVocabulary: [],
      existingQueries: [],
      provenTerminology: [],
      organicCandidates: [],
      mode: 'COLD_START',
      scopePromotionBasis: basis,
    });
    assert.ok(planned.length >= 1, `${basis} must plan`);
    assert.ok(
      planned.every(item => (item.metadata as Record<string, unknown>).promotionBasis === basis),
      `${basis} must be stamped into every planned candidate`,
    );
  }
  // Narrow change-detectors only: the two call sites must resolve through the
  // shared helper and thread the basis into selection and generation. The
  // values themselves are proven at runtime above and below.
  const scheduler = readFileSync(new URL('./autonomousDiscovery.ts', import.meta.url), 'utf8');
  assert.match(scheduler, /const scopePromotionBasis = resolveScopePromotionForScope\(scope, legacyCountry, targetCountry\);/);
  assert.match(scheduler, /selectNextQueryForCountry\(country, \{[^}]*scopePromotionBasis[^}]*\}\)/);
  assert.match(scheduler, /selectNextQueryForCountry\(legacyCountry, \{ scopePromotionBasis \}\)/);
  const intelligence = readFileSync(new URL('./queryIntelligence.ts', import.meta.url), 'utf8');
  assert.match(intelligence, /generateCandidateQueriesForCountry\(country, 4, 'COLD_START', \{ scopePromotionBasis: options\.scopePromotionBasis \}\)/);
  assert.match(intelligence, /scopePromotionBasis: options\.scopePromotionBasis/);
  const planner = readFileSync(new URL('./queryPlanner.ts', import.meta.url), 'utf8');
  assert.match(planner, /scopePromotionBasis\?: 'PERSISTENT_SCOPE_SELECTION' \| 'DIRECT_TARGET'/);
  const worker = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
  assert.match(worker, /resolveScopePromotionForScope\(liveScope, country\)/);
  assert.match(worker, /evaluateAutonomousQueryAuthority\(authorityQueryRecord, \{/);
  assert.ok(!worker.includes('getDiscoveryScope().catch'), 'a scope-read failure must error the attempt, never silently preserve promotion');
});

test('scope saves commit atomically so readers never tear mode and countries', () => {
  const discovery = readFileSync(new URL('./autonomousDiscovery.ts', import.meta.url), 'utf8');
  const saver = discovery.slice(discovery.indexOf('export async function setDiscoveryScope'));
  assert.match(saver, /BEGIN/);
  assert.match(saver, /COMMIT/);
  assert.match(saver, /ROLLBACK/);
  assert.match(saver, /query_intelligence_discovery_scope/);
  assert.match(saver, /query_intelligence_selected_countries/);
});

test('stored promotion follows live selection at execution authority', () => {
  const metadata = {
    queryTemplate: 'COMPACT_PAIR',
    scopePromoted: true,
    promotionBasis: 'PERSISTENT_SCOPE_SELECTION',
    retrievalSpecificity: { policyVersion: 'retrieval-specificity-v2', eligibility: 'MODIFIER_ONLY', specificity: 62, ambiguity: 48, reasonCodes: [] },
    atoms: [
      { term: 'OBX', type: 'INSTRUMENT', retrievalPolicy: { policyVersion: 'retrieval-specificity-v2', eligibility: 'MODIFIER_ONLY' } },
      { term: 'Aksjehandel', type: 'METHOD', retrievalPolicy: { policyVersion: 'retrieval-specificity-v2', eligibility: 'MODIFIER_ONLY' } }
    ]
  };
  const record = asQueryRecord('OBX Aksjehandel', 'Norway', metadata);
  assert.equal(
    evaluateAutonomousQueryAuthority(record, { scopePromotionActive: true }).eligible,
    true,
    'selected country keeps sweeping on stored queries'
  );
  assert.equal(
    evaluateAutonomousQueryAuthority(record, { scopePromotionActive: false }).eligible,
    false,
    'deselected country stops sweeping on stored queries without burning them'
  );
  assert.equal(
    evaluateAutonomousQueryAuthority(record).eligible,
    true,
    'callers without scope context keep legacy acceptance'
  );
  // Reselection restores sweeping on the same stored rows (no regeneration,
  // no REJECTED burn): deselect-then-reselect round-trips cleanly.
  assert.equal(evaluateAutonomousQueryAuthority(record, { scopePromotionActive: false }).eligible, false);
  assert.equal(evaluateAutonomousQueryAuthority(record, { scopePromotionActive: true }).eligible, true);
  // DIRECT_TARGET markers authorize their explicitly ordered one-shot work
  // for its lifetime so in-flight manual jobs can complete after any scope
  // change.
  const direct = asQueryRecord('OBX Aksjehandel', 'Norway', { ...metadata, promotionBasis: 'DIRECT_TARGET' });
  assert.equal(evaluateAutonomousQueryAuthority(direct, { scopePromotionActive: false }).eligible, true);
});

test('malformed scope selection fails closed instead of collapsing to an empty selection', () => {
  // Valid states parse normally: genuine intentional deselection ('[]') stays
  // a valid empty selection, and a real selection round-trips.
  assert.deepEqual(parseDiscoveryScopeSelection('[]'), []);
  assert.deepEqual(parseDiscoveryScopeSelection('["Norway", "Germany"]'), ['Norway', 'Germany']);
  // Malformed / invalid persisted values must throw (fail closed, retryable)
  // rather than silently becoming [] (which would read as "not authorized"
  // and let the worker completeJob a promoted job).
  for (const malformed of ['not-json', '{bad', '', '   ', '"Norway"', '123', 'null', '{"a":1}', '[123]', '[null]', '[["Norway"]]', '["Norway", 123]']) {
    assert.throws(() => parseDiscoveryScopeSelection(malformed), /DISCOVERY_SCOPE_SELECTION_MALFORMED/, `must fail closed: ${malformed}`);
  }
  // Genuine deselection still behaves normally: a valid empty selection means
  // "not authorized" for persistent promotions (withhold path), not an error.
  assert.equal(resolveScopePromotion('SELECTED_COUNTRIES', parseDiscoveryScopeSelection('[]'), 'Norway'), null);
  assert.equal(resolveScopePromotion('SELECTED_COUNTRIES', parseDiscoveryScopeSelection('["Norway"]'), 'Norway'), 'PERSISTENT_SCOPE_SELECTION');
});

test('scope-read failure cannot complete a promoted job (fail closed, retryable)', () => {
  // Unit behavior above proves malformed reads throw. This contract proves the
  // worker cannot turn that throw into a silent completeJob:
  // - getDiscoveryScope reads both settings in one snapshot statement (no torn
  //   mode/country combination) and has no broad catch falling back to
  //   `selectedCountries: []`;
  // - the settings read is awaited outside any try so DB failures propagate;
  // - the worker awaits getDiscoveryScope directly (no .catch fallback) before
  //   authority, so any throw reaches the outer catch -> failJob (retryable),
  //   never the withhold-path completeJob.
  // - the live scope read happens only for scope-promoted jobs, so ordinary
  //   jobs can never burn attempts on a scope misconfiguration.
  const discovery = readFileSync(new URL('./autonomousDiscovery.ts', import.meta.url), 'utf8');
  const getter = discovery.slice(discovery.indexOf('export async function getDiscoveryScope'));
  const parser = discovery.slice(
    discovery.indexOf('export function parseDiscoveryScopeSelection'),
    discovery.indexOf('export async function getDiscoveryScope'),
  );
  assert.match(parser, /DISCOVERY_SCOPE_SELECTION_MALFORMED/);
  assert.match(getter, /parseDiscoveryScopeSelection/);
  assert.match(getter, /parseDiscoveryScopeMode/);
  assert.match(getter, /WHERE setting_key IN \(\$1, \$2\)/);
  assert.ok(!getter.includes('selectedCountries: []'), 'malformed scope must throw, never silently return an empty selection');
  const worker = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
  assert.match(worker, /if \(isScopePromotedRecord\(recordMetadata\)\) \{\s*\n\s*const liveScope = await getDiscoveryScope\(\);/);
  assert.ok(!worker.includes('getDiscoveryScope().catch'), 'a scope-read failure must error the attempt, never silently preserve promotion');
  assert.match(worker, /await failJob\(job\.id, err\)/, 'scope-read failures must take the retryable failJob path via the outer catch');
  // The gating predicate is proven at runtime: every promoted basis (including
  // legacy markers without a basis) triggers the live read, while ordinary
  // records — missing, malformed-string, or unmarked metadata — skip it.
  assert.equal(isScopePromotedRecord({ scopePromoted: true, promotionBasis: 'PERSISTENT_SCOPE_SELECTION' }), true);
  assert.equal(isScopePromotedRecord({ scopePromoted: true, promotionBasis: 'DIRECT_TARGET' }), true);
  assert.equal(isScopePromotedRecord({ scopePromoted: true }), true, 'legacy marker without a basis reads as the persistent form');
  assert.equal(isScopePromotedRecord(JSON.stringify({ scopePromoted: true })), true, 'string-encoded metadata is honored');
  assert.equal(isScopePromotedRecord({ scopePromoted: false }), false);
  assert.equal(isScopePromotedRecord({}), false);
  assert.equal(isScopePromotedRecord(null), false);
  assert.equal(isScopePromotedRecord(undefined), false);
  assert.equal(isScopePromotedRecord('not-json'), false);
  // Scope-mode parsing is proven at runtime: only persisted-valid modes pass,
  // so a malformed mode can never demote a promotion into a silent GLOBAL
  // withhold.
  assert.equal(parseDiscoveryScopeMode('GLOBAL'), 'GLOBAL');
  assert.equal(parseDiscoveryScopeMode('SELECTED_COUNTRIES'), 'SELECTED_COUNTRIES');
  for (const malformed of ['global', '', 'ALL', 'null', 'SELECTED', 'GLOBAL ']) {
    assert.throws(() => parseDiscoveryScopeMode(malformed), /DISCOVERY_SCOPE_SELECTION_MALFORMED/, `mode must fail closed: ${malformed}`);
  }
  // Both promotion bases are safe: a persistent promotion withholds only on a
  // successful read showing deselection, while a DIRECT_TARGET one-shot stays
  // eligible on success — but neither may be consumed when the read itself fails,
  // because the throw happens before authority is even evaluated.
  const persistentMetadata = {
    queryTemplate: 'COMPACT_PAIR',
    scopePromoted: true,
    promotionBasis: 'PERSISTENT_SCOPE_SELECTION',
    retrievalSpecificity: { policyVersion: 'retrieval-specificity-v2', eligibility: 'MODIFIER_ONLY', specificity: 62, ambiguity: 48, reasonCodes: [] },
    atoms: [
      { term: 'OBX', type: 'INSTRUMENT', retrievalPolicy: { policyVersion: 'retrieval-specificity-v2', eligibility: 'MODIFIER_ONLY' } },
      { term: 'Aksjehandel', type: 'METHOD', retrievalPolicy: { policyVersion: 'retrieval-specificity-v2', eligibility: 'MODIFIER_ONLY' } }
    ]
  };
  assert.equal(evaluateAutonomousQueryAuthority(asQueryRecord('OBX Aksjehandel', 'Norway', persistentMetadata), { scopePromotionActive: false }).eligible, false);
  const directMetadata = { ...persistentMetadata, promotionBasis: 'DIRECT_TARGET' };
  assert.equal(evaluateAutonomousQueryAuthority(asQueryRecord('OBX Aksjehandel', 'Norway', directMetadata), { scopePromotionActive: false }).eligible, true);
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
    scopePromotionBasis: 'PERSISTENT_SCOPE_SELECTION',
    retrievalSpecificity: { policyVersion: 'retrieval-specificity-v1', eligibility: 'MODIFIER_ONLY', specificity: 62, ambiguity: 48, reasonCodes: [] },
    atoms: [
      { term: 'OBX', type: 'INSTRUMENT', retrievalPolicy: { policyVersion: 'retrieval-specificity-v1', eligibility: 'MODIFIER_ONLY' } },
      { term: 'Aksjehandel', type: 'METHOD', retrievalPolicy: { policyVersion: 'retrieval-specificity-v1', eligibility: 'MODIFIER_ONLY' } }
    ]
  });
  assert.equal(evaluateAutonomousQueryAuthority(staleProvenance).eligible, false, 'stale provenance must still reject even when promoted');
  const rejected = asQueryRecord('OBX Aksjehandel', 'Norway', {
    queryTemplate: 'COMPACT_PAIR',
    scopePromotionBasis: 'PERSISTENT_SCOPE_SELECTION',
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
