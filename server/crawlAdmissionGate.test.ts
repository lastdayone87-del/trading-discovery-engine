import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeExternalUrl, crawlExternalLinks as crawlExternalLinksImpl, runChannelInspection as runChannelInspectionImpl } from './inspector';
import { crawlExternalLinksForTest as crawlExternalLinks, runChannelInspectionForTest as runChannelInspection } from './testCrawlHelpers';
import {
  assessCrawlAdmission,
  recoverTruncatedQueryToRoot,
  isPossiblyTruncatedPath,
  scoreCommunitySurface,
} from './communitySurfacePolicy';
import { communityAcquisitionRetryDirective } from './communityRetryPolicy';
import type { BrowserFallbackResult } from './browserCommunityFallback';

const html = (body: string) =>
  new Response(`<html><body>${body}</body></html>`, { status: 200, headers: { 'content-type': 'text/html' } });
const noInviteHtml = async () => html('No Discord invite here');
const emptyRendered = async (seedUrl: string): Promise<BrowserFallbackResult> => ({
  foundInvite: null,
  foundLocation: seedUrl,
  inspectedPages: 1,
  scrolls: 0,
  clicks: 0,
  complete: true,
  retryable: false,
  detail: 'test rendered surface inspected without invite',
});
const fillers = ['one', 'two', 'three', 'four', 'five'];

// 1. https://g/ is rejected before scoring/crawling (generic DOTLESS_HOST,
// not a "g" blacklist).
test('R6: https://g/ is rejected before scoring or crawling', async () => {
  assert.deepEqual(assessCrawlAdmission('https://g/'), { eligible: false, reasonCode: 'DOTLESS_HOST' });
  assert.equal(normalizeExternalUrl('https://g/'), null);
  const fetched: string[] = [];
  const result = await runChannelInspection({
    channelId: 'r6-g-rejected',
    channelName: 'R6 G Channel',
    channelBio: 'Trading notes',
    channelLinks: ['https://g/'],
    videoDescriptions: fillers,
    creatorLikelyTrading: true,
    externalFetchImpl: (async (input) => {
      fetched.push(String(input));
      return noInviteHtml();
    }) as typeof fetch,
    renderedFallback: emptyRendered,
  });
  assert.ok(!fetched.some((url) => url.includes('https://g/')));
  assert.ok(!(result.acquisitionOutcomes || []).some((item) => item.requestedUrl === 'https://g/'));
  const trail = JSON.stringify(result.steps || []);
  assert.ok(!trail.includes('[Crawling] https://g/'), 'rejected seed must never receive a priority score or queue entry');
  assert.ok(trail.includes('Admission rejected (DOTLESS_HOST): https://g/'));
  assert.ok(!trail.includes('Dotless single-label host note'), 'dead post-gate branch must not appear in the trail');
});

// 2. Generic dotless hosts are rejected, not just "g".
test('R6: generic dotless single-label hosts are rejected', () => {
  for (const raw of [
    'https://pea/',
    'https://peak/',
    'https://a/',
    'https://example',
    'https://ba/',
    'https://daytradertools/',
    'http://dax-academy/',
    'g',
    'https://example./',
    'not-a-url',
  ]) {
    const decision = assessCrawlAdmission(raw);
    assert.equal(decision.eligible, false, `expected rejection: ${raw}`);
    assert.ok(
      decision.reasonCode === 'DOTLESS_HOST' || decision.reasonCode === 'INVALID_URL',
      `unexpected reason for ${raw}: ${decision.reasonCode}`,
    );
    assert.equal(normalizeExternalUrl(raw), null, `normalize must reject: ${raw}`);
  }
  // Dotted hosts with empty labels are malformed as well.
  assert.deepEqual(assessCrawlAdmission('https://.com/').reasonCode, 'EMPTY_LABEL');
  assert.deepEqual(assessCrawlAdmission('https://example..com/').reasonCode, 'EMPTY_LABEL');
});

