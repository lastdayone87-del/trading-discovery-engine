import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { crawlExternalLinks, crawlMessagingPreview, normalizeExternalUrl, runChannelInspection } from './inspector';
import {
  hasMessagingBridgeEvidence,
  isDotlessHostnameUrl,
  isKnownBrokerOrExchangeHost,
  isMessagingPreviewUrl,
  isStaticOnlyAuxiliaryCandidate,
  rankCommunitySurfaces,
} from './communitySurfacePolicy';
import { retryReasonForFailureClass, retryReasonFromError, surfaceAwareRetryReason } from './communityRetryPolicy';
import { isActiveCommunityRetry, rowToChannel } from './dbCore';
import type { BrowserFallbackResult } from './browserCommunityFallback';

const response = (status: number, body = '{}', contentType = 'application/json') =>
  new Response(body, { status, headers: { 'content-type': contentType } });
const html = (body: string) => response(200, `<html><body>${body}</body></html>`, 'text/html');
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

// A. Per-URL failure isolation + continuation (PR #434 items 1-2).

test('one failed URL does not prevent subsequent URLs from being attempted', async () => {
  const result = await crawlExternalLinks(
    ['https://ok-a.test', 'https://failed.test', 'https://ok-b.test'],
    [],
    undefined,
    async (input) =>
      String(input).includes('failed') ? response(500, '', 'text/html') : html('No Discord invite here'),
  );
  assert.equal(result.outcome, 'PARTIALLY_INSPECTED');
  assert.deepEqual(
    new Set(result.observations.map((item) => item.requestedUrl)),
    new Set(['https://ok-a.test', 'https://failed.test', 'https://ok-b.test']),
  );
});

test('a synchronously throwing fetch for one URL is isolated and the rest continue', async () => {
  const result = await crawlExternalLinks(
    ['https://ok.test', 'https://exploding.test', 'https://ok2.test'],
    [],
    undefined,
    async (input) => {
      if (String(input).includes('exploding')) throw new Error('socket hang up');
      return html('No Discord invite here');
    },
  );
  assert.deepEqual(
    new Set(result.observations.map((item) => item.requestedUrl)),
    new Set(['https://ok.test', 'https://exploding.test', 'https://ok2.test']),
  );
  assert.ok(result.observations.some((item) => item.outcome === 'INSPECTED_NO_MATCH'));
  assert.ok(result.observations.some((item) => item.outcome === 'ACQUISITION_FAILED'));
});

test('the complete ranked candidate list is attempted with no URL cap', async () => {
  const links = [
    'https://a1.example.com',
    'https://a2.example.com',
    'https://a3.example.com',
    'https://a4.example.com',
    'https://a5.example.com',
    'https://a6.example.com',
  ];
  const result = await runChannelInspection({
    channelId: 'no-cap-channel',
    channelName: 'No Cap Channel',
    channelBio: 'Trading notes',
    channelLinks: links,
    videoDescriptions: fillers,
    creatorLikelyTrading: false,
    externalFetchImpl: (async () => html('No Discord invite here')) as typeof fetch,
    renderedFallback: emptyRendered,
  });
  const attempted = new Set(
    (result.acquisitionOutcomes || []).filter((item) => item.surface === 'CREATOR_WEBSITES').map((item) => item.requestedUrl),
  );
  for (const link of links) {
    const normalized = link.endsWith('/') ? link : `${link}/`;
    assert.ok(attempted.has(link) || attempted.has(normalized), `expected ${link} to be attempted`);
  }
  assert.equal(result.steps.find((step) => step.step === 'CUSTOM_DOMAINS')?.status, 'NOT_FOUND');
  assert.equal(result.retryDirective, undefined);
});

test('exhausted static child budget is recorded as partial, never as clean', async () => {
  const rootLinks = Array.from({ length: 12 }, (_, i) => `<a href="/community-${i}">community ${i}</a>`).join('');
  const result = await crawlExternalLinks(
    ['https://budget.test/'],
    [],
    undefined,
    async (input) =>
      String(input) === 'https://budget.test/'
        ? html(rootLinks)
        : html('Subpage without invite'),
  );
  assert.equal(result.outcome, 'PARTIALLY_INSPECTED');
  const final = result.observations.find(
    (item) => item.requestedUrl === 'https://budget.test/' && item.outcome === 'PARTIALLY_INSPECTED',
  );
  assert.ok(final, 'expected a PARTIALLY_INSPECTED observation for the budget-exhausted seed');
  assert.equal(final?.telemetry?.budgetExhausted, true);
});

