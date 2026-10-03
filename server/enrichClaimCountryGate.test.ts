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
