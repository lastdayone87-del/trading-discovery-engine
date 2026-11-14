import assert from 'node:assert/strict';
import test from 'node:test';
import { INITIAL_COUNTRY_VOCABULARIES } from '../src/data/initial_countries';
import {
  countryDiscoveryLanguageCandidates,
  countryDiscoveryLanguagesByWeight,
  countryDiscoveryRegionCode,
  getCountryDiscoveryProfile,
} from './countryDiscoveryProfile';
import { countrySearchHints } from './countrySearchHints';
import { detectLanguage } from './languageDetection';
import { normalizeLanguageCode } from './languageCodes';
import { isSearchableTradingTerm } from './terminologySearchability';
import { PRODUCTION_CONFIGURED_ACTIVE_COUNTRIES } from './queryQuality/profiles';

test('every supported country has one canonical discovery profile', () => {
  assert.equal(INITIAL_COUNTRY_VOCABULARIES.length, 20);
  for (const vocabulary of INITIAL_COUNTRY_VOCABULARIES) {
    const profile = getCountryDiscoveryProfile(vocabulary.country);
    assert.ok(profile, `${vocabulary.country} missing profile`);
    assert.ok(profile.regionCode.length === 2, `${vocabulary.country} region`);
    assert.ok(profile.languages.length > 0, `${vocabulary.country} languages`);
    assert.ok(profile.languages.every(language => language.code.length >= 2));
  }
  assert.equal(getCountryDiscoveryProfile('Austria'), null);
  assert.equal(getCountryDiscoveryProfile('South Korea'), null);
});

test('declared secondary languages are retained and routed to YouTube hl', () => {
  assert.deepEqual(countryDiscoveryLanguageCandidates('New Zealand'), ['en', 'mi']);
  assert.deepEqual(countryDiscoveryLanguageCandidates('Ireland'), ['en', 'ga']);
  assert.deepEqual(countryDiscoveryLanguageCandidates('Singapore'), ['en', 'ms', 'zh', 'ta']);
  assert.deepEqual(countrySearchHints('New Zealand', [], 'Māori'), { regionCode: 'NZ', relevanceLanguage: 'mi' });
  assert.deepEqual(countrySearchHints('Ireland', [], 'Irish'), { regionCode: 'IE', relevanceLanguage: 'ga' });
  assert.deepEqual(countrySearchHints('Singapore', [], 'Malay'), { regionCode: 'SG', relevanceLanguage: 'ms' });
});

test('language weights preserve primary-market order', () => {
  const newZealand = countryDiscoveryLanguagesByWeight('New Zealand');
  assert.equal(newZealand[0].code, 'en');
  assert.equal(newZealand[1].code, 'mi');
  assert.ok(newZealand[0].weight > newZealand[1].weight);
  const switzerland = countryDiscoveryLanguagesByWeight('Switzerland');
  assert.deepEqual(switzerland.map(item => item.code), ['de', 'fr', 'it']);
});

test('region and production scope include the current UAE selection', () => {
  assert.equal(countryDiscoveryRegionCode('United Arab Emirates'), 'AE');
  assert.ok((PRODUCTION_CONFIGURED_ACTIVE_COUNTRIES as readonly string[]).includes('United Arab Emirates'));
});

test('language detection recognizes Malay, Irish and Māori trading vocabulary', () => {
  assert.equal(detectLanguage('pasaran saham dan analisis teknikal', { countryHint: 'Singapore' }).language, 'ms');
  assert.equal(detectLanguage('trádáil scaireanna agus anailís theicniúil', { countryHint: 'Ireland' }).language, 'ga');
  assert.equal(detectLanguage('hokohoko haumi mahere pūtea', { countryHint: 'New Zealand' }).language, 'mi');
});

test('secondary-language hints do not claim common English or Spanish phrases', () => {
  assert.notEqual(detectLanguage('take profit trading', { countryHint: 'New Zealand' }).language, 'mi');
  assert.equal(detectLanguage('cómo hacer trading', { countryHint: 'Spain' }).language, 'es');
});

test('discovery profiles are deeply frozen', () => {
  const profile = getCountryDiscoveryProfile('Ireland');
  assert.ok(profile);
  assert.ok(Object.isFrozen(profile));
  assert.ok(Object.isFrozen(profile.languages));
  assert.ok(profile.languages.every(language => Object.isFrozen(language)));
});

test('Tagalog aliases normalize to one canonical code', () => {
  assert.equal(normalizeLanguageCode('Tagalog'), 'tl');
  assert.equal(normalizeLanguageCode('Filipino'), 'tl');
  assert.equal(normalizeLanguageCode('tl'), 'tl');
  assert.equal(normalizeLanguageCode('fil'), 'tl');
  assert.equal(normalizeLanguageCode('fil-PH'), 'tl');
});

test('Irish and Māori generated trading phrases pass the semantic gate', () => {
  assert.equal(isSearchableTradingTerm({
    term: 'trádáil scaireanna',
    termType: 'PHRASE',
    country: 'Ireland',
    language: 'ga',
    maxTokens: 6,
    requireTradingSemantics: true,
  }).eligible, true);
  assert.equal(isSearchableTradingTerm({
    term: 'hokohoko haumi',
    termType: 'PHRASE',
    country: 'New Zealand',
    language: 'mi',
    maxTokens: 6,
    requireTradingSemantics: true,
  }).eligible, true);
  assert.equal(isSearchableTradingTerm({
    term: 'bia blasta',
    termType: 'PHRASE',
    country: 'Ireland',
    language: 'ga',
    maxTokens: 6,
    requireTradingSemantics: true,
  }).eligible, false);
});
