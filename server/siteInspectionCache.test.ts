import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SITE_INSPECTION_FRESH_TTL_MS,
  SITE_INSPECTION_RETRYABLE_FAILURE_TTL_MS,
  isSiteInspectionReusable,
  buildBorrowedSiteInspection,
  siteInspectionCoversRequest,
  isSufficientRenderedCoverage,
  rootCoverageTerminal,
  mergeRedirectBinding,
  redirectBindingFor,
  redirectDestinations,
  REDIRECT_BINDING_KIND,
  checksumSiteFacts,
  type CachedSiteInspection,
} from './siteInspectionCache';
import { pruneSiteInspections } from './dbCore';

const NOW = Date.parse('2026-09-28T00:00:00.000Z');
const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();

function row(partial: Partial<CachedSiteInspection> = {}): CachedSiteInspection {
  return {
    siteIdentity: 'apextrader.com',
    identityTier: 'A',
    canonicalUrl: 'https://apextrader.com/',
    finalUrl: 'https://apextrader.com/',
    outcome: 'FOUND',
    retryable: false,
    httpStatus: 200,
    failureClass: '',
    detail: 'ok',
    payloadChecksum: 'abc',
    candidates: [],
    observations: [],
    renderedCovered: true,
    lastObservedAt: hoursAgo(1),
    ...partial,
  };
}

test('freshness TTLs follow established roadmap semantics', () => {
  assert.equal(SITE_INSPECTION_FRESH_TTL_MS, 30 * 24 * 60 * 60_000, 'matches COMMUNITY_FRESHNESS_INTERVAL_EXPIRED');
  assert.equal(SITE_INSPECTION_RETRYABLE_FAILURE_TTL_MS, 24 * 60 * 60_000, 'matches activity-cooldown scale');
});

test('reuse matrix: fresh hits borrow, expired and malformed rows recrawl', () => {
  assert.equal(isSiteInspectionReusable(row(), NOW), true);
  assert.equal(isSiteInspectionReusable(row({ lastObservedAt: hoursAgo(24 * 30 - 1) }), NOW), true);
  assert.equal(isSiteInspectionReusable(row({ lastObservedAt: hoursAgo(24 * 30 + 1) }), NOW), false, 'expired FOUND recrawls');
  assert.equal(isSiteInspectionReusable(row({ outcome: 'INSPECTED_NO_MATCH', lastObservedAt: hoursAgo(24 * 29) }), NOW), true);
  assert.equal(
    isSiteInspectionReusable(row({ outcome: 'ACQUISITION_FAILED', retryable: true, lastObservedAt: hoursAgo(23) }), NOW),
    true,
    'retryable failure borrows within 24h',
  );
  assert.equal(
    isSiteInspectionReusable(row({ outcome: 'ACQUISITION_FAILED', retryable: true, lastObservedAt: hoursAgo(25) }), NOW),
    false,
    'retryable failure recrawls after 24h',
  );
  assert.equal(
    isSiteInspectionReusable(row({ outcome: 'ACQUISITION_FAILED', retryable: false, lastObservedAt: hoursAgo(24 * 29) }), NOW),
    true,
    'non-retryable failure follows the freshness TTL',
  );
  // A redirect-limit row is non-retryable (an identical static refetch cannot
  // complete) but it inspected no page, so it must not pin 30-day freshness:
  // after the 24h window a later inspection recrawls and can still reach the
  // rendered-escalation decision a fresh crawl would make.
  const redirectLimit = (observedHoursAgo: number) => row({
    outcome: 'ACQUISITION_FAILED',
    retryable: false,
    failureClass: 'REDIRECT_LIMIT',
    lastObservedAt: hoursAgo(observedHoursAgo),
  });
  assert.equal(isSiteInspectionReusable(redirectLimit(23), NOW), true, 'redirect-limit borrows within 24h');
  assert.equal(isSiteInspectionReusable(redirectLimit(25), NOW), false, 'redirect-limit recrawls after 24h');
  assert.equal(
    isSiteInspectionReusable(row({ outcome: 'PARTIALLY_INSPECTED', lastObservedAt: hoursAgo(1) }), NOW),
    true,
    'partial borrows verbatim so retry policy sees the same result a fresh crawl would produce',
  );
  assert.equal(isSiteInspectionReusable(null, NOW), false);
  assert.equal(isSiteInspectionReusable(row({ siteIdentity: '' }), NOW), false);
  assert.equal(isSiteInspectionReusable(row({ lastObservedAt: null }), NOW), false);
  assert.equal(isSiteInspectionReusable(row({ lastObservedAt: 'not-a-date' }), NOW), false);
});

