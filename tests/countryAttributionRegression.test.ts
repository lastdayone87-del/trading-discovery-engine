import assert from 'node:assert/strict';
import test from 'node:test';
import { assessChannelCountry, inferChannelCountry } from '../server/countryInference';
import { validateChannelCountry, applyTargetCountryBoundary, retainedCreatorEvidenceInput } from '../server/countryValidator';
import { INITIAL_EXCLUDED_COUNTRIES, INITIAL_COUNTRY_VOCABULARIES } from '../src/data/initial_countries';

const EXCLUDED = INITIAL_EXCLUDED_COUNTRIES;
const VOCABS = INITIAL_COUNTRY_VOCABULARIES;
const NON_EXCLUDED_COUNTRIES = VOCABS.map(v => v.country);

test('Invariant 1: discoveryCountry can never populate detectedCreatorCountry', () => {
  for (const target of ['Canada', 'Germany', 'Nigeria', 'India', 'United States']) {
    const assessment = assessChannelCountry({ discoveryCountry: target }, EXCLUDED, VOCABS);
    assert.equal(assessment.discoveryCountry, target);
    assert.equal(assessment.detectedCreatorCountry, null);
    assert.equal(assessment.countryStatus, 'UNCERTAIN');
    assert.equal(assessment.gateDisposition, 'CONTINUE_CRAWLING');
  }
});

test('Invariant 2: detectedCreatorCountry = null means creator country remains null', () => {
  const result = inferChannelCountry({ discoveryCountry: 'Canada' }, EXCLUDED, VOCABS);
  assert.equal(result.detectedCreatorCountry, null);
  assert.equal(result.detectedCountry, null);
});

test('Invariant 3: discovery target is never used as creator-country fallback', () => {
  const assessment = assessChannelCountry({
    channelName: 'Generic FX Trader',
    aboutBio: 'Daily forex analysis and market strategy',
    discoveryCountry: 'United Kingdom'
  }, EXCLUDED, VOCABS);

  assert.equal(assessment.discoveryCountry, 'United Kingdom');
  assert.equal(assessment.detectedCreatorCountry, null);
  assert.equal(assessment.gateDisposition, 'CONTINUE_CRAWLING');
});

test('Invariant 4 & 5: excluded creator is REJECTED regardless of target country', () => {
  // Dynamically test all 29 policy countries
  for (const excludedItem of EXCLUDED) {
    const country = excludedItem.country_name;

    // Excluded creator + same target -> REJECTED
    const sameTargetResult = inferChannelCountry({
      officialCountry: country,
      discoveryCountry: country
    }, EXCLUDED, VOCABS);
    assert.equal(sameTargetResult.status, 'REJECTED', `Failed for ${country} with same target`);
    assert.equal(sameTargetResult.gateDisposition, 'REJECT_EXCLUDED');
    assert.equal(sameTargetResult.detectedCreatorCountry, country);

    // Excluded creator + different target -> REJECTED
    const diffTargetResult = inferChannelCountry({
      officialCountry: country,
      discoveryCountry: 'Canada'
    }, EXCLUDED, VOCABS);
    assert.equal(diffTargetResult.status, 'REJECTED', `Failed for ${country} with Canada target`);
    assert.equal(diffTargetResult.gateDisposition, 'REJECT_EXCLUDED');
    assert.equal(diffTargetResult.detectedCreatorCountry, country);
  }
});

test('Invariant 6 & 7: non-excluded creator is ALLOW_NORMAL regardless of target', () => {
  for (const nonExcludedCountry of ['Canada', 'Germany', 'Spain', 'Japan', 'United Kingdom']) {
    // Non-excluded creator + excluded target -> ALLOW_NORMAL (NOT REJECTED)
    const resultExcludedTarget = inferChannelCountry({
      officialCountry: nonExcludedCountry,
      discoveryCountry: 'Nigeria'
    }, EXCLUDED, VOCABS);

    assert.equal(resultExcludedTarget.status, 'CONFIRMED');
    assert.equal(resultExcludedTarget.gateDisposition, 'ALLOW_NORMAL');
    assert.equal(resultExcludedTarget.detectedCreatorCountry, nonExcludedCountry);

    // Non-excluded creator + different non-excluded target -> ALLOW_NORMAL
    const resultDiffTarget = inferChannelCountry({
      officialCountry: nonExcludedCountry,
      discoveryCountry: 'France'
    }, EXCLUDED, VOCABS);

    assert.equal(resultDiffTarget.status, 'CONFIRMED');
    assert.equal(resultDiffTarget.gateDisposition, 'ALLOW_NORMAL');
    assert.equal(resultDiffTarget.detectedCreatorCountry, nonExcludedCountry);
  }
});

