import assert from 'node:assert/strict';
import test from 'node:test';
import { inferDiscordOwnership, makeDiscordCandidate } from './discordCandidates';
import { isKnownCommunityDestinationHost, shouldFollowDestination } from './destinationPolicy';
import { admitInspectionDiscordCandidates } from './queueManager';

function websiteCandidate(code: string, sourceUrl: string) {
  return makeDiscordCandidate({
    locatorType: 'NATIVE_INVITE',
    sourceSurface: 'CREATOR_WEBSITES',
    rawLocator: `https://discord.gg/${code}`,
    normalizedLocator: `https://discord.gg/${code}`,
    nativeInviteCode: code,
    sourceUrl,
    extractionConfidence: 'EXPLICIT',
  });
}

test('docs/wiki/reference pages do not inherit creator ownership from a linked domain', () => {
  const cases = [
    { url: 'https://docs.n8n.io/integrations/', hosts: ['n8n.io'], name: 'iOSCoding' },
    { url: 'https://bs.wikipedia.org/wiki/Wikipedia:Discord', hosts: [], name: 'Clément - Investing' },
    { url: 'https://ru.tradingview.com/symbols/SSVUSD/', hosts: [], name: 'Zone Hunters' },
    { url: 'https://chromewebstore.google.com/detail/x', hosts: [], name: 'Quant Trading Pro' },
    { url: 'https://rentry.co/what', hosts: [], name: 'James Crypto Finder' },
    { url: 'https://tradeify.co/post/best-trading-discord-servers', hosts: [], name: 'BionicNQ' },
    { url: 'https://docs.upgrade.chat/acceptable-use-policy', hosts: ['upgrade.chat'], name: 'Trading In The Money Inc' },
  ];
  for (const item of cases) {
    const candidate = websiteCandidate('BADROOM', item.url);
    const ownership = inferDiscordOwnership(candidate, {
      creatorName: item.name,
      creatorWebsiteHosts: item.hosts,
    });
    assert.notEqual(ownership.ownershipStatus, 'CREATOR_OWNED', item.url);
  }
});

test('brand-matched creator websites and known hubs remain eligible', () => {
  const owned = websiteCandidate('GOODROOM', 'https://dailymarketschool.com/demo-lessons');
  const ownership = inferDiscordOwnership(owned, {
    creatorName: 'Daily Market School',
    creatorWebsiteHosts: ['dailymarketschool.com'],
  });
  assert.equal(ownership.ownershipStatus, 'CREATOR_OWNED');
  assert.equal(isKnownCommunityDestinationHost('www.skool.com'), true);
  assert.equal(isKnownCommunityDestinationHost('stan.store'), true);
});

test('static candidates without ownership evidence cannot claim the registry', async () => {
  const falseCandidate = websiteCandidate('N8NDOCS', 'https://docs.n8n.io/integrations/');
  const falseOwned = { ...falseCandidate, ...inferDiscordOwnership(falseCandidate, { creatorName: 'iOSCoding', creatorWebsiteHosts: ['n8n.io'] }) };
  const legitCandidate = websiteCandidate('DMSCLASS', 'https://dailymarketschool.com/demo-lessons');
  const legitOwned = { ...legitCandidate, ...inferDiscordOwnership(legitCandidate, { creatorName: 'Daily Market School', creatorWebsiteHosts: ['dailymarketschool.com'] }) };
  const claimed: string[] = [];
  const persisted: string[] = [];
  const deps = {
    persist: async (_channelId: string, items: Array<{ candidateId: string }>) => { persisted.push(...items.map(item => item.candidateId)); },
    claim: async (items: Array<{ code: string }>) => {
      claimed.push(...items.map(item => item.code));
      return items.map(item => ({ code: item.code, admitted: true, firstChannelId: 'chanX' }));
    },
    removeLosers: async () => 0,
    executionNow: async () => new Date().toISOString(),
  };
  const result = await admitInspectionDiscordCandidates([falseOwned, legitOwned] as never, null, 'chanX', deps as never);
  assert.deepEqual(claimed, ['dmsclass']);
  assert.deepEqual(result.candidates.map(candidate => candidate.nativeInviteCode), ['DMSCLASS']);
  assert.equal(persisted.includes(falseOwned.candidateId), false);
});

test('third-party pages cannot open unrelated external hosts', () => {
  const seed = 'https://creator.example/';
  const fromSeed = shouldFollowDestination({
    url: 'https://unknown.example/community',
    currentUrl: seed,
    seedUrl: seed,
    anchorText: 'Join the community',
  });
  assert.equal(fromSeed.eligible, true);
  const fromDocs = shouldFollowDestination({
    url: 'https://unknown.example/community',
    currentUrl: 'https://docs.n8n.io/integrations/',
    seedUrl: seed,
    anchorText: 'Join the community',
  });
  assert.equal(fromDocs.eligible, false);
  assert.equal(fromDocs.reason, 'external-page-hop');
  const sameExternalOrigin = shouldFollowDestination({
    url: 'https://docs.n8n.io/other',
    currentUrl: 'https://docs.n8n.io/integrations/',
    seedUrl: seed,
  });
  assert.equal(sameExternalOrigin.eligible, true);
  const redirectedSeed = shouldFollowDestination({
    url: 'https://members.creator.example/join',
    currentUrl: 'https://www.creator.example/',
    seedUrl: 'https://www.creator.example/',
    anchorText: 'Join the community',
  });
  assert.equal(redirectedSeed.eligible, true);
  const backToCreator = shouldFollowDestination({
    url: 'https://www.creator.example/community',
    currentUrl: 'https://docs.n8n.io/integrations/',
    seedUrl: 'https://www.creator.example/',
  });
  assert.equal(backToCreator.eligible, true);
  for (const url of ['https://www.skool.com/trader', 'https://discord.gg/room', 'https://stan.store/trader']) {
    const known = shouldFollowDestination({
      url,
      currentUrl: 'https://docs.n8n.io/integrations/',
      seedUrl: seed,
      anchorText: 'Join the community',
    });
    assert.equal(known.eligible, true, url);
  }
});