test('country-rejected FOUND cache rows are never borrowed as coverage', () => {
  const clean = row({ outcome: 'FOUND', candidates: [], lastObservedAt: hoursAgo(1) });
  assert.equal(isSiteInspectionReusable(clean, NOW), true, 'ordinary clean positives remain reusable');
  assert.equal(
    isSiteInspectionReusable(
      row({ ...clean, provenance: { coverageBorrowable: false, discardedReason: 'COUNTRY_REJECTED' } }),
      NOW,
    ),
    false,
    'a rejected, unclaimed FOUND crawl must force a fresh crawl so its invite can be re-admitted',
  );
});

test('borrowed observations refresh the audit trail but preserve site-facts', () => {
  const source = row({
    finalUrl: 'https://apextrader.com/home',
    retryable: false,
    observations: [
      { requestedUrl: 'https://apextrader.com/pricing', rootUrl: 'https://apextrader.com/pricing', finalUrl: 'https://apextrader.com/home', surface: 'CREATOR_WEBSITES', required: false, outcome: 'FOUND', retryable: false, httpStatus: 200, detail: 'x', observedAt: hoursAgo(2), telemetry: { pagesInspected: 3 } },
      { requestedUrl: 'https://apextrader.com/pricing', surface: 'CREATOR_WEBSITES', required: true, outcome: 'FOUND', retryable: false, detail: 'rendered', observedAt: hoursAgo(2) },
    ],
    candidates: [{ candidateId: 'c1', nativeInviteCode: 'apexroom', sourceUrl: 'https://apextrader.com/home' }],
    communityIntents: [{ communityPlatform: 'WHOP', communityUrl: 'https://www.whop.com/apex', intent: 'PAID', paidSignals: ['price'], privateSignals: [], observedAt: hoursAgo(2), sourcePageUrl: 'https://apextrader.com/home', extractionConfidence: 'EXPLICIT' }],
  });
  const borrowed = buildBorrowedSiteInspection(source, {
    requestedUrl: 'https://apextrader.com/',
    surface: 'CREATOR_WEBSITES',
    required: false,
    wrapperUrl: undefined,
    observedAt: new Date(NOW).toISOString(),
  });
  assert.equal(borrowed.observations.length, 2);
  const [first, second] = borrowed.observations as Array<Record<string, unknown>>;
  assert.equal(first.requestedUrl, 'https://apextrader.com/');
  assert.equal(first.rootUrl, 'https://apextrader.com/');
  assert.equal(first.finalUrl, 'https://apextrader.com/home', 'cached final URL carried over');
  assert.equal(first.observedAt, new Date(NOW).toISOString(), 'fresh audit timestamp');
  assert.equal(first.outcome, 'FOUND');
  assert.deepEqual((first.telemetry as Record<string, unknown>).pagesInspected, 3);
  assert.equal(first.required, false, 'static observation keeps its own required flag');
  assert.equal(second.required, true, 'rendered observation keeps its required flag (not the borrower default)');
  assert.equal(first.siteCacheHit, true);
  assert.equal(first.siteIdentity, 'apextrader.com');
  assert.equal(first.siteObservedAt, hoursAgo(1));
  assert.equal(borrowed.communityIntents.length, 1, 'cached community intent survives the borrow');
  assert.equal((borrowed.communityIntents[0] as Record<string, unknown>).communityPlatform, 'WHOP');
  assert.deepEqual((borrowed as unknown as Record<string, unknown>).candidates, undefined, 'borrowed inspections carry no candidates across creators');
  assert.deepEqual(borrowed.row.candidates, [], 'borrowed row is candidate-free at the API boundary');
});