test('Invariant 8 & 9: no creator country signal -> UNCERTAIN + CONTINUE_CRAWLING for both non-excluded and excluded targets', () => {
  // No creator evidence + non-excluded target
  const nonExclTargetRes = assessChannelCountry({
    channelName: 'Global Trader',
    aboutBio: 'Trading tips for everyone',
    discoveryCountry: 'Canada'
  }, EXCLUDED, VOCABS);
  assert.equal(nonExclTargetRes.detectedCreatorCountry, null);
  assert.equal(nonExclTargetRes.countryStatus, 'UNCERTAIN');
  assert.equal(nonExclTargetRes.gateDisposition, 'CONTINUE_CRAWLING');

  // No creator evidence + excluded target -> NOT REJECTED merely because target is excluded
  const exclTargetRes = assessChannelCountry({
    channelName: 'Global Trader',
    aboutBio: 'Trading tips for everyone',
    discoveryCountry: 'Nigeria'
  }, EXCLUDED, VOCABS);
  assert.equal(exclTargetRes.detectedCreatorCountry, null);
  assert.equal(exclTargetRes.countryStatus, 'UNCERTAIN');
  assert.equal(exclTargetRes.gateDisposition, 'CONTINUE_CRAWLING');
  assert.notEqual(exclTargetRes.countryStatus, 'REJECTED');
});

test('Invariant 10: bio explicitly identifies excluded country -> immediate REJECTED', () => {
  for (const excludedItem of EXCLUDED) {
    const country = excludedItem.country_name;
    const res = inferChannelCountry({
      channelName: 'Forex Pro',
      aboutBio: `Professional trader based in ${country}.`,
      discoveryCountry: 'Canada'
    }, EXCLUDED, VOCABS);

    assert.equal(res.status, 'REJECTED', `Bio identification failed for ${country}`);
    assert.equal(res.detectedCreatorCountry, country);
    assert.equal(res.gateDisposition, 'REJECT_EXCLUDED');
  }
});

test('Invariant 11: bio explicitly identifies non-excluded country -> creator country wins over discovery target', () => {
  const res = inferChannelCountry({
    channelName: 'Aussie Trader',
    aboutBio: 'Based in Sydney, Australian trader covering ASX 200.',
    discoveryCountry: 'Nigeria'
  }, EXCLUDED, VOCABS);

  assert.equal(res.detectedCreatorCountry, 'Australia');
  assert.equal(res.status, 'CONFIRMED');
  assert.equal(res.gateDisposition, 'ALLOW_NORMAL');
});

test('Invariant 12: bio inspected successfully but contains no country signal -> CONTINUE_CRAWLING', () => {
  const res = assessChannelCountry({
    channelName: 'Price Action Master',
    aboutBio: 'Master price action trading with risk management strategies.',
    discoveryCountry: 'United States'
  }, EXCLUDED, VOCABS);

  assert.equal(res.detectedCreatorCountry, null);
  assert.equal(res.countryStatus, 'UNCERTAIN');
  assert.equal(res.gateDisposition, 'CONTINUE_CRAWLING');
});

test('Invariant 13 & 14: AVAILABLE_NOT_DECLARED and UNAVAILABLE metadata statuses', () => {
  const notDeclaredRes = assessChannelCountry({
    channelName: 'No Country Declared',
    aboutBio: '',
    discoveryCountry: 'Canada',
    metadataStatus: 'AVAILABLE_NOT_DECLARED'
  }, EXCLUDED, VOCABS);

  assert.equal(notDeclaredRes.evidenceAvailability, 'AVAILABLE_NOT_DECLARED');
  assert.equal(notDeclaredRes.detectedCreatorCountry, null);
  assert.equal(notDeclaredRes.gateDisposition, 'CONTINUE_CRAWLING');

  const unavailableRes = assessChannelCountry({
    channelName: 'Unavailable Metadata',
    aboutBio: '',
    discoveryCountry: 'Canada',
    metadataStatus: 'UNAVAILABLE'
  }, EXCLUDED, VOCABS);

  assert.equal(unavailableRes.evidenceAvailability, 'UNAVAILABLE');
  assert.equal(unavailableRes.detectedCreatorCountry, null);
  assert.equal(unavailableRes.gateDisposition, 'CONTINUE_CRAWLING');
});