// B. Ranking reorders without discarding (PR #434 items 1, 6).

test('ranking preserves messaging, dotless, broker, and affiliate candidates', () => {
  const inputs = [
    { url: 'https://t.me/previewchannel', contextMatches: false, source: 'VIDEO_2_DESCRIPTION' },
    { url: 'https://g/', contextMatches: false, source: 'VIDEO_2_DESCRIPTION' },
    { url: 'https://broker.test/referral/creator', contextMatches: false, source: 'VIDEO_2_DESCRIPTION' },
    { url: 'https://www.binance.com/activity/referral-entry/CPA', contextMatches: false, source: 'VIDEO_2_DESCRIPTION' },
    { url: 'https://linktr.ee/creator', contextMatches: false, source: 'CHANNEL_LINKS' },
  ];
  const ranked = rankCommunitySurfaces(inputs);
  assert.equal(ranked.length, inputs.length);
  assert.deepEqual(new Set(ranked.map((item) => item.url)), new Set(inputs.map((item) => item.url)));
  assert.ok(isMessagingPreviewUrl('https://t.me/previewchannel'));
  assert.ok(isDotlessHostnameUrl('https://g/'));
  assert.ok(isStaticOnlyAuxiliaryCandidate({ url: 'https://broker.test/referral/creator' }));
  assert.ok(isStaticOnlyAuxiliaryCandidate({ url: 'https://www.binance.com/activity/referral-entry/CPA' }));
  assert.ok(isStaticOnlyAuxiliaryCandidate({ url: 'https://t.me/previewchannel' }));
  assert.ok(isStaticOnlyAuxiliaryCandidate({ url: 'https://g/' }));
  assert.equal(isStaticOnlyAuxiliaryCandidate({ url: 'https://creator.example.com' }), false);
  assert.equal(isStaticOnlyAuxiliaryCandidate({ url: 'https://linktr.ee/creator' }), false);
  assert.equal(hasMessagingBridgeEvidence('Join our discord server'), true);
  assert.equal(hasMessagingBridgeEvidence('Daily market recap, no community mention'), false);
});

test('unrelated hostnames are never classified as broker or exchange domains', async () => {
  const { scoreCommunitySurface } = await import('./communitySurfacePolicy');
  // Exact/subdomain matching only: notbinance.com must not inherit the
  // binance.com broker penalty, and spoofed registrable domains must not match.
  assert.ok(
    scoreCommunitySurface({ url: 'https://notbinance.com/', contextMatches: false, source: 'CHANNEL_LINKS' }) >
      scoreCommunitySurface({ url: 'https://www.binance.com/', contextMatches: false, source: 'CHANNEL_LINKS' }),
  );
  assert.equal(isStaticOnlyAuxiliaryCandidate({ url: 'https://notbinance.com/' }), false);
  assert.equal(isStaticOnlyAuxiliaryCandidate({ url: 'https://binance.com.evil.com/' }), false);
  assert.ok(isStaticOnlyAuxiliaryCandidate({ url: 'https://www.binance.com/' }));
  assert.ok(isStaticOnlyAuxiliaryCandidate({ url: 'https://mabanque.fortuneo.fr/offers' }));
});

test('broker matcher uses exact hostname and safe subdomain semantics', () => {
  assert.equal(isKnownBrokerOrExchangeHost('binance.com'), true);
  assert.equal(isKnownBrokerOrExchangeHost('www.binance.com'), true);
  assert.equal(isKnownBrokerOrExchangeHost('api.binance.com'), true);
  assert.equal(isKnownBrokerOrExchangeHost('notbinance.com'), false);
  assert.equal(isKnownBrokerOrExchangeHost('binance.com.evil.test'), false);
  assert.equal(isKnownBrokerOrExchangeHost('mabanque.fortuneo.fr'), true);
  assert.equal(isKnownBrokerOrExchangeHost('refer.ig.com'), true);
  assert.equal(isKnownBrokerOrExchangeHost('creator.example.com'), false);
});

test('dotless quarantine applies only to exact single-label hostnames and never broadens', () => {
  // Forensic basis (PR #434 §7A): zero historical FOUND observations for
  // dotless seeds. The predicate stays exact: single-label only.
  assert.equal(isDotlessHostnameUrl('https://g/'), true);
  assert.equal(isDotlessHostnameUrl('https://g.co/'), false);
  assert.equal(isDotlessHostnameUrl('https://example.com/'), false);
  assert.equal(isDotlessHostnameUrl('https://192.168.0.1/'), false);
  assert.equal(isDotlessHostnameUrl('not-a-url'), false);
});