test('coverage gates negative reuse but never blocks positive site-facts', () => {
  const negative = row({
    outcome: 'INSPECTED_NO_MATCH',
    canonicalUrl: 'https://apextrader.com/pricing',
    finalUrl: 'https://apextrader.com/pricing',
    observations: [
      { requestedUrl: 'https://apextrader.com/pricing', rootUrl: 'https://apextrader.com/pricing', outcome: 'INSPECTED_NO_MATCH' },
    ],
    candidates: [],
  });
  assert.equal(siteInspectionCoversRequest(negative, 'https://apextrader.com/pricing'), true, 'same covered path reuses');
  assert.equal(siteInspectionCoversRequest(negative, 'https://apextrader.com/pricing/'), true, 'trailing slash is the same page');
  assert.equal(siteInspectionCoversRequest(negative, 'https://apextrader.com/join'), false, 'uncovered path cannot reuse an absence claim');
  assert.equal(siteInspectionCoversRequest(negative, 'not a url at all !@#'), false, 'unparsable request fails toward recrawl');
  const found = row({ outcome: 'FOUND', canonicalUrl: 'https://apextrader.com/pricing', observations: [], candidates: [] });
  assert.equal(siteInspectionCoversRequest(found, 'https://apextrader.com/join'), true, 'genuine invites are site-facts, reusable across paths');
  const viaCandidate = row({
    outcome: 'INSPECTED_NO_MATCH',
    canonicalUrl: 'https://apextrader.com/',
    observations: [],
    candidates: [{ candidateId: 'c1', sourceUrl: 'https://apextrader.com/join' }],
  });
  assert.equal(siteInspectionCoversRequest(viaCandidate, 'https://apextrader.com/join'), true, 'candidate source pages count as covered');
});

test('rendered coverage requires complete processed runs, never attempts', () => {
  assert.equal(isSufficientRenderedCoverage({ complete: true, timedOut: false }, true), true, 'complete render');
  assert.equal(isSufficientRenderedCoverage({ complete: false, timedOut: true }, true), false, 'timeout is not coverage');
  assert.equal(isSufficientRenderedCoverage({ complete: false, timedOut: false }, true), false, 'partial page processing is not coverage');
  assert.equal(isSufficientRenderedCoverage({ complete: true, timedOut: false }, false), false, 'zero-page/unprocessed render is not coverage');
  assert.equal(isSufficientRenderedCoverage({ complete: false, timedOut: false }, false), false, 'unprocessed failure is not coverage');
});

test('root coverage reflects only root-page evidence, never seed aggregates', () => {
  assert.equal(rootCoverageTerminal(2, false), 'FOUND');
  assert.equal(rootCoverageTerminal(0, false), 'INSPECTED_NO_MATCH', 'clean root stays clean even when children hold invites');
  assert.equal(rootCoverageTerminal(0, true), 'PARTIALLY_INSPECTED', 'truncated root is partial, never clean');
  assert.equal(rootCoverageTerminal(-3, false), 'INSPECTED_NO_MATCH', 'negative counts clamp, never invert');
});

