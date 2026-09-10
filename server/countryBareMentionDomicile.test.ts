import test from 'node:test';
import assert from 'node:assert/strict';
// Regression coverage for the bare-mention domicile fix, exercised through
// assessChannelCountry — the single decision choke point used by production
// validation (validateChannelCountry) and inference alike. Synthetic fixtures
// only; no real channel names.
import { assessChannelCountry } from './countryInference';

const EXCLUDED = [
  { country_name: 'Vietnam', reason: 'test exclusion' },
  { country_name: 'Pakistan', reason: 'test exclusion' },
];

function assess(aboutBio: string, channelName = 'Edge Trading Journal') {
  return assessChannelCountry(
    {
      channelName,
      aboutBio,
      videoTitles: [],
      videoDescriptions: [],
      videoDescriptionsAuthoritative: false,
      playlists: [],
    } as never,
    EXCLUDED as never,
    [],
  );
}

test('bare Vietnam mention never hard-rejects', () => {
  const res = assess('English-language quant channel. We comment on Vietnam market opens for additional context.');
  assert.equal(res.detectedCreatorCountry, 'Vietnam');
  assert.notEqual(res.countryStatus, 'REJECTED');
  assert.notEqual(res.gateDisposition, 'REJECT_EXCLUDED');
  assert.ok(!res.countryEvidence.some(item => item.source === 'EXCLUSION_POLICY'));
});

test('bare mention of another excluded country never hard-rejects', () => {
  const res = assess('English-language quant channel. Pakistan session notes are included in the weekly review.');
  assert.equal(res.detectedCreatorCountry, 'Pakistan');
  assert.notEqual(res.countryStatus, 'REJECTED');
  assert.notEqual(res.gateDisposition, 'REJECT_EXCLUDED');
  assert.ok(!res.countryEvidence.some(item => item.source === 'EXCLUSION_POLICY'));
});

test('explicit "based in Vietnam" remains hard exclusion evidence', () => {
  const res = assess('Trader based in Vietnam covering Asian equity futures.');
  assert.equal(res.countryStatus, 'REJECTED');
  assert.equal(res.detectedCreatorCountry, 'Vietnam');
  assert.equal(res.gateDisposition, 'REJECT_EXCLUDED');
});

test('explicit "located in Vietnam" remains hard exclusion evidence', () => {
  const res = assess('Research team located in Vietnam trading global macro themes.');
  assert.equal(res.countryStatus, 'REJECTED');
  assert.equal(res.detectedCreatorCountry, 'Vietnam');
  assert.equal(res.gateDisposition, 'REJECT_EXCLUDED');
});

test('operates-from and Vietnam-based phrasing remain hard exclusion evidence', () => {
  const operates = assess('Desk operates from Vietnam during the Asia session.');
  assert.equal(operates.countryStatus, 'REJECTED');
  assert.equal(operates.detectedCreatorCountry, 'Vietnam');
  const hyphenated = assess('Vietnam-based trader sharing index futures setups.');
  assert.equal(hyphenated.countryStatus, 'REJECTED');
  assert.equal(hyphenated.detectedCreatorCountry, 'Vietnam');
});

test('article-tolerant and activity-location domicile remain hard exclusion evidence', () => {
  const article = assessChannelCountry(
    {
      channelName: 'Edge Trading Journal',
      aboutBio: 'Trader based in the Philippines covering Asian equity futures.',
      videoTitles: [],
      videoDescriptions: [],
      videoDescriptionsAuthoritative: false,
      playlists: [],
    } as never,
    [{ country_name: 'Philippines', reason: 'test exclusion' }] as never,
    [],
  );
  assert.equal(article.countryStatus, 'REJECTED');
  assert.equal(article.detectedCreatorCountry, 'Philippines');
  const active = assessChannelCountry(
    {
      channelName: 'Edge Trading Journal',
      aboutBio: 'Trader active in South Africa covering local equity markets.',
      videoTitles: [],
      videoDescriptions: [],
      videoDescriptionsAuthoritative: false,
      playlists: [],
    } as never,
    [{ country_name: 'South Africa', reason: 'test exclusion' }] as never,
    [],
  );
  assert.equal(active.countryStatus, 'REJECTED');
  assert.equal(active.detectedCreatorCountry, 'South Africa');
});

test('bare mention plus official corroboration still rejects through existing scoring', () => {
  const res = assessChannelCountry(
    {
      channelName: 'Edge Trading Journal',
      aboutBio: 'We mention Vietnam from time to time in market coverage.',
      videoTitles: [],
      videoDescriptions: [],
      videoDescriptionsAuthoritative: false,
      playlists: [],
      officialCountry: 'VN',
    } as never,
    EXCLUDED as never,
    [],
  );
  assert.equal(res.countryStatus, 'REJECTED');
  assert.equal(res.detectedCreatorCountry, 'Vietnam');
  assert.equal(res.gateDisposition, 'REJECT_EXCLUDED');
});

test('country name in unrelated context never becomes domicile evidence', () => {
  const res = assess('Documentary series on market history including Vietnam war-era trading psychology lessons.');
  assert.notEqual(res.countryStatus, 'REJECTED');
  assert.notEqual(res.gateDisposition, 'REJECT_EXCLUDED');
  assert.ok(!res.countryEvidence.some(item => item.source === 'EXCLUSION_POLICY'));
});

test('non-excluded P2 behavior is unchanged', () => {
  const res = assessChannelCountry(
    {
      channelName: 'Edge Trading Journal',
      aboutBio: 'Trader based in the United States trading equity index futures.',
      videoTitles: [],
      videoDescriptions: [],
      videoDescriptionsAuthoritative: false,
      playlists: [],
    } as never,
    EXCLUDED as never,
    [],
  );
  assert.equal(res.countryStatus, 'CONFIRMED');
  assert.equal(res.detectedCreatorCountry, 'United States');
});