// C. Messaging static-first + dotless quarantine + broker demote-only (PR #434 items 3-6).

test('messaging previews resolve statically with zero default rendered launches', async () => {
  let renderedCalls = 0;
  const result = await runChannelInspection({
    channelId: 'msg-static',
    channelName: 'Messaging Channel',
    channelBio: 'Trading notes',
    channelLinks: ['https://t.me/previewchannel'],
    videoDescriptions: fillers,
    creatorLikelyTrading: true,
    externalFetchImpl: (async (input) =>
      String(input).includes('t.me') ? html('Join https://discord.gg/msg-room') : noInviteHtml()) as typeof fetch,
    renderedFallback: async (seedUrl) => {
      renderedCalls++;
      return emptyRendered(seedUrl);
    },
  });
  assert.equal(result.foundInvite, 'msg-room');
  assert.equal(renderedCalls, 0);
  assert.equal(normalizeExternalUrl('https://t.me/previewchannel')?.kind, 'MESSAGING');
});

test('messaging without bridge evidence never escalates to rendered crawling', async () => {
  let renderedCalls = 0;
  const result = await runChannelInspection({
    channelId: 'msg-clean',
    channelName: 'Quiet Messaging Channel',
    channelBio: 'Trading notes',
    channelLinks: ['https://t.me/quietchannel'],
    videoDescriptions: fillers,
    creatorLikelyTrading: true,
    externalFetchImpl: (async (input) =>
      String(input).includes('t.me') ? html('Daily market recap, no community mention') : noInviteHtml()) as typeof fetch,
    renderedFallback: async (seedUrl) => {
      renderedCalls++;
      return emptyRendered(seedUrl);
    },
  });
  assert.equal(renderedCalls, 0);
  assert.equal(result.foundInvite, null);
  assert.equal(result.retryDirective, undefined);
});

test('messaging bridge evidence escalates to the bounded rendered fallback', async () => {
  let renderedCalls = 0;
  const result = await runChannelInspection({
    channelId: 'msg-bridge',
    channelName: 'Bridged Messaging Channel',
    channelBio: 'Trading notes',
    channelLinks: ['https://t.me/bridgedchannel'],
    videoDescriptions: fillers,
    creatorLikelyTrading: true,
    externalFetchImpl: (async (input) =>
      String(input).includes('t.me') ? html('Join our discord server! Invite widget loading...') : noInviteHtml()) as typeof fetch,
    renderedFallback: async (seedUrl) => {
      renderedCalls++;
      return {
        foundInvite: 'bridge-room',
        foundLocation: seedUrl,
        inspectedPages: 1,
        scrolls: 0,
        clicks: 0,
        complete: true,
        retryable: false,
        detail: 'Discord invite discovered from rendered messaging preview',
      };
    },
  });
  assert.equal(renderedCalls, 1);
  assert.equal(result.foundInvite, 'bridge-room');
});

test('messaging bridge evidence escalates even when the creator is not classified as trading', async () => {
  // Creator classification must never silently suppress a legitimate
  // messaging discovery path: bridge evidence alone justifies escalation.
  let renderedCalls = 0;
  const result = await runChannelInspection({
    channelId: 'msg-bridge-unclassified',
    channelName: 'Unclassified Messaging Channel',
    channelBio: 'Market notes',
    channelLinks: ['https://t.me/bridgedchannel'],
    videoDescriptions: fillers,
    creatorLikelyTrading: false,
    externalFetchImpl: (async (input) =>
      String(input).includes('t.me') ? html('Join our discord server! Invite widget loading...') : noInviteHtml()) as typeof fetch,
    renderedFallback: async (seedUrl) => {
      renderedCalls++;
      return {
        foundInvite: 'bridge-room',
        foundLocation: seedUrl,
        inspectedPages: 1,
        scrolls: 0,
        clicks: 0,
        complete: true,
        retryable: false,
        detail: 'Discord invite discovered from rendered messaging preview',
      };
    },
  });
  assert.equal(renderedCalls, 1);
  assert.equal(result.foundInvite, 'bridge-room');
});

