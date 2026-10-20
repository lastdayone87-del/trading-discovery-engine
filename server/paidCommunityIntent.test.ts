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
  applyCommunityIntentEvidence,
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
  for (const host of ['notwhop.com', 'example.com', 'whop.com.evil.example', 'skool.community', 'constructor', '__proto__']) {
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

test('script/style bodies and bare membership wording do not fabricate paid intent', () => {
  assert.deepEqual(detectPaidSignals('membership community'), []);
  assert.deepEqual(detectPaidSignals('We offer a free membership'), []);
  const evidence = extractCommunityIntentEvidence({
    pageUrl: 'https://www.whop.com/free-room',
    html: '<script>window.plan="premium subscription paid";</script><style>.paid{color:red}</style><p>Free community</p>',
  });
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].intent, 'UNKNOWN');
  assert.deepEqual(evidence[0].paidSignals, []);
});

test('anchor parsing ignores data-href and accepts unquoted href values', () => {
  const evidence = extractCommunityIntentEvidence({
    pageUrl: 'https://creator.test/',
    html: '<a data-href="https://www.skool.com/fake">Not a link</a><a href=https://www.skool.com/real>Real community</a>',
  });
  const urls = evidence.map(item => item.communityUrl);
  assert.ok(urls.includes('https://www.skool.com/real'));
  assert.ok(!urls.includes('https://www.skool.com/fake'));
});

test('paid evidence survives the recency cap even when it is older than ten newer surfaces', () => {
  const paid = {
    communityPlatform: 'WHOP' as const,
    communityUrl: 'https://www.whop.com/paid',
    intent: 'PAID' as const,
    paidSignals: ['price'],
    privateSignals: [],
    observedAt: '2026-01-01T00:00:00.000Z',
    sourcePageUrl: 'https://www.whop.com/paid',
    extractionConfidence: 'EXPLICIT' as const,
  };
  const newer = Array.from({ length: 15 }, (_, index) => ({
    ...paid,
    communityUrl: `https://www.skool.com/free-${index}`,
    intent: 'UNKNOWN' as const,
    paidSignals: [],
    observedAt: new Date(Date.parse('2026-10-01T00:00:00.000Z') + index * 86_400_000).toISOString(),
  }));
  const capped = mergeCommunityIntentEvidence([paid], newer, 10);
  assert.equal(capped.length, 10);
  assert.ok(capped.some(item => item.intent === 'PAID'), 'paid evidence cannot be evicted by recency');
  assert.equal(resolveCommunityDiscoveryStatus(capped), 'PAID_COMMUNITY_INDICATED');
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
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url === 'https://creator.test/') {
      return html('<a href="https://www.whop.com/creator">Join our community</a>');
    }
    if (url === 'https://www.whop.com/creator') {
      return html('<h1>VIP Trading Membership</h1><p>Members only — $49/mo</p>', url);
    }
    return html('no invite');
  }) as typeof fetch;
  const result = await crawlExternalLinks(['https://creator.test/'], [], undefined, fetchImpl);
  const intents = result.communityIntent || [];
  const whop = intents.find(item => item.communityPlatform === 'WHOP' && item.intent === 'PAID');
  assert.ok(calls.includes('https://www.whop.com/creator'), 'the platform destination is actually fetched');
  assert.ok(whop, 'the reached Whop surface is recorded as intent');
  assert.equal(whop.intent, 'PAID');
  assert.ok(whop.paidSignals.length > 0, 'paid signals are attached as evidence');
  assert.equal(result.foundInvite, null, 'intent is not an invite');
  assert.equal(resolveCommunityDiscoveryStatus(intents), 'PAID_COMMUNITY_INDICATED');
});

test('projection contract: inspection intent becomes channel state, never "no community"', () => {
  const queue = readSource('queueManager.ts');
  assert.match(queue, /applyCommunityIntentEvidence\(channel, inspection\.communityIntent\);/);
  const inspector = readSource('inspector.ts');
  assert.match(inspector, /keepCommunityIntent|retainCommunityIntent/);
});

test('a retained invite and an additional community intent coexist without overwriting either state', () => {
  const channel: any = {
    discord_status: 'ACTIVE',
    discord_discovery_status: 'VALIDATED',
    discord_invite: 'https://discord.gg/creatora',
    community_discovery_status: 'NONE',
    community_intents: null,
  };
  const paid = extractCommunityIntentEvidence({
    pageUrl: 'https://www.whop.com/vip-trading',
    html: '<h1>VIP Trading Membership</h1><p>Members only — $49/mo</p>',
  });
  assert.equal(paid[0]?.intent, 'PAID');
  assert.equal(applyCommunityIntentEvidence(channel, paid), true);
  assert.equal(channel.discord_status, 'ACTIVE');
  assert.equal(channel.discord_discovery_status, 'VALIDATED');
  assert.equal(channel.discord_invite, 'https://discord.gg/creatora');
  assert.equal(channel.community_discovery_status, 'PAID_COMMUNITY_INDICATED');
  assert.equal(channel.community_intents[0].communityUrl, paid[0].communityUrl);
});

test('persistence contract: channel community state is stored and read back', () => {
  const db = readSource('dbCore.ts');
  assert.match(db, /community_discovery_status: row\.community_discovery_status === 'COMMUNITY_INDICATED_NO_INVITE' \|\| row\.community_discovery_status === 'PAID_COMMUNITY_INDICATED' \? row\.community_discovery_status : 'NONE'/);
  assert.match(db, /community_intents: parseJson\(row\.community_intents, null\)/);
  assert.match(db, /community_discovery_status=excluded\.community_discovery_status,community_intents=excluded\.community_intents/);
  assert.match(db, /channel\.community_discovery_status\|\|'NONE',JSON\.stringify\(channel\.community_intents\|\|\[\]\)/);
});
