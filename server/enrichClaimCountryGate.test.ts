import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldBlockEnrichClaimForCountry } from './countryExclusion';

const EXCLUSION = { country: 'India', reason: 'South Asian High-Spam Exclusion' };

test('CONFIRMED excluded creator country blocks the ENRICH claim', () => {
  assert.deepEqual(shouldBlockEnrichClaimForCountry('CONFIRMED', 'India', EXCLUSION), EXCLUSION);
});

test('predicate passes through the lookup match without re-normalizing', () => {
  // Normalization lives in findCountryExclusion/getCountryExclusion; the
  // predicate only gates on status + presence of a match.
  assert.deepEqual(shouldBlockEnrichClaimForCountry('CONFIRMED', ' india ', EXCLUSION), EXCLUSION);
});

test('LIKELY and below stay fail-open even with an exclusion match', () => {
  assert.equal(shouldBlockEnrichClaimForCountry('LIKELY', 'India', EXCLUSION), null);
  assert.equal(shouldBlockEnrichClaimForCountry('UNCERTAIN', 'India', EXCLUSION), null);
  assert.equal(shouldBlockEnrichClaimForCountry('REJECTED', 'India', EXCLUSION), null);
});

test('CONFIRMED without an exclusion match proceeds', () => {
  assert.equal(shouldBlockEnrichClaimForCountry('CONFIRMED', 'France', null), null);
  assert.equal(shouldBlockEnrichClaimForCountry('CONFIRMED', 'France', EXCLUSION), EXCLUSION);
});

test('missing country or status never blocks', () => {
  assert.equal(shouldBlockEnrichClaimForCountry('CONFIRMED', null, EXCLUSION), null);
  assert.equal(shouldBlockEnrichClaimForCountry('CONFIRMED', '  ', EXCLUSION), null);
  assert.equal(shouldBlockEnrichClaimForCountry(null, 'India', EXCLUSION), null);
  assert.equal(shouldBlockEnrichClaimForCountry(undefined, 'India', EXCLUSION), null);
});

test('creator-country claim gate runs before ENRICHING stamp and quota reservation', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const source = fs.readFileSync(path.join(process.cwd(), 'server/queueManager.ts'), 'utf8');
  const gateIdx = source.indexOf('Creator-country claim gate');
  assert.ok(gateIdx >= 0, 'claim gate exists');
  const enrichingIdx = source.indexOf("channel.scan_status = 'ENRICHING'");
  assert.ok(enrichingIdx > gateIdx, 'claim gate runs before ENRICHING is stamped');
  const quotaIdx = source.indexOf("tryReserveQuota({", gateIdx);
  assert.ok(quotaIdx > gateIdx, 'claim gate runs before quota reservation');
});

test('hydration-upgraded CONFIRMED-excluded creator is revalidated before quota', async () => {
  // Policy composition (pure, DB-free): a mention-grade bio stays
  // non-rejected, while the hydrated domicile-grade bio for the same
  // excluded country rejects — this is what the claim path re-runs after
  // hydration and before quota reservation.
  const { assessChannelCountry } = await import('./countryInference');
  const excluded = [{ country_name: 'India', reason: 'test exclusion' }];
  const before = assessChannelCountry({
    channelName: 'Harborlight Trading Academy',
    aboutBio: 'Harborlight Trading Academy is one of India\u2019s premier training institutes.',
    videoTitles: [],
    videoDescriptions: [],
    videoDescriptionsAuthoritative: false,
    playlists: []
  } as never, excluded as never, []);
  assert.notEqual(before.countryStatus, 'REJECTED');
  const after = assessChannelCountry({
    channelName: 'Harborlight Trading Academy',
    aboutBio: 'Harborlight Trading Academy is one of India\u2019s premier training institutes. Our desk is based in India.',
    videoTitles: [],
    videoDescriptions: [],
    videoDescriptionsAuthoritative: false,
    playlists: []
  } as never, excluded as never, []);
  assert.equal(after.countryStatus, 'REJECTED');
  assert.equal(after.detectedCreatorCountry, 'India');
  assert.deepEqual(
    shouldBlockEnrichClaimForCountry('CONFIRMED', after.detectedCreatorCountry, { country: 'India', reason: 'test exclusion' }),
    { country: 'India', reason: 'test exclusion' }
  );
});

test('claim revalidation runs after hydration and before quota reservation', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const source = fs.readFileSync(path.join(process.cwd(), 'server/queueManager.ts'), 'utf8');
  const hydrationIdx = source.indexOf('claimHydrationChanged');
  assert.ok(hydrationIdx >= 0, 'hydration tracking exists');
  const revalidateIdx = source.indexOf('validateChannelCountry({', hydrationIdx);
  assert.ok(revalidateIdx > hydrationIdx, 'revalidation runs after hydration');
  const quotaIdx = source.indexOf('tryReserveQuota({', revalidateIdx);
  assert.ok(quotaIdx > revalidateIdx, 'revalidation runs before quota reservation');
});