test('exhausted crawl budget produces PARTIALLY_INSPECTED at channel level', async () => {
  const rootLinks = Array.from({ length: 12 }, (_, i) => `<a href="/community-${i}">community ${i}</a>`).join('');
  const result = await runChannelInspection({
    channelId: 'UCbudget00000000000000001',
    channelName: 'Budget Channel',
    channelBio: 'Trading notes',
    channelLinks: ['https://budget.test/'],
    videoDescriptions: fillers,
    creatorLikelyTrading: false,
    externalFetchImpl: (async (input) =>
      String(input) === 'https://budget.test/' ? html(rootLinks) : html('Subpage without invite')) as typeof fetch,
    renderedFallback: emptyRendered,
  });
  assert.equal(result.acquisitionStatus, 'PARTIALLY_INSPECTED');
  assert.equal(result.retryDirective, undefined);
  assert.equal(result.steps.find((step) => step.step === 'CUSTOM_DOMAINS')?.status, 'PARTIAL');
});

test('dotless hosts are quarantined to static-only handling without rendered waste', async () => {
  let renderedCalls = 0;
  const result = await runChannelInspection({
    channelId: 'dotless-channel',
    channelName: 'Dotless Channel',
    channelBio: 'Trading notes',
    channelLinks: ['https://g/'],
    videoDescriptions: fillers,
    creatorLikelyTrading: true,
    externalFetchImpl: (async (input) => {
      if (String(input).includes('https://g/')) throw new Error('getaddrinfo ENOTFOUND g');
      return noInviteHtml();
    }) as typeof fetch,
    renderedFallback: async (seedUrl) => {
      renderedCalls++;
      return emptyRendered(seedUrl);
    },
  });
  assert.equal(renderedCalls, 0);
  assert.ok(
    (result.acquisitionOutcomes || []).some(
      (item) => item.requestedUrl === 'https://g/' && item.outcome === 'ACQUISITION_FAILED' && item.required === false,
    ),
  );
  assert.equal(result.retryDirective, undefined);
});

test('broker and affiliate-pattern URLs are attempted statically, never hard-excluded', async () => {
  let renderedCalls = 0;
  const result = await runChannelInspection({
    channelId: 'broker-channel',
    channelName: 'Broker Channel',
    channelBio: 'Trading notes',
    channelLinks: ['https://broker.test/referral/creator'],
    videoDescriptions: fillers,
    creatorLikelyTrading: true,
    externalFetchImpl: (async () => html('<a href="https://discord.gg/partner-room">Partner Discord</a>')) as typeof fetch,
    renderedFallback: async (seedUrl) => {
      renderedCalls++;
      return emptyRendered(seedUrl);
    },
  });
  assert.equal(result.foundInvite, 'partner-room');
  assert.equal(renderedCalls, 1);
});

test('a legitimate website with no static Discord evidence remains eligible for deeper acquisition', async () => {
  // Static-first is triage, not a gate: no static evidence must not prevent
  // rendered crawling when the existing policy would otherwise crawl the site.
  let renderedCalls = 0;
  const result = await runChannelInspection({
    channelId: 'eligible-website',
    channelName: 'Eligible Website Channel',
    channelBio: 'Trading notes',
    channelLinks: ['https://broker.test/referral/guide'],
    videoDescriptions: fillers,
    creatorLikelyTrading: true,
    externalFetchImpl: noInviteHtml as typeof fetch,
    renderedFallback: async (seedUrl) => {
      renderedCalls++;
      return emptyRendered(seedUrl);
    },
  });
  assert.equal(renderedCalls, 1);
  assert.ok(
    (result.acquisitionOutcomes || []).some(
      (item) => item.requestedUrl === 'https://broker.test/referral/guide' && item.outcome === 'INSPECTED_NO_MATCH',
    ),
  );
});

test('a plain legitimate discovered website is crawled even with zero static evidence', async () => {
  // Central invariant: if the engine discovers a legitimate website, crawl it.
  // Static inspection may order/triage acquisition but must never become
  // permission to skip the site: a clean static pass stays eligible for the
  // normal rendered path whenever the existing policy calls for it.
  let renderedCalls = 0;
  const seenStatic: string[] = [];
  const result = await runChannelInspection({
    channelId: 'plain-legit-site',
    channelName: 'Plain Legit Site Channel',
    channelBio: 'Trading notes',
    channelLinks: ['https://creator.example.com/guide'],
    videoDescriptions: fillers,
    creatorLikelyTrading: true,
    externalFetchImpl: (async (input) => {
      seenStatic.push(String(input));
      return noInviteHtml();
    }) as typeof fetch,
    renderedFallback: async (seedUrl) => {
      renderedCalls++;
      return emptyRendered(seedUrl);
    },
  });
  assert.ok(seenStatic.some((url) => url.includes('creator.example.com/guide')));
  assert.equal(renderedCalls, 1);
  assert.ok(
    (result.acquisitionOutcomes || []).some(
      (item) =>
        item.requestedUrl === 'https://creator.example.com/guide' &&
        item.outcome === 'INSPECTED_NO_MATCH' &&
        item.required === false,
    ),
    'expected the static observation to be recorded without blocking escalation',
  );
});

