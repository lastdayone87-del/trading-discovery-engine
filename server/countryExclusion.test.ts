import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { findCountryExclusion, normalizeCountryName } from './countryExclusionRules';
import { assertCountryAllowed, getCountryExclusion } from './countryExclusion';

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

test('null, undefined, and empty country input normalize to empty without throwing', () => {
  assert.equal(normalizeCountryName(null), '');
  assert.equal(normalizeCountryName(undefined), '');
  assert.equal(normalizeCountryName(''), '');
  assert.equal(normalizeCountryName('   '), '');
});

test('null country input produces no exclusion match', () => {
  assert.equal(findCountryExclusion(null, exclusions), null);
  assert.equal(findCountryExclusion(undefined, exclusions), null);
  assert.equal(findCountryExclusion('', exclusions), null);
});

test('null country input resolves as allowed without touching the database', async () => {
  await assertCountryAllowed(null, 'null-country regression');
  await assertCountryAllowed(undefined, 'null-country regression');
  await assertCountryAllowed('', 'null-country regression');
  assert.equal(await getCountryExclusion(null), null);
  assert.equal(await getCountryExclusion(undefined), null);
});

test('ENRICH worker gate passes targetCountry null instead of throwing TypeError', async () => {
  await assertCountryAllowed(null, 'enrichment_worker:regression-job-id');
});

test('operational recovery still passes channel.country through without inventing a default', () => {
  const source = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
  assert.ok(
    source.includes('targetCountry:channel.country'),
    'recovery enqueue must keep passing the nullable channel.country straight through'
  );
  assert.ok(
    !source.includes('targetCountry:channel.country||') && !source.includes('targetCountry:channel.country ??'),
    'recovery must not invent a default country'
  );
});