test('redirect bindings coexist per requested URL and resolve exactly', () => {
  const bindingA = { kind: REDIRECT_BINDING_KIND, requestedUrl: 'https://shortener.com/a', finalUrl: 'https://site-a.com/', observedAt: hoursAgo(2) } as const;
  const bindingB = { kind: REDIRECT_BINDING_KIND, requestedUrl: 'https://shortener.com/b', finalUrl: 'https://site-b.com/', observedAt: hoursAgo(1) } as const;
  let observations: Array<Record<string, unknown>> = [];
  observations = mergeRedirectBinding(observations, { ...bindingA });
  observations = mergeRedirectBinding(observations, { ...bindingB });
  assert.equal(observations.length, 2, 'distinct wrappers coexist instead of overwriting');
  const row = { outcome: 'REDIRECTED', canonicalUrl: 'https://shortener.com/b', finalUrl: 'https://site-b.com/', observations };
  assert.deepEqual(redirectBindingFor(row, 'https://shortener.com/a', NOW)?.finalUrl, 'https://site-a.com/');
  assert.deepEqual(redirectBindingFor(row, 'https://shortener.com/b', NOW)?.finalUrl, 'https://site-b.com/');
  assert.equal(redirectBindingFor(row, 'https://shortener.com/c', NOW), null, 'unseen wrapper never matches another destination');
  assert.equal(redirectBindingFor({ ...row, outcome: 'FOUND' }, 'https://shortener.com/a', NOW), null, 'non-alias rows never resolve');
  // Re-observing the same wrapper replaces its binding instead of duplicating.
  const replaced = mergeRedirectBinding(observations, { ...bindingA, finalUrl: 'https://site-a2.com/', observedAt: hoursAgo(0) });
  assert.equal(replaced.length, 2);
  assert.deepEqual(
    redirectBindingFor({ outcome: 'REDIRECTED', canonicalUrl: '', finalUrl: '', observations: replaced }, 'https://shortener.com/a', NOW)?.finalUrl,
    'https://site-a2.com/',
  );
  // Legacy single-binding rows (no bindings list) resolve exactly as before.
  const legacy = { outcome: 'REDIRECTED', canonicalUrl: 'https://go.example/start', finalUrl: 'https://dest.example/landing', observations: [] };
  assert.deepEqual(redirectBindingFor(legacy, 'https://go.example/start', NOW)?.finalUrl, 'https://dest.example/landing');
  assert.equal(redirectBindingFor(legacy, 'https://go.example/other', NOW), null);
  // Prefetch surfaces every referenced destination once.
  assert.deepEqual(redirectDestinations({ outcome: 'REDIRECTED', finalUrl: 'https://site-b.com/', observations }), ['https://site-a.com/', 'https://site-b.com/']);
  assert.deepEqual(redirectDestinations({ outcome: 'FOUND', finalUrl: 'https://x/', observations }), []);
});

test('redirect identity distinguishes scheme and port', () => {
  const bindings: Array<Record<string, unknown>> = [];
  const merged = mergeRedirectBinding(
    mergeRedirectBinding(bindings, { kind: REDIRECT_BINDING_KIND, requestedUrl: 'http://shortener.com/a', finalUrl: 'https://plain.example/', observedAt: hoursAgo(1) }),
    { kind: REDIRECT_BINDING_KIND, requestedUrl: 'https://shortener.com/a', finalUrl: 'https://secure.example/', observedAt: hoursAgo(1) },
  );
  assert.equal(merged.length, 2, 'http and https wrappers are independent bindings');
  const row = { outcome: 'REDIRECTED', canonicalUrl: 'https://shortener.com/a', finalUrl: 'https://secure.example/', observations: merged };
  assert.deepEqual(redirectBindingFor(row, 'http://shortener.com/a', NOW)?.finalUrl, 'https://plain.example/');
  assert.deepEqual(redirectBindingFor(row, 'https://shortener.com/a', NOW)?.finalUrl, 'https://secure.example/');
  const ports = mergeRedirectBinding(
    [],
    { kind: REDIRECT_BINDING_KIND, requestedUrl: 'https://host.example:8080/a', finalUrl: 'https://alt.example/', observedAt: hoursAgo(1) },
  );
  const portRow = { outcome: 'REDIRECTED', canonicalUrl: '', finalUrl: '', observations: ports };
  assert.deepEqual(redirectBindingFor(portRow, 'https://host.example:8080/a', NOW)?.finalUrl, 'https://alt.example/');
  assert.equal(redirectBindingFor(portRow, 'https://host.example/a', NOW), null, 'default port never borrows the alternate-port destination');
  // Explicit default ports normalize identically (no spurious split, no merge across schemes).
  const bare = mergeRedirectBinding([], { kind: REDIRECT_BINDING_KIND, requestedUrl: 'https://host.example/a', finalUrl: 'https://alt.example/', observedAt: hoursAgo(1) });
  assert.deepEqual(
    redirectBindingFor({ outcome: 'REDIRECTED', canonicalUrl: '', finalUrl: '', observations: bare }, 'https://host.example:443/a', NOW)?.finalUrl,
    'https://alt.example/',
    'explicit :443 matches the default-port binding',
  );
});

