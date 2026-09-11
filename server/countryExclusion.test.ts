import assert from 'node:assert/strict';
import test from 'node:test';
import { findCountryExclusion, normalizeCountryName } from './countryExclusionRules';
import { assertCountryAllowed, getCountryExclusion } from './countryExclusion';
import { buildOperationalEnrichmentRecoveryPayload } from './queueManager';
import type { DiscoverySource } from '../src/types';

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

test('operational recovery with unknown channel country yields a claimable null-target payload', async () => {
  const payload = buildOperationalEnrichmentRecoveryPayload({
    channel_id: 'UC-jzTZ9mii7weX9XvUxPswA',
    channel_name: 'Trade Vision',
    youtube_url: 'https://www.youtube.com/channel/UC-jzTZ9mii7weX9XvUxPswA',
    country: null,
    discovery_source: 'recovery' as DiscoverySource,
    subscriber_count: '1840',
    channel_thumbnail_url: null
  }, ['OPERATIONAL_RECOVERY_COOLDOWN_EXPIRED']);
  assert.equal(payload.targetCountry, null);
  assert.equal(payload.candidate.locationTag, null);
  assert.ok(!JSON.stringify(payload).includes('United States'), 'no default country may be invented anywhere in the payload');
  // The resulting payload must pass the same country gate the ENRICH worker enforces.
  await assertCountryAllowed(payload.targetCountry, 'enrichment_worker:recovery-regression');
});

test('operational recovery preserves a known channel country verbatim', () => {
  const payload = buildOperationalEnrichmentRecoveryPayload({
    channel_id: 'UC-known',
    channel_name: 'Known Creator',
    youtube_url: 'https://www.youtube.com/channel/UC-known',
    country: 'Germany',
    discovery_source: 'recovery' as DiscoverySource,
    subscriber_count: '100',
    channel_thumbnail_url: null
  }, ['OPERATIONAL_RECOVERY_COOLDOWN_EXPIRED']);
  assert.equal(payload.targetCountry, 'Germany');
  assert.equal(payload.candidate.locationTag, 'Germany');
});
