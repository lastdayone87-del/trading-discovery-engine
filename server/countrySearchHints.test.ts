import assert from 'node:assert/strict';
import test from 'node:test';
import { countrySearchHints, hasCountrySearchHint } from './countrySearchHints';

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