test('stale bindings expire individually while fresh siblings resolve', () => {
  const oldAt = new Date(NOW - 61 * 24 * 3_600_000).toISOString();
  const observations = mergeRedirectBinding(
    mergeRedirectBinding([], { kind: REDIRECT_BINDING_KIND, requestedUrl: 'https://shortener.com/old', finalUrl: 'https://old.example/', observedAt: oldAt }),
    { kind: REDIRECT_BINDING_KIND, requestedUrl: 'https://shortener.com/new', finalUrl: 'https://new.example/', observedAt: hoursAgo(1) },
  );
  const row = { outcome: 'REDIRECTED', canonicalUrl: 'https://shortener.com/new', finalUrl: 'https://new.example/', observations };
  assert.equal(redirectBindingFor(row, 'https://shortener.com/old', NOW), null, 'stale binding is not reused despite the fresh sibling');
  assert.deepEqual(redirectBindingFor(row, 'https://shortener.com/new', NOW)?.finalUrl, 'https://new.example/', 'fresh binding still resolves normally');
  assert.equal(
    redirectBindingFor(row, 'https://shortener.com/old', Date.parse(oldAt) + 60_000)?.finalUrl,
    'https://old.example/',
    'the same binding resolves inside its own window',
  );
  const malformed = mergeRedirectBinding([], { kind: REDIRECT_BINDING_KIND, requestedUrl: 'https://shortener.com/x', finalUrl: 'https://x.example/', observedAt: 'not-a-date' });
  assert.equal(
    redirectBindingFor({ outcome: 'REDIRECTED', canonicalUrl: '', finalUrl: '', observations: malformed }, 'https://shortener.com/x', NOW),
    null,
    'malformed observedAt fails closed',
  );
});
test('site-fact checksum is stable, order-insensitive, and content-sensitive', () => {
  const a = checksumSiteFacts({ outcome: 'FOUND', inviteCodes: ['b', 'a'], finalUrl: 'https://x/' });
  const b = checksumSiteFacts({ outcome: 'FOUND', inviteCodes: ['a', 'b', 'a'], finalUrl: 'https://x/' });
  assert.equal(a, b);
  assert.notEqual(a, checksumSiteFacts({ outcome: 'FOUND', inviteCodes: ['a'], finalUrl: 'https://x/' }));
  assert.notEqual(a, checksumSiteFacts({ outcome: 'INSPECTED_NO_MATCH', inviteCodes: ['a', 'b'], finalUrl: 'https://x/' }));
});

test('migration creates both tables with no creator column on the site cache', () => {
  const migration = readFileSync(new URL('./db/migrations/134_site_inspection_dedup.sql', import.meta.url), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS site_inspections/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS creator_site_links/);
  const siteBlock = migration.slice(migration.indexOf('CREATE TABLE IF NOT EXISTS site_inspections'), migration.indexOf('CREATE TABLE IF NOT EXISTS creator_site_links'));
  assert.doesNotMatch(siteBlock, /channel_id/, 'a cache hit must never import creator attribution by schema construction');
  assert.match(siteBlock, /site_identity TEXT PRIMARY KEY/);
});

test('site prune validates input without touching the database', async () => {
  assert.equal(await pruneSiteInspections(0), 0);
  assert.equal(await pruneSiteInspections(NaN), 0);
});
