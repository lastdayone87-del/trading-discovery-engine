/**
 * P4 paid-community intent regressions (report sections 5.2-5.4).
 *
 * Confirmed defect: a channel whose creator links a Whop/Skool/Circle/Patreon
 * community surface (often paid or members-only) but whose invite cannot be
 * statically verified was projected as "no community found" — indistinguishable
 * from a creator with no community at all. Intent must be a real state change:
 * COMMUNITY_INDICATED_NO_INVITE / PAID_COMMUNITY_INDICATED, with evidence.
 *
 * Evidence is extraction-only: it never becomes an invite, never claims a
 * registry code, and never validates.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  communityPlatformForHost,
  detectPaidSignals,
  detectPrivateSignals,
  extractCommunityIntentEvidence,
  mergeCommunityIntentEvidence,
  resolveCommunityDiscoveryStatus,
} from './communityIntent';
import { crawlExternalLinks } from './inspector';

const readSource = (name: string) => readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8');

const html = (body: string, url?: string) => {
  const response = new Response(`<html><body>${body}</body></html>`, { status: 200, headers: { 'content-type': 'text/html' } });
  if (url) Object.defineProperty(response, 'url', { value: url });
  return response;
};

test('platform hosts map by exact host or tenant subdomain; lookalikes never match', () => {
  assert.equal(communityPlatformForHost('whop.com'), 'WHOP');
  assert.equal(communityPlatformForHost('www.skool.com'), 'SKOOL');
  assert.equal(communityPlatformForHost('app.circle.so'), 'CIRCLE');
  assert.equal(communityPlatformForHost('www.patreon.com'), 'PATREON');
  for (const host of ['notwhop.com', 'example.com', 'whop.com.evil.example', 'skool.community']) {
    assert.equal(communityPlatformForHost(host), null, host);
  }
});

test('signal detection is bounded and evidence-named', () => {
  assert.deepEqual(detectPaidSignals('VIP membership $49/mo'), ['price', 'per-month', 'membership']);
  assert.deepEqual(detectPaidSignals('just a normal page'), []);
  assert.deepEqual(detectPrivateSignals('Members only content'), ['members-only']);
  assert.deepEqual(detectPrivateSignals('Sign in to continue'), ['login-required']);
  assert.deepEqual(detectPrivateSignals('a normal page'), []);
});

test('a Whop page with price/membership evidence resolves PAID_COMMUNITY_INDICATED', () => {
  const evidence = extractCommunityIntentEvidence({
    pageUrl: 'https://www.whop.com/vip-trading',
    html: '<h1>VIP Trading Membership</h1><p>Members only — $49/mo</p>',
  });
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].communityPlatform, 'WHOP');
  assert.equal(evidence[0].intent, 'PAID');
  assert.equal(evidence[0].extractionConfidence, 'EXPLICIT');
  assert.ok(evidence[0].paidSignals.includes('price'));
  assert.equal(resolveCommunityDiscoveryStatus(evidence), 'PAID_COMMUNITY_INDICATED');
});

test('a linked platform surface without paid proof still resolves COMMUNITY_INDICATED_NO_INVITE', () => {
  const evidence = extractCommunityIntentEvidence({
    pageUrl: 'https://creator.test/',
    html: '<a href="https://www.skool.com/trading-room">Join the free community</a>',
  });
  const skool = evidence.find(item => item.communityPlatform === 'SKOOL');
  assert.ok(skool, 'observed platform surface is evidence even without paid proof');
  assert.equal(skool.intent, 'UNKNOWN');
  assert.equal(resolveCommunityDiscoveryStatus(evidence), 'COMMUNITY_INDICATED_NO_INVITE');
});

test('members-only gating on a Circle page classifies PRIVATE, never nothing', () => {
  const evidence = extractCommunityIntentEvidence({
    pageUrl: 'https://app.circle.so/c/inner-circle',
    html: '<p>Members only. Sign in to continue.</p>',
  });
  assert.equal(evidence[0].intent, 'PRIVATE');
  assert.equal(resolveCommunityDiscoveryStatus(evidence), 'COMMUNITY_INDICATED_NO_INVITE');
});

test('structured data isAccessibleForFree:false is a paid marker on Patreon pages', () => {
  const evidence = extractCommunityIntentEvidence({
    pageUrl: 'https://www.patreon.com/creator',
    html: '<script type="application/ld+json">{"@type":"Product","isAccessibleForFree":false}</script>',
  });
  assert.equal(evidence[0].intent, 'PAID');
  assert.ok(evidence[0].paidSignals.includes('structured-data-paid'));
});

test('a confirmed paywall on a platform page is PAID even when the static prefix has no price markers', () => {
  const evidence = extractCommunityIntentEvidence({
    pageUrl: 'https://www.whop.com/locked',
    html: '<h1>Welcome</h1>',
    confirmedPaywall: true,
  });
  assert.equal(evidence[0].intent, 'PAID');
  assert.ok(evidence[0].paidSignals.includes('paywall'));
});

test('generic pages with no platform surface produce no intent at all', () => {
  const evidence = extractCommunityIntentEvidence({
    pageUrl: 'https://creator.test/',
    html: '<a href="https://creator.test/about">About</a><a href="https://twitter.com/creator">Twitter</a>',
  });
  assert.deepEqual(evidence, []);
  assert.equal(resolveCommunityDiscoveryStatus([]), 'NONE');
});

test('page-level and anchor evidence for the same community URL merge to the strongest intent', () => {
  const evidence = extractCommunityIntentEvidence({
    pageUrl: 'https://www.skool.com/room',
    html: '<p>Premium membership</p><a href="https://www.skool.com/room">Back to room</a>',
  });
  assert.equal(evidence.length, 1, 'one record per community URL');
  assert.equal(evidence[0].intent, 'PAID');
});

test('merge keeps the strongest classification, unions signals, and caps newest-first', () => {
  const older = {
    communityPlatform: 'SKOOL' as const,
    communityUrl: 'https://www.skool.com/room',
    intent: 'UNKNOWN' as const,
    paidSignals: [],
    privateSignals: [],
    observedAt: '2026-10-01T00:00:00.000Z',
    sourcePageUrl: 'https://creator.test/',
    extractionConfidence: 'EXPLICIT' as const,
  };
  const newer = {
    ...older,
    intent: 'PAID' as const,
    paidSignals: ['price'],
    observedAt: '2026-10-18T00:00:00.000Z',
    sourcePageUrl: 'https://www.skool.com/room',
  };
  const merged = mergeCommunityIntentEvidence([older], [newer]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].intent, 'PAID');
  assert.deepEqual(merged[0].paidSignals, ['price']);
  assert.equal(merged[0].observedAt, '2026-10-18T00:00:00.000Z');
  // A later weak observation never downgrades the stored classification.
  const downgrade = mergeCommunityIntentEvidence(merged, [{ ...older, observedAt: '2026-10-19T00:00:00.000Z' }]);
  assert.equal(downgrade[0].intent, 'PAID');
  // Cap keeps the newest records.
  const many = Array.from({ length: 15 }, (_, index) => ({
    ...older,
    communityUrl: `https://www.skool.com/room-${index}`,
    observedAt: new Date(Date.parse('2026-10-01T00:00:00.000Z') + index * 86_400_000).toISOString(),
  }));
  const capped = mergeCommunityIntentEvidence(null, many, 10);
  assert.equal(capped.length, 10);
  assert.equal(capped[0].communityUrl, 'https://www.skool.com/room-14');
});

test('crawlExternalLinks surfaces reached platform intent; a no-invite platform page is not "no community"', async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === 'https://creator.test/') {
      return html('<a href="https://www.whop.com/creator">Join our paid community</a>');
    }
    if (url === 'https://www.whop.com/creator') {
      return html('<h1>VIP Trading Membership</h1><p>Members only — $49/mo</p>', url);
    }
    return html('no invite');
  }) as typeof fetch;
  const result = await crawlExternalLinks(['https://creator.test/'], [], undefined, fetchImpl);
  const intents = result.communityIntent || [];
  const whop = intents.find(item => item.communityPlatform === 'WHOP');
  assert.ok(whop, 'the reached Whop surface is recorded as intent');
  assert.equal(whop.intent, 'PAID');
  assert.ok(whop.paidSignals.length > 0, 'paid signals are attached as evidence');
  assert.equal(result.foundInvite, null, 'intent is not an invite');
  assert.equal(resolveCommunityDiscoveryStatus(intents), 'PAID_COMMUNITY_INDICATED');
});

test('projection contract: inspection intent becomes channel state, never "no community"', () => {
  const queue = readSource('queueManager.ts');
  assert.match(queue, /if \(inspection\.communityIntent\?\.length\) \{/);
  assert.match(queue, /channel\.community_intents = mergeCommunityIntentEvidence\(channel\.community_intents, inspection\.communityIntent\);/);
  assert.match(queue, /channel\.community_discovery_status = resolveCommunityDiscoveryStatus\(channel\.community_intents\);/);
  const inspector = readSource('inspector.ts');
  assert.match(inspector, /keepCommunityIntent|retainCommunityIntent/);
});

test('persistence contract: channel community state is stored and read back', () => {
  const db = readSource('dbCore.ts');
  assert.match(db, /community_discovery_status: row\.community_discovery_status === 'COMMUNITY_INDICATED_NO_INVITE' \|\| row\.community_discovery_status === 'PAID_COMMUNITY_INDICATED' \? row\.community_discovery_status : 'NONE'/);
  assert.match(db, /community_intents: parseJson\(row\.community_intents, null\)/);
  assert.match(db, /community_discovery_status=excluded\.community_discovery_status,community_intents=excluded\.community_intents/);
  assert.match(db, /channel\.community_discovery_status\|\|'NONE',JSON\.stringify\(channel\.community_intents\|\|\[\]\)/);
});
