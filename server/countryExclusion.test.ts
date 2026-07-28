import assert from 'node:assert/strict';
import test from 'node:test';
import { findCountryExclusion, normalizeCountryName } from './countryExclusionRules';

const exclusions = [
  { country_name: 'South Africa', reason: 'Regional exclusion' },
  { country_name: 'India', reason: 'Configured exclusion' }
];

test('normalizes case, surrounding whitespace, and repeated whitespace', () => {
  assert.equal(normalizeCountryName('  SOUTH   Africa '), 'south africa');
});

test('matches a configured exclusion after normalization', () => {
  assert.deepEqual(findCountryExclusion(' south  AFRICA ', exclusions), {
    country: 'South Africa',
    reason: 'Regional exclusion'
  });
});

test('does not reject a country absent from the configured list', () => {
  assert.equal(findCountryExclusion('Germany', exclusions), null);
});