test('Invariant 16: weak excluded signal -> no hard rejection unless exclusion authority is met', () => {
  const res = inferChannelCountry({
    aboutBio: 'Trading the Ho Chi Minh Stock Exchange', // Priority 5 Exchange reference
    discoveryCountry: 'United Kingdom'
  }, EXCLUDED, VOCABS);

  assert.equal(res.detectedCreatorCountry, 'Vietnam');
  assert.notEqual(res.status, 'REJECTED'); // Priority 5 does not satisfy exclusion authority (requires <= 3)
  assert.equal(res.status, 'LIKELY');
});

test('Invariant 17: conflicting creator evidence -> UNCERTAIN, no arbitrary winner', () => {
  const res = inferChannelCountry({
    aboutBio: 'Trader based in United Kingdom and Nigeria',
    discoveryCountry: 'Canada'
  }, EXCLUDED, VOCABS);

  assert.equal(res.status, 'UNCERTAIN');
  assert.notEqual(res.status, 'REJECTED');
});

test('Invariant 18: trading classification cannot influence creator-country attribution', () => {
  const res = inferChannelCountry({
    channelName: 'Futures Scalper',
    aboutBio: 'High frequency NQ futures scalping journal',
    discoveryCountry: 'Canada'
  }, EXCLUDED, VOCABS);

  assert.equal(res.detectedCreatorCountry, null);
  assert.equal(res.status, 'UNCERTAIN');
});

test('Invariant 19: all 29 exclusion policy countries are tested dynamically', () => {
  assert.equal(EXCLUDED.length, 29, 'Policy must contain exactly 29 excluded countries');
  for (const item of EXCLUDED) {
    const res = inferChannelCountry({
      officialCountry: item.country_name,
      discoveryCountry: 'United States'
    }, EXCLUDED, VOCABS);
    assert.equal(res.status, 'REJECTED', `Dynamic policy test failed for ${item.country_name}`);
  }
});

test('Canonical Bug Regression: discoveryCountry = Canada, no creator evidence', () => {
  const assessment = assessChannelCountry({
    channelName: 'Candle Reader',
    aboutBio: 'Daily market thoughts',
    discoveryCountry: 'Canada'
  }, EXCLUDED, VOCABS);

  assert.equal(assessment.discoveryCountry, 'Canada');
  assert.equal(assessment.detectedCreatorCountry, null);
  assert.equal(assessment.countryStatus, 'UNCERTAIN');
  assert.equal(assessment.gateDisposition, 'CONTINUE_CRAWLING');
});

test('Canonical Exclusion Regression: discoveryCountry = Canada, About = Forex trader in Nigeria', () => {
  const assessment = assessChannelCountry({
    channelName: 'FX Master',
    aboutBio: 'Professional forex trader based in Nigeria.',
    discoveryCountry: 'Canada'
  }, EXCLUDED, VOCABS);

  assert.equal(assessment.discoveryCountry, 'Canada');
  assert.equal(assessment.detectedCreatorCountry, 'Nigeria');
  assert.equal(assessment.countryStatus, 'REJECTED');
  assert.equal(assessment.gateDisposition, 'REJECT_EXCLUDED');
});

test('Target Mismatch Regression: discoveryCountry = Nigeria, creatorCountry = Canada', () => {
  const assessment = assessChannelCountry({
    officialCountry: 'Canada',
    discoveryCountry: 'Nigeria'
  }, EXCLUDED, VOCABS);

  assert.equal(assessment.discoveryCountry, 'Nigeria');
  assert.equal(assessment.detectedCreatorCountry, 'Canada');
  assert.equal(assessment.countryStatus, 'CONFIRMED');
  assert.equal(assessment.gateDisposition, 'ALLOW_NORMAL');
});

test('retainedCreatorEvidenceInput excludes fabricated channel text, inspection trail prose, and video titles', () => {
  const input = retainedCreatorEvidenceInput({
    channel_name: 'Nigeria Forex Scalper Pro',
    country_metadata_status: 'AVAILABLE_NOT_DECLARED',
    inspection_trail: [
      { step: 'BIO', details: 'Forex trading in Nigeria and Lagos stock exchange.' }
    ]
  });

  const assessment = assessChannelCountry({
    ...input,
    discoveryCountry: 'United Kingdom'
  }, EXCLUDED, VOCABS);

  assert.equal(assessment.detectedCreatorCountry, null);
  assert.equal(assessment.countryStatus, 'UNCERTAIN');
  assert.equal(assessment.gateDisposition, 'CONTINUE_CRAWLING');
});