// 3. Truncated/malformed forms: deterministically invalid rejected; T-Q
// recovers to host root on the sibling-key prefix rule; T-P is signal-only.
test('R6: truncated query recovers to host root on sibling-key prefix evidence', () => {
  // No sibling evidence → no recovery (never guess without corpus).
  assert.equal(recoverTruncatedQueryToRoot('https://takeprofittrader.com/?referra', new Set()), null);
  assert.equal(
    recoverTruncatedQueryToRoot('https://takeprofittrader.com/?referra', new Set(['referralCode'])),
    'https://takeprofittrader.com/',
  );
  // Valued queries and multi-part queries are never treated as truncated.
  assert.equal(
    recoverTruncatedQueryToRoot('https://takeprofittrader.com/?referralCode=BRANDON', new Set(['referralCode'])),
    null,
  );
  assert.equal(recoverTruncatedQueryToRoot('https://example.com/?a=1&b=2', new Set(['a', 'b'])), null);
});

test('R6: truncated production URLs recover in inspection while preserving the domain', async () => {
  const fetched: string[] = [];
  const result = await runChannelInspection({
    channelId: 'r6-trunc-recover',
    channelName: 'R6 Trunc Channel',
    channelBio: 'Trading notes',
    channelLinks: ['https://takeprofittrader.com/?referra', 'https://takeprofittrader.com/?referralCode=BRANDON'],
    videoDescriptions: fillers,
    creatorLikelyTrading: false,
    externalFetchImpl: (async (input) => {
      fetched.push(String(input));
      return noInviteHtml();
    }) as typeof fetch,
    renderedFallback: emptyRendered,
  });
  const trail = JSON.stringify(result.steps || []);
  assert.ok(
    trail.includes(
      'Recovered truncated query to host root (TRUNCATED_QUERY_PREFIX): https://takeprofittrader.com/?referra → https://takeprofittrader.com/',
    ),
  );
  assert.ok(fetched.some((url) => url === 'https://takeprofittrader.com/'), 'recovered root must be crawled');
  assert.ok(
    !fetched.some((url) => /[?&]referra($|[&#])/.test(url)),
    'truncated query must not be crawled',
  );
});

test('R6: possibly truncated paths stay eligible with a log-only signal', () => {
  assert.equal(
    isPossiblyTruncatedPath('https://oiltradingacademy.com/day-tra', new Set(['/day-trading-guide'])),
    true,
  );
  assert.equal(isPossiblyTruncatedPath('https://oiltradingacademy.com/day-tra', new Set(['/other'])), false);
  // Real short slugs are not flagged without longer-sibling evidence.
  assert.equal(isPossiblyTruncatedPath('https://example.com/blog', new Set(['/about'])), false);
});

// 4. Valid dotted trading/community domains remain eligible.
test('R6: valid dotted trading and community domains remain eligible', () => {
  for (const raw of [
    'https://creator.example.com/guide',
    'https://bookmap.com/members/aff/go/spyda96?i=19',
    'https://ttwtrader.com/',
    'https://tradesaber.com/predator-series?ts=25',
    'https://linktr.ee/creator',
    'https://www.tradingview.com/',
    'https://g.co/',
    'https://takeprofittrader.com/?referralCode=BRANDON',
    'https://oiltradingacademy.com/day-trading-guide',
    // Encoded spaces are ordinary slug separators, not a script declaration.
    'https://creator.example.com/Let%20Me%20Trade',
    'https://creator.example.com/learn/let%20me%20trade',
    // A directory named `images` can still hold an HTML community page; a bare
    // asset-like root is not proof of an asset either.
    'https://creator.example.com/images',
    'https://creator.example.com/images/',
    'https://creator.example.com/images/community',
    'https://t.me/photos',
    'https://bit.ly/icons',
    // Only the Cloudinary delivery host is asset-only.
    'https://cloudinary.com/documentation',
  ]) {
    assert.deepEqual(assessCrawlAdmission(raw), { eligible: true, reasonCode: 'ELIGIBLE' }, raw);
    assert.ok(normalizeExternalUrl(raw), `normalize must admit: ${raw}`);
  }
});

// 5. Private/reserved IP literals are rejected at admission; public IPs remain
// eligible because the existing URL model supports them.
test('R6: private/reserved IP literals are rejected while public IPs remain eligible', () => {
  for (const raw of [
    'https://192.168.0.1/',
    'http://127.0.0.1/',
    'http://10.0.0.5/',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/',
    'http://[fc00::1]/',
    'http://[::ffff:127.0.0.1]/',
  ]) {
    assert.deepEqual(assessCrawlAdmission(raw), { eligible: false, reasonCode: 'NON_PUBLIC_ADDRESS' }, raw);
    assert.equal(normalizeExternalUrl(raw), null, `normalize must reject: ${raw}`);
  }
  for (const raw of ['https://8.8.8.8/', 'http://[2606:4700:4700::1111]/']) {
    assert.deepEqual(assessCrawlAdmission(raw), { eligible: true, reasonCode: 'ELIGIBLE' }, raw);
    assert.ok(normalizeExternalUrl(raw), `normalize must admit: ${raw}`);
  }
});

// 6. Known asset/resource URLs cannot enter the website crawler.
test('R6: asset and resource URLs are rejected on every admission path', async () => {
  const assets = [
    'https://i.ytimg.com/vi/abc/hqdefault.jpg',
    'https://rr1---sn-p5qs7n6y.googlevideo.com/initplayback?x=1',
    'http://schema.org/Person',
    'https://fonts.googleapis.com/css2?family=Roboto',
    'https://creator.example.com/app.js',
    'https://creator.example.com/style.css',
  ];
  for (const raw of assets) {
    const decision = assessCrawlAdmission(raw);
    assert.equal(decision.eligible, false, `expected rejection: ${raw}`);
    assert.ok(
      decision.reasonCode === 'ASSET_HOST' || decision.reasonCode === 'RESOURCE_EXTENSION',
      `unexpected reason for ${raw}: ${decision.reasonCode}`,
    );
    assert.equal(normalizeExternalUrl(raw), null, `normalize must reject: ${raw}`);
  }
  // Direct crawler path: skipped without fetch or observation.
  const logDetails: string[] = [];
  const fetched: string[] = [];
  const result = await crawlExternalLinks(
    ['https://i.ytimg.com/vi/abc/hqdefault.jpg', 'https://creator.example.com/guide'],
    logDetails,
    undefined,
    (async (input) => {
      fetched.push(String(input));
      return noInviteHtml();
    }) as typeof fetch,
  );
  assert.ok(fetched.every((url) => !url.includes('ytimg.com')), 'asset seed must never be fetched');
  assert.ok(!result.observations.some((item) => item.requestedUrl.includes('ytimg.com')));
  assert.ok(logDetails.some((line) => line.includes('Admission rejected (ASSET_HOST)')));
});

// 6b. Non-page/malformed noise from indiscriminate dynamic-attribute
// extraction is rejected at the same shared boundary, before fetch/enqueue.
test('R6: non-page and malformed URL noise is rejected before fetch or enqueue', async () => {
  const cases: Array<[string, string]> = [
    ['https://takeprofittrader.com/%7B%7Blink%7D%7D', 'MALFORMED_URL'],
    // A malformed escape must not shield the well-formed artifacts around it,
    // including escapes exposed only after the fallback decoding pass.
    ['https://takeprofittrader.com/%7B%7Blink%7D%7D%ZZ', 'MALFORMED_URL'],
    ['https://creator.example.com/%257B%257Blink%257D%257D%ZZ', 'MALFORMED_URL'],
    ['https://creator.example.com/%252Ejs%ZZ', 'RESOURCE_EXTENSION'],
    ['https://creator.example.com/%76ar%20x=1', 'MALFORMED_URL'],
    ['https://creator.example.com/${link}', 'MALFORMED_URL'],
    ['https://hftcode.com/d,a.onload=function()%7Bthis.media=%22all%22...', 'MALFORMED_URL'],
    ['https://www.tradingview.com/social-network/%22%22;', 'MALFORMED_URL'],
    ['https://creator.example.com/var%20x=1', 'MALFORMED_URL'],
    ['https://creator.example.com/let%20x=1', 'MALFORMED_URL'],
    ['https://creator.example.com/const%20x=1', 'MALFORMED_URL'],
    ['https://creator.example.com/function()%20return', 'MALFORMED_URL'],
    ['https://creator.example.com/document.write(1)', 'MALFORMED_URL'],
    ['https://creator.example.com/window.location=https://evil.test', 'MALFORMED_URL'],
    ['https://creator.example.com/this.media=all', 'MALFORMED_URL'],
    ['https://fundednext.com/images/join-community/discord-card.png&w=1920&q=75%22/', 'RESOURCE_EXTENSION'],
    ['https://creator.example.com/card.avif', 'RESOURCE_EXTENSION'],
    ['https://creator.example.com/img.png?w=100', 'RESOURCE_EXTENSION'],
    ['https://scontent-lhr8-1.xx.fbcdn.net/v/t1.6435-9/abc.jpg', 'ASSET_HOST'],
    ['https://res.cloudinary.com/demo/image/upload/sample.jpg', 'ASSET_HOST'],
    ['https://i0.wp.com/example.com/image.png', 'ASSET_HOST'],
    ['https://images.weserv.nl/?url=example.com/image.png', 'ASSET_HOST'],
    ['https://cdn.jsdelivr.net/npm/pkg/dist/app.js', 'ASSET_HOST'],
  ];
  for (const [raw, reasonCode] of cases) {
    assert.deepEqual(assessCrawlAdmission(raw), { eligible: false, reasonCode }, raw);
    assert.equal(normalizeExternalUrl(raw), null, `normalize must reject: ${raw}`);
  }

  // Direct crawler path: noise is skipped without a fetch or observation.
  const logDetails: string[] = [];
  const fetched: string[] = [];
  const result = await crawlExternalLinks(
    ['https://takeprofittrader.com/%7B%7Blink%7D%7D', 'https://creator.example.com/community'],
    logDetails,
    undefined,
    (async (input) => {
      fetched.push(String(input));
      return noInviteHtml();
    }) as typeof fetch,
  );
  assert.ok(!fetched.some((url) => url.includes('takeprofittrader.com')), 'malformed seed must never be fetched');
  assert.ok(!result.observations.some((item) => item.requestedUrl.includes('takeprofittrader.com')));
  assert.ok(logDetails.some((line) => line.includes('Admission rejected (MALFORMED_URL)')));
  assert.ok(fetched.some((url) => url.includes('creator.example.com/community')), 'legitimate page still crawls');
});

// 6c. The filter must never drop legitimate HTML pages or valid community
// links. Dots in slugs, image words in page names, query parameters, apostrophes,
// document types, shorteners, social profiles, and invite hosts stay eligible.
test('R6: legitimate HTML pages and community links survive the non-page filter', () => {
  const valid = [
    'https://creator.example.com/community/join',
    'https://creator.example.com/blog/v1.2/getting-started',
    'https://creator.example.com/gallery?w=1920&q=75',
    'https://creator.example.com/app.js.html',
    'https://creator.example.com/blog/using-.js-files',
    'https://creator.example.com/images-and-media',
    "https://creator.example.com/o'brien-community",
    'https://creator.example.com/search?q=%22quoted%22',
    'https://creator.example.com/report.pdf',
    'https://creator.example.com/files/document.pdf',
    'https://creator.example.com/window.html',
    'https://creator.example.com/let-s-trade-community',
    'https://creator.example.com/function/community',
    'https://creator.example.com/var/log',
    'https://creator.example.com/projects/three.js/community',
    'https://creator.example.com/topics/vue.js/discord',
    'https://linktr.ee/creator',
    'https://bit.ly/creator',
    'https://www.tradingview.com/u/creator/',
    'https://t.me/tradingroom',
    'https://www.instagram.com/creator/',
    'https://x.com/creator',
    'https://discord.com/invite/abc123',
    'https://discordapp.com/invite/abc123',
  ];
  for (const raw of valid) {
    assert.deepEqual(assessCrawlAdmission(raw), { eligible: true, reasonCode: 'ELIGIBLE' }, raw);
  }
});

// 7. Ambiguous commercial pages stay eligible (approved R6 scope: no broad
// commercial rejection — invalidity/resource status alone decides).
test('R6: ambiguous commercial pages without resource signals stay eligible', () => {
  for (const raw of [
    'https://www.amazon.com/Gambler-Trader-Gambling-Markets-Structure/dp/B0GVMN5ZNL',
    'https://calendly.com/business-hartman',
    'https://open.spotify.com/episode/1L6g5EWTbpOOoc00WtBEyU',
    'https://payhip.com/Tradosaure',
  ]) {
    assert.deepEqual(assessCrawlAdmission(raw), { eligible: true, reasonCode: 'ELIGIBLE' }, raw);
  }
});

// 8. Ambiguous unfamiliar domains are NOT rejected for lacking trading keywords.
test('R6: unfamiliar domains without trading keywords remain eligible', () => {
  for (const raw of [
    'https://unfamiliar-trading-xyz.test/community',
    'https://welcox.com/blog',
    'https://kiki.com/shop',
    'https://example-creator-site.test/',
  ]) {
    assert.deepEqual(assessCrawlAdmission(raw), { eligible: true, reasonCode: 'ELIGIBLE' }, raw);
    assert.ok(normalizeExternalUrl(raw), `normalize must admit: ${raw}`);
  }
});

// 9. A valid high-relevance trading URL keeps normal scoring and crawls.
test('R6: valid trading URLs keep normal scoring semantics and crawl', async () => {
  // Scoring semantics locked: CHANNEL_LINKS + custom-domain boost = 85.
  assert.equal(
    scoreCommunitySurface({ url: 'https://creator.example.com/guide', contextMatches: false, source: 'CHANNEL_LINKS' }),
    85,
  );
  const fetched: string[] = [];
  const result = await runChannelInspection({
    channelId: 'r6-valid-crawls',
    channelName: 'R6 Valid Channel',
    channelBio: 'Trading notes',
    channelLinks: ['https://creator.example.com/guide'],
    videoDescriptions: fillers,
    creatorLikelyTrading: false,
    externalFetchImpl: (async (input) => {
      fetched.push(String(input));
      return noInviteHtml();
    }) as typeof fetch,
    renderedFallback: emptyRendered,
  });
  assert.ok(fetched.some((url) => url.includes('creator.example.com/guide')));
  assert.ok(
    (result.acquisitionOutcomes || []).some(
      (item) => item.requestedUrl === 'https://creator.example.com/guide',
    ),
  );
});

// 10. Rejected candidates cannot reach the crawler (mixed admission).
test('R6: mixed seeds admit only eligible candidates', async () => {
  const fetched: string[] = [];
  const result = await runChannelInspection({
    channelId: 'r6-mixed-admission',
    channelName: 'R6 Mixed Channel',
    channelBio: 'Trading notes',
    channelLinks: [
      'https://g/',
      'https://i.ytimg.com/vi/abc/hqdefault.jpg',
      'https://creator.example.com/guide',
    ],
    videoDescriptions: fillers,
    creatorLikelyTrading: false,
    externalFetchImpl: (async (input) => {
      fetched.push(String(input));
      return noInviteHtml();
    }) as typeof fetch,
    renderedFallback: emptyRendered,
  });
  assert.ok(fetched.some((url) => url.includes('creator.example.com/guide')));
  assert.ok(!fetched.some((url) => url.includes('https://g/') || url.includes('ytimg.com')));
  const trail = JSON.stringify(result.steps || []);
  assert.ok(trail.includes('Admission rejected (DOTLESS_HOST): https://g/'));
  assert.ok(trail.includes('Admission rejected (ASSET_HOST): https://i.ytimg.com/vi/abc/hqdefault.jpg'));
  assert.ok(!trail.includes('[Crawling] https://g/'));
});

// 11. Permanently invalid/irrelevant candidates cannot enter the retry loop.
test('R6: admission-rejected and permanently failed candidates own no retry', () => {
  // Backlog-shaped rows for admission-rejected URLs (required + retryable)
  // must not own retries even though they predate the gate.
  assert.equal(
    communityAcquisitionRetryDirective([
      { requestedUrl: 'https://g/', surface: 'CREATOR_WEBSITES', required: true, outcome: 'ACQUISITION_FAILED', retryable: true, failureClass: 'NETWORK_FAILURE' },
    ] as never),
    undefined,
  );
  assert.equal(
    communityAcquisitionRetryDirective([
      { requestedUrl: 'https://i.ytimg.com/vi/abc/hqdefault.jpg', surface: 'CREATOR_WEBSITES', required: true, outcome: 'ACQUISITION_FAILED', retryable: true, failureClass: 'HTTP_ERROR' },
    ] as never),
    undefined,
  );
  // Deterministically permanent failure class never retries, even on an
  // otherwise eligible URL.
  assert.equal(
    communityAcquisitionRetryDirective([
      { requestedUrl: 'https://creator.example.com/app', surface: 'CREATOR_WEBSITES', required: true, outcome: 'ACQUISITION_FAILED', retryable: true, failureClass: 'UNSUPPORTED_CONTENT_TYPE' },
    ] as never),
    undefined,
  );
});

// 12. Genuine transient failures remain retryable.
test('R6: transient failures on eligible URLs remain retryable', () => {
  for (const failureClass of ['NETWORK_FAILURE', 'TIMEOUT', 'RATE_LIMIT', 'TRANSIENT_HTTP']) {
    const directive = communityAcquisitionRetryDirective([
      { requestedUrl: 'https://creator.example.com/guide', surface: 'CREATOR_WEBSITES', required: true, outcome: 'ACQUISITION_FAILED', retryable: true, failureClass },
    ] as never);
    assert.ok(directive, `expected retry for ${failureClass}`);
    assert.equal(directive?.retryReason, 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE');
  }
});

// REVIEW FIX 1: percent-encoded resource suffixes cannot bypass admission.
test('R6 review: encoded resource extensions are rejected without throwing', () => {
  for (const raw of [
    'https://creator.example.com/app%2Ejs',
    'https://creator.example.com/app%2ecss',
    'https://creator.example.com/img%2Epng',
    'https://creator.example.com/app%252Ejs',
    'https://creator.example.com/app%.js',
  ]) {
    const decision = assessCrawlAdmission(raw);
    assert.equal(decision.eligible, false, `expected rejection: ${raw}`);
    assert.equal(decision.reasonCode, 'RESOURCE_EXTENSION', `unexpected reason for ${raw}`);
    assert.equal(normalizeExternalUrl(raw), null, `normalize must reject: ${raw}`);
  }
  // Encoded dots outside a resource suffix, and legitimate encoded queries,
  // stay eligible: decoding applies to extension classification only.
  for (const raw of [
    'https://creator.example.com/search?q=a%2Eb',
    'https://creator.example.com/100%25leads',
    'https://creator.example.com/guide',
  ]) {
    assert.deepEqual(assessCrawlAdmission(raw), { eligible: true, reasonCode: 'ELIGIBLE' }, raw);
    assert.ok(normalizeExternalUrl(raw), `normalize must admit: ${raw}`);
  }
});

// REVIEW FIX 2: an explicitly stored empty requestedUrl can never own retry
// work, while a missing requestedUrl keeps backward-compatible behavior.
test('R6 review: empty requestedUrl owns no retry, missing stays eligible', () => {
  assert.equal(
    communityAcquisitionRetryDirective([
      { requestedUrl: '', surface: 'CREATOR_WEBSITES', required: true, outcome: 'ACQUISITION_FAILED', retryable: true, failureClass: 'NETWORK_FAILURE' },
    ] as never),
    undefined,
  );
  const legacy = communityAcquisitionRetryDirective([
    { surface: 'CREATOR_WEBSITES', required: true, outcome: 'ACQUISITION_FAILED', retryable: true, failureClass: 'NETWORK_FAILURE' },
  ] as never);
  assert.ok(legacy, 'missing requestedUrl preserves existing retry behavior');
  assert.equal(legacy?.retryReason, 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE');
});

// REVIEW FIX 3: discovered child/navigation URLs pass the shared admission
// boundary before scoring, fetching, or queue-cap accounting.
test('R6 review: rejected discovered children never reach fetch or navigation', async () => {
  const fetched: string[] = [];
  const result = await crawlExternalLinks(
    ['https://creator.example.com/'],
    [],
    undefined,
    (async (input) => {
      fetched.push(String(input));
      const url = String(input);
      if (url === 'https://creator.example.com/') {
        return html(
          '<a href="/community-help.js">community files</a>' +
            '<a href="https://g/">g community hub</a>' +
            '<div data-href="/community-widget.css">x</div>' +
            '<a href="/community-guide">community guide</a>',
        );
      }
      return noInviteHtml();
    }) as typeof fetch,
  );
  assert.ok(!fetched.some((url) => url.includes('community-help.js')), 'asset child must never be fetched');
  assert.ok(!fetched.some((url) => url.includes('community-widget.css')), 'dynamic asset child must never be fetched');
  assert.ok(!fetched.some((url) => url === 'https://g/'), 'dotless child must never be fetched');
  assert.ok(fetched.some((url) => url === 'https://creator.example.com/community-guide'), 'legitimate child stays eligible');
  const seedObservation = result.observations.find((item) => item.requestedUrl === 'https://creator.example.com/');
  const drops = (seedObservation?.telemetry as { dropReasons?: Record<string, number> } | undefined)?.dropReasons || {};
  assert.ok((drops['admission-rejected'] || 0) >= 3, `expected admission-rejected drops, got ${JSON.stringify(drops)}`);
});

// REVIEW FIX 4: admission-rejected sitemap inventory URLs never consume one
// of the five seed slots.
test('R6 review: rejected sitemap candidates do not consume the seed cap', async () => {
  const { selectSameSiteSitemapSeedCandidates } = await import('./acquisitionLadder');
  const eligible = [1, 2, 3, 4, 5].map((n) => ({ loc: `https://creator.example.com/community-${n}` }));
  const seeds = selectSameSiteSitemapSeedCandidates(
    'https://creator.example.com/',
    [{ loc: 'https://creator.example.com/community-help.js' }, ...eligible],
    'https://creator.example.com/sitemap.xml',
    5,
  );
  assert.equal(seeds.length, 5);
  assert.ok(!seeds.some((seed) => seed.url.includes('community-help.js')), 'rejected inventory URL must not take a slot');
  for (const entry of eligible) {
    assert.ok(seeds.some((seed) => seed.url === entry.loc), `eligible seed lost its slot: ${entry.loc}`);
  }
});

// REVIEW FIX: rejected structured-navigation candidates never consume cap
// slots — admission runs inside the selector before scoring.
test('R6 review: rejected structured-navigation URLs never consume cap slots', async () => {
  const { selectStructuredNavigationCandidates } = await import('./acquisitionLadder');
  const eligiblePaths = Array.from({ length: 10 }, (_, i) => `/community-${i + 1}`);
  const out = selectStructuredNavigationCandidates(
    { canonicalHrefs: ['/discord-community-help.js', ...eligiblePaths], jsonLdSameAs: [] },
    'https://creator.example.com/guide',
    10,
  );
  assert.equal(out.length, 10);
  assert.ok(!out.some((c) => c.url.includes('community-help.js')), 'rejected candidate must not take a slot');
  for (const p of eligiblePaths) {
    assert.ok(
      out.some((c) => c.url === `https://creator.example.com${p}`),
      `eligible candidate pushed out by rejected entry: ${p}`,
    );
  }
});

// REVIEW FIX 6: scheme-less host:port keeps existing normalization behavior;
// explicit non-HTTP schemes stay rejected; admission and normalization agree.
test('R6 review: scheme-less host:port admitted, non-HTTP schemes rejected', () => {
  assert.deepEqual(assessCrawlAdmission('example.com:8080/path'), { eligible: true, reasonCode: 'ELIGIBLE' });
  const normalized = normalizeExternalUrl('example.com:8080/path');
  assert.ok(normalized, 'normalize must admit scheme-less host:port');
  assert.equal(new URL(normalized!.url).hostname, 'example.com');
  assert.equal(new URL(normalized!.url).port, '8080');
  assert.equal(assessCrawlAdmission('ftp://example.com/file').eligible, false);
  assert.equal(assessCrawlAdmission('ftp://example.com/file').reasonCode, 'INVALID_SCHEME');
  assert.equal(normalizeExternalUrl('ftp://example.com/file'), null);
  // Agreement battery (youtube/discord wrappers excluded: normalization owns
  // those classifications on top of admission).
  const bothAdmit = ['https://g.co/', 'https://creator.example.com/guide', 'example.com:8080/path', 'http://[2606:4700:4700::1111]/'];
  for (const raw of bothAdmit) {
    assert.ok(assessCrawlAdmission(raw).eligible && normalizeExternalUrl(raw), `both must admit: ${raw}`);
  }
  const bothReject = ['https://g/', 'https://i.ytimg.com/x.jpg', 'ftp://example.com/f', 'https://', 'https://.com/', 'http://[::1]/'];
  for (const raw of bothReject) {
    assert.ok(!assessCrawlAdmission(raw).eligible && !normalizeExternalUrl(raw), `both must reject: ${raw}`);
  }
});

// Bookmap and legitimate trading discovery safety: the gate must not become
// more aggressive toward genuine trading/community targets.
test('R6 review: Bookmap and legitimate trading domains remain eligible', () => {
  for (const raw of [
    'https://bookmap.com/members/aff/go/spyda96?i=19',
    'https://bookmap.com/',
    'https://www.tradingview.com/',
    'https://myfundedfutures.com/',
    'https://apextraderfunding.com/member/aff/go/chartfanatics',
  ]) {
    assert.deepEqual(assessCrawlAdmission(raw), { eligible: true, reasonCode: 'ELIGIBLE' }, raw);
    assert.ok(normalizeExternalUrl(raw), `normalize must admit: ${raw}`);
  }
});
