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

test('normalizeLanguageCode validates full tags and three-letter primaries', () => {
  // Malformed tags must not borrow a valid prefix.
  assert.equal(normalizeLanguageCode('de-!!'), '');
  assert.equal(normalizeLanguageCode('en-'), '');
  assert.equal(normalizeLanguageCode('-de'), '');
  assert.equal(normalizeLanguageCode('de--DE'), '');
  assert.equal(normalizeLanguageCode(''), '');
  // Valid ISO 639-2 three-letter primary subtags are accepted.
  assert.equal(normalizeLanguageCode('fil-PH'), 'fil');
  assert.equal(normalizeLanguageCode('yue'), 'yue');
  // Well-formed tags behave exactly as before (primary subtag only).
  assert.equal(normalizeLanguageCode('de'), 'de');
  assert.equal(normalizeLanguageCode('de-DE'), 'de');
  assert.equal(normalizeLanguageCode('zh-Hant-TW'), 'zh');
  assert.equal(normalizeLanguageCode('pt_BR'), 'pt');
  assert.equal(normalizeLanguageCode('es-419'), 'es');
  assert.equal(normalizeLanguageCode('sr-Latn'), 'sr');
  // Non-string input never fabricates a code.
  assert.equal(normalizeLanguageCode(undefined as unknown as string), '');
});

test('normalizeLanguageCode enforces BCP 47 structure and registry', () => {
  // Structurally malformed tags die even with valid prefixes.
  assert.equal(normalizeLanguageCode('de-12'), '');
  assert.equal(normalizeLanguageCode('de-abc'), '');
  assert.equal(normalizeLanguageCode('en-'), '');
  assert.equal(normalizeLanguageCode('-de'), '');
  // Valid extensions and private use survive with the primary returned.
  assert.equal(normalizeLanguageCode('de-u-co-phonebk'), 'de');
  assert.equal(normalizeLanguageCode('en-x-custom'), 'en');
  assert.equal(normalizeLanguageCode('es-419'), 'es');
  // Assigned primaries pass, including three-letter ISO 639-2/3 codes.
  assert.equal(normalizeLanguageCode('fil-PH'), 'fil');
  assert.equal(normalizeLanguageCode('yue'), 'yue');
  assert.equal(normalizeLanguageCode('ckb'), 'ckb');
  // Unassigned codes fail closed even when well-shaped.
  assert.equal(normalizeLanguageCode('qzz'), '');
  assert.equal(normalizeLanguageCode('zzz'), '');
  assert.equal(normalizeLanguageCode('xx'), '');
  // Non-informative specials carry no context.
  assert.equal(normalizeLanguageCode('und'), '');
  assert.equal(normalizeLanguageCode('mul'), '');
  assert.equal(normalizeLanguageCode('zxx'), '');
  // Underscore separators are tolerated (provider habit), canonical alias resolved.
  assert.equal(normalizeLanguageCode('pt_BR'), 'pt');
  assert.equal(normalizeLanguageCode('iw'), 'he');
  // Codes without display data fail closed (documented limitation).
  assert.equal(normalizeLanguageCode('tlh'), '');
});

test('normalizeLanguageCode rejects prototype pollution and unassigned codes', () => {
  // Inherited object members are truthy non-strings: hasOwn guard drops them.
  assert.equal(normalizeLanguageCode('constructor'), '');
  assert.equal(normalizeLanguageCode('__proto__'), '');
  assert.equal(normalizeLanguageCode('toString'), '');
  assert.equal(normalizeLanguageCode('hasOwnProperty'), '');
});
