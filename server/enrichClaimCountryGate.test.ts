import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldBlockEnrichClaimForCountry } from './countryExclusion';

const EXCLUSION = { country: 'India', reason: 'South Asian High-Spam Exclusion' };

test('CONFIRMED excluded creator country blocks the ENRICH claim', () => {
  assert.deepEqual(shouldBlockEnrichClaimForCountry('CONFIRMED', 'India', EXCLUSION), EXCLUSION);
});

test('predicate verifies the match belongs to the country before blocking', () => {
  // The predicate gates on status AND verifies via normalizeCountryName that
  // the supplied exclusion belongs to this country; a stale or mismatched
  // lookup result never blocks the wrong country.
  assert.deepEqual(shouldBlockEnrichClaimForCountry('CONFIRMED', ' india ', EXCLUSION), EXCLUSION);
});

test('LIKELY and below stay fail-open even with an exclusion match', () => {
  assert.equal(shouldBlockEnrichClaimForCountry('LIKELY', 'India', EXCLUSION), null);
  assert.equal(shouldBlockEnrichClaimForCountry('UNCERTAIN', 'India', EXCLUSION), null);
  assert.equal(shouldBlockEnrichClaimForCountry('REJECTED', 'India', EXCLUSION), null);
});

test('CONFIRMED without an exclusion match proceeds', () => {
  assert.equal(shouldBlockEnrichClaimForCountry('CONFIRMED', 'France', null), null);
  assert.equal(shouldBlockEnrichClaimForCountry('CONFIRMED', 'France', { country: 'India', reason: 'test exclusion' }), null);
});

test('missing country or status never blocks', () => {
  assert.equal(shouldBlockEnrichClaimForCountry('CONFIRMED', null, EXCLUSION), null);
  assert.equal(shouldBlockEnrichClaimForCountry('CONFIRMED', '  ', EXCLUSION), null);
  assert.equal(shouldBlockEnrichClaimForCountry(null, 'India', EXCLUSION), null);
  assert.equal(shouldBlockEnrichClaimForCountry(undefined, 'India', EXCLUSION), null);
});

test('creator-country claim gate runs before ENRICHING stamp and quota reservation', async () => {
  const fs = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const source = fs.readFileSync(fileURLToPath(new URL('./queueManager.ts', import.meta.url)), 'utf8');
  const gateIdx = source.indexOf('Creator-country claim gate');
  assert.ok(gateIdx >= 0, 'claim gate exists');
  const enrichingIdx = source.indexOf("channel.scan_status = 'ENRICHING'");
  assert.ok(enrichingIdx > gateIdx, 'claim gate runs before ENRICHING is stamped');
  const quotaIdx = source.indexOf("tryReserveQuota({", gateIdx);
  assert.ok(quotaIdx > gateIdx, 'claim gate runs before quota reservation');
});

test('hydration-upgraded CONFIRMED-excluded creator is revalidated before quota', async () => {
  // Honest hydration-upgrade model (pure, DB-free): a no-evidence bio is
  // UNCERTAIN, while the hydrated domicile-grade bio for the same excluded
  // country rejects. The worker persists the UNCERTAIN row, hydrates at
  // claim, and re-runs this same policy on the hydrated evidence.
  const { assessChannelCountry } = await import('./countryInference');
  const excluded = [{ country_name: 'India', reason: 'test exclusion' }];
  const input = {
    channelName: 'Harborlight Trading Academy',
    videoTitles: [],
    videoDescriptions: [],
    videoDescriptionsAuthoritative: false,
    playlists: []
  };
  const before = assessChannelCountry({ ...input, aboutBio: 'Market hours notes.' } as never, excluded as never, []);
  assert.equal(before.countryStatus, 'UNCERTAIN');
  const after = assessChannelCountry({
    ...input,
    aboutBio: 'Harborlight Trading Academy is one of India\u2019s premier training institutes. Our desk is based in India.'
  } as never, excluded as never, []);
  assert.equal(after.countryStatus, 'REJECTED');
  assert.equal(after.detectedCreatorCountry, 'India');
  assert.deepEqual(
    shouldBlockEnrichClaimForCountry('CONFIRMED', after.detectedCreatorCountry, { country: 'India', reason: 'test exclusion' }),
    { country: 'India', reason: 'test exclusion' }
  );
});

test('quota reservation precedes hydration and the re-gate releases it on block', async () => {
  const fs = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const source = fs.readFileSync(fileURLToPath(new URL('./queueManager.ts', import.meta.url)), 'utf8');
  // Order: reserve → hydrate → re-gate. A quota-exhausted claim throws at
  // reservation and never spends the hydration fetch; a blocked re-gate
  // releases the reservation unconsumed.
  const changedAnchor = source.indexOf('candidate.locationTag !== beforeLoc;');
  assert.ok(changedAnchor >= 0, 'hydration change detection exists');
  const quotaIdx = source.lastIndexOf('tryReserveQuota({', changedAnchor);
  assert.ok(quotaIdx >= 0 && quotaIdx < changedAnchor, 'quota reservation precedes hydration');
  const revalidateIdx = source.indexOf('validateChannelCountry({', changedAnchor);
  assert.ok(revalidateIdx > changedAnchor, 'revalidation runs after hydration completes');
  const releaseIdx = source.indexOf("finishQuotaReservation('ENRICH_CHANNEL',job.id,false)", revalidateIdx);
  assert.ok(releaseIdx > revalidateIdx, 'blocked re-gate releases the reservation');
});

test('mismatched exclusion lookup never blocks the wrong country', () => {
  assert.equal(
    shouldBlockEnrichClaimForCountry('CONFIRMED', 'France', { country: 'India', reason: 'test exclusion' }),
    null
  );
  assert.deepEqual(
    shouldBlockEnrichClaimForCountry('CONFIRMED', ' india ', { country: 'India', reason: 'test exclusion' }),
    { country: 'India', reason: 'test exclusion' }
  );
});
