/**
 * P2 country-before-claim ordering regressions (report section 6, E5).
 *
 * Confirmed defect class: a creator whose live About-page evidence resolves to
 * an excluded country could still persist candidates, win the global registry
 * claim, and validate an invite before the country verdict applied. Because
 * the registry has no release/reassignment path, a rejected tenant winning a
 * claim permanently blocks the real creator. Ordering is therefore
 * load-bearing: the live country verdict must decide BEFORE the authoritative
 * claim, and retry-owned reacquisition must honor stored confirmed exclusions
 * before spending a crawl/persist/claim cycle.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { shouldBlockEnrichClaimForCountry } from './countryExclusion';
import { resolveBorrowBypassForInspectionMarker } from './queueManager';

const source = readFileSync(fileURLToPath(new URL('./queueManager.ts', import.meta.url)), 'utf8');

test('live country rejection is decided before the authoritative candidate claim', () => {
  const rejectionIndex = source.indexOf("if (liveCountry.status === 'REJECTED') {");
  const claimIndex = source.indexOf('await admitInspectionDiscordCandidates(structuredCandidates,inspection.foundInvite,channel.channel_id)');
  assert.ok(rejectionIndex > 0, 'live rejection path exists');
  assert.ok(claimIndex > 0, 'choke claim call exists');
  assert.ok(rejectionIndex < claimIndex, 'a rejected creator never reaches persist/claim/validation');
  assert.match(source, /applyLiveCountryRejectionToInspected\(channel, liveCountry, now\);/);
  // The rejection branch returns without touching the claim.
  const between = source.slice(rejectionIndex, claimIndex);
  assert.match(between, /return;/, 'the rejection branch returns before claim');
  assert.ok(!between.includes('persistDiscordCandidates'), 'no candidate persistence inside the rejection path');
});

test('retry-owned reacquisition blocks stored confirmed exclusions before crawling', () => {
  const precheckIndex = source.indexOf("executionMarker?.isRetryOwnedReacquire && channel.country_status === 'CONFIRMED'");
  const crawlIndex = source.indexOf('inspection = await runChannelInspection({');
  assert.ok(precheckIndex > 0, 'stored-country pre-check exists');
  assert.ok(precheckIndex < crawlIndex, 'the pre-check runs before any crawl spend');
  assert.match(source, /executionMarker\?\.isRetryOwnedReacquire && channel\.country_status === 'CONFIRMED' && channel\.country/);
  assert.match(source, /Blocked retry-owned reacquisition before crawl\/claim/);
});

test('only proven evidence blocks the retry pre-check (CONFIRMED + matching exclusion)', () => {
  const exclusion = { country: 'Testland', reason: 'policy' } as never;
  assert.ok(shouldBlockEnrichClaimForCountry('CONFIRMED', 'Testland', exclusion), 'confirmed + match blocks');
  assert.equal(shouldBlockEnrichClaimForCountry('LIKELY', 'Testland', exclusion), null, 'unproven status stays fail-open');
  assert.equal(shouldBlockEnrichClaimForCountry('CONFIRMED', 'Otherland', exclusion), null, 'mismatched exclusion never blocks the wrong country');
  assert.equal(shouldBlockEnrichClaimForCountry('CONFIRMED', null, exclusion), null);
  assert.equal(shouldBlockEnrichClaimForCountry('CONFIRMED', 'Testland', null), null);
});

test('ENRICH claim re-validates a hydrated candidate and cancels before quota spend', () => {
  assert.match(source, /claimCountryVal\.status === 'REJECTED' && claimCreatorCountry/);
  assert.match(source, /Detected at ENRICH_CHANNEL claim after hydration for job \$\{job\.id\}; enrichment cancelled before quota spend\./);
  const rejectionIndex = source.indexOf("claimCountryVal.status === 'REJECTED' && claimCreatorCountry");
  const consumeIndex = source.indexOf('finishQuotaReservation(\'ENRICH_CHANNEL\',job.id,false)');
  assert.ok(consumeIndex > rejectionIndex, 'the rejection releases the reservation unconsumed after projecting REJECTED');
});

test('retry-owned reacquire bypasses borrowed coverage so rechecks see live evidence', () => {
  assert.equal(resolveBorrowBypassForInspectionMarker({ isRetryOwnedReacquire: true }), true);
  assert.equal(resolveBorrowBypassForInspectionMarker({}), false);
  assert.equal(resolveBorrowBypassForInspectionMarker(undefined), false);
  assert.equal(resolveBorrowBypassForInspectionMarker({ isRetryOwnedReacquire: 'yes' } as never), false, 'unknown marker shapes fail safe toward borrowing');
});