test('messaging preview helper extracts statically and reports bridge evidence', async () => {
  const found = await crawlMessagingPreview(
    'https://t.me/with-invite',
    [],
    undefined,
    (async () => html('Join https://discord.gg/preview-room')) as typeof fetch,
  );
  assert.equal(found.outcome, 'FOUND');
  assert.equal(found.foundInvite, 'preview-room');
  assert.equal(found.bridgeEvidence, false);

  const bridged = await crawlMessagingPreview(
    'https://t.me/bridged',
    [],
    undefined,
    (async () => html('Join our discord server, widget loading')) as typeof fetch,
  );
  assert.equal(bridged.outcome, 'INSPECTED_NO_MATCH');
  assert.equal(bridged.bridgeEvidence, true);
});

// D. Surface-aware retry classification (PR #434 item 7).

test('retry reasons follow the acquisition surface, not a universal upstream default', () => {
  assert.equal(surfaceAwareRetryReason('YOUTUBE_ABOUT', 'TIMEOUT'), 'UPSTREAM_REQUIRED_ACQUISITION_FAILURE');
  assert.equal(surfaceAwareRetryReason('RECENT_VIDEO_DESCRIPTIONS', 'NETWORK_FAILURE'), 'UPSTREAM_REQUIRED_ACQUISITION_FAILURE');
  assert.equal(surfaceAwareRetryReason('CREATOR_WEBSITES', 'NETWORK_FAILURE'), 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE');
  assert.equal(surfaceAwareRetryReason('SOCIAL_PROFILES', 'TRANSIENT_HTTP'), 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE');
  assert.equal(surfaceAwareRetryReason('CHANNEL_EXTERNAL_LINKS', 'TIMEOUT'), 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE');
  assert.equal(surfaceAwareRetryReason('DISCORD_VALIDATION', 'RATE_LIMIT'), 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE');
  assert.equal(surfaceAwareRetryReason('CREATOR_WEBSITES', 'BROWSER_LAUNCH_FAILED'), 'BROWSER_RUNTIME_UNAVAILABLE');
  assert.equal(surfaceAwareRetryReason(undefined, 'BROWSER_RUNTIME_UNAVAILABLE'), 'BROWSER_RUNTIME_UNAVAILABLE');
});

test('failure-class fallback preserves community ownership when the surface is unknown', () => {
  assert.equal(retryReasonForFailureClass('TIMEOUT'), 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE');
  assert.equal(retryReasonForFailureClass('BROWSER_LAUNCH_FAILED'), 'BROWSER_RUNTIME_UNAVAILABLE');
  assert.equal(retryReasonForFailureClass('TIMEOUT', 'YOUTUBE_ABOUT'), 'UPSTREAM_REQUIRED_ACQUISITION_FAILURE');
  assert.equal(retryReasonForFailureClass('NETWORK_FAILURE', 'CREATOR_WEBSITES'), 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE');
  assert.equal(
    retryReasonFromError({ code: 'ECONNRESET', retryable: true }),
    'COMMUNITY_REQUIRED_ACQUISITION_FAILURE',
  );
});

test('queue retry overrides attribute community surfaces as community-owned', () => {
  const queue = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
  assert.match(queue, /retryReason:directive\?\.retryReason\|\|'COMMUNITY_REQUIRED_ACQUISITION_FAILURE'/);
  assert.match(queue, /reason:`Discord validation remained \$\{selected\.operationalOutcome\}`,retryAt:undefined,retryReason:'COMMUNITY_REQUIRED_ACQUISITION_FAILURE'/);
  assert.match(queue, /retryReason === 'BROWSER_RUNTIME_UNAVAILABLE' \? 'BROWSER_RUNTIME_UNAVAILABLE' : 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE'/);
  assert.doesNotMatch(queue, /retryReason:directive\?\.retryReason\|\|'UPSTREAM_REQUIRED_ACQUISITION_FAILURE'/);
});

// E. Stale retry projection: history preserved, active state separate (PR #434 item 8, review fixes 5-6).

test('historical completed retry metadata remains available while active retry state is false', () => {
  const stale = rowToChannel({
    channel_id: 'UCstale00000000000000001',
    scan_status: 'COMPLETED',
    discord_validation_status: 'COMPLETED',
    community_retry_job_status: 'COMPLETED',
    community_retry_job_attempts: 1,
    community_retry_job_max_attempts: 5,
    community_retry_job_retry_reason: 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE',
  });
  // History is preserved (never erased), but nothing active is projected.
  assert.equal(stale.community_retry_job_status, 'COMPLETED');
  assert.equal(stale.community_retry_job_attempts, 1);
  assert.equal(stale.community_retry_job_retry_reason, 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE');
  assert.equal(isActiveCommunityRetry(stale), false);

  const failedHistory = rowToChannel({
    channel_id: 'UCstale00000000000000002',
    scan_status: 'FAILED',
    discord_validation_status: 'RETRY_PENDING',
    community_retry_job_status: 'FAILED',
    community_retry_job_attempts: 5,
    community_retry_job_max_attempts: 5,
  });
  assert.equal(failedHistory.community_retry_job_status, 'FAILED');
  assert.equal(isActiveCommunityRetry(failedHistory), false);
});

test('genuinely active retries remain visible, including recovery-state retries', () => {
  const active = rowToChannel({
    channel_id: 'UCactive0000000000000001',
    scan_status: 'FAILED',
    discord_validation_status: 'RETRY_PENDING',
    community_retry_job_status: 'PENDING',
    community_retry_job_attempts: 2,
    community_retry_job_max_attempts: 5,
    community_retry_job_retry_reason: 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE',
  });
  assert.equal(active.community_retry_job_status, 'PENDING');
  assert.equal(active.community_retry_job_attempts, 2);
  assert.equal(active.community_retry_job_retry_reason, 'COMMUNITY_REQUIRED_ACQUISITION_FAILURE');
  assert.equal(isActiveCommunityRetry(active), true);

  // Governed recovery reactivates channels to ENRICHMENT_PENDING + RETRY_PENDING
  // with a fresh PENDING job: hiding it would suppress a genuinely active
  // recovery retry, so it must project as active.
  const recovering = rowToChannel({
    channel_id: 'UCrecovering00000000000001',
    scan_status: 'ENRICHMENT_PENDING',
    discord_validation_status: 'RETRY_PENDING',
    community_retry_job_status: 'PENDING',
    community_retry_job_attempts: 0,
    community_retry_job_max_attempts: 5,
  });
  assert.equal(isActiveCommunityRetry(recovering), true);
  assert.equal(
    isActiveCommunityRetry({
      scan_status: 'COMPLETED',
      discord_validation_status: 'RETRY_PENDING',
      community_retry_job_status: 'PENDING',
    }),
    false,
  );
});

// F. Dashboard acquisition-state truth (PR #434 item 9).

test('dashboard copy distinguishes incomplete, not-yet-inspected, and clean states', () => {
  const table = readFileSync(new URL('../src/components/ResultsTable.tsx', import.meta.url), 'utf8');
  assert.match(table, /Website acquisition incomplete/);
  assert.match(table, /Not yet inspected/);
  assert.match(table, /Clean inspection · no community found/);
  assert.match(table, /\(c\.scan_status==='FAILED'\|\|c\.scan_status==='FAILED_PERMANENT'\|\|c\.scan_status==='ENRICHMENT_PENDING'\)/);
  assert.match(table, /\(automaticRetryActive\|\|automaticRetryTerminal\)/);
});

// G. Video-description discovery remains enabled (recall invariant).

test('video-description URLs remain eligible for discovery and crawling', async () => {
  const result = await runChannelInspection({
    channelId: 'UCvideodesc00000000000001',
    channelName: 'Video Desc Channel',
    channelBio: 'Trading notes',
    channelLinks: [],
    videoDescriptions: ['First look https://linktr.ee/vid-hub', 'two', 'three', 'four', 'five'],
    creatorLikelyTrading: false,
    externalFetchImpl: (async (input) =>
      String(input).includes('linktr.ee') ? html('<a href="https://discord.gg/vid-room">Join</a>') : noInviteHtml()) as typeof fetch,
    renderedFallback: emptyRendered,
  });
  assert.equal(result.foundInvite, 'vid-room');
  assert.equal(result.acquisitionStatus, 'FOUND');
});
