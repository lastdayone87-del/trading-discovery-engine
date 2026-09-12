import assert from 'node:assert/strict';
import test from 'node:test';
import { countrySearchHints, hasCountrySearchHint, normalizeLanguageCode } from './countrySearchHints';

test('provides YouTube retrieval hints across multiple markets', () => {
  assert.deepEqual(countrySearchHints('Germany'), { regionCode: 'DE', relevanceLanguage: 'de' });
  assert.deepEqual(countrySearchHints('Canada'), { regionCode: 'CA', relevanceLanguage: 'en' });
  assert.deepEqual(countrySearchHints('Japan'), { regionCode: 'JP', relevanceLanguage: 'ja' });
  assert.deepEqual(countrySearchHints('Switzerland'), { regionCode: 'CH', relevanceLanguage: 'de' });
});

test('normalizes country spelling without inventing unsupported hints', () => {
  assert.deepEqual(countrySearchHints('  UNITED KINGDOM  '), { regionCode: 'GB', relevanceLanguage: 'en' });
  assert.deepEqual(countrySearchHints('Unsupported Market'), {});
  assert.equal(hasCountrySearchHint('France'), true);
  assert.equal(hasCountrySearchHint('Unsupported Market'), false);
});

test('retrieval hints contain no creator-country decision or confidence', () => {
  const hints = countrySearchHints('Switzerland') as Record<string, unknown>;
  assert.equal('confidence' in hints, false);
  assert.equal('countryStatus' in hints, false);
  assert.equal('detectedCountry' in hints, false);
});

test('excluded-country language names normalize instead of dropping to empty', () => {
  // Forensic: Vietnamese/Tagalog/Urdu/Bengali/Nepali previously returned ''
  // and were silently filtered from declared-language routing.
  assert.equal(normalizeLanguageCode('Vietnamese'), 'vi');
  assert.equal(normalizeLanguageCode('vietnamese'), 'vi');
  assert.equal(normalizeLanguageCode('vi'), 'vi');
  assert.equal(normalizeLanguageCode('Tagalog'), 'tl');
  assert.equal(normalizeLanguageCode('Filipino'), 'tl');
  assert.equal(normalizeLanguageCode('Urdu'), 'ur');
  assert.equal(normalizeLanguageCode('Bengali'), 'bn');
  assert.equal(normalizeLanguageCode('Bangla'), 'bn');
  assert.equal(normalizeLanguageCode('Nepali'), 'ne');
  assert.equal(normalizeLanguageCode('Sinhala'), 'si');
  assert.equal(normalizeLanguageCode('Indonesian'), 'id');
  assert.equal(normalizeLanguageCode('Hindi'), 'hi');
  assert.equal(normalizeLanguageCode('Korean'), 'ko');
  assert.equal(normalizeLanguageCode('NotALanguage!'), '');
});
