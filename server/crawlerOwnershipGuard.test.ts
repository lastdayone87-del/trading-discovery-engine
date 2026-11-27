import assert from 'node:assert/strict';
import test from 'node:test';
import { inferDiscordOwnership, makeDiscordCandidate } from './discordCandidates';
import { isAllowedChildRedirect, isKnownCommunityDestinationHost, shouldFollowDestination } from './destinationPolicy';
import { admitInspectionDiscordCandidates } from './queueManager';
import { isSkippableNavigableAnchorClick, planRenderedCrossOriginEnqueues, shouldEnqueueRenderedCrossOriginLink } from './browserCommunityFallback';

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

test('social-only candidates remain claimable without website evidence', async () => {
  const social = makeDiscordCandidate({
    locatorType: 'NATIVE_INVITE',
    sourceSurface: 'SOCIAL_PROFILES',
    rawLocator: 'https://discord.gg/SOCIALROOM',
    normalizedLocator: 'https://discord.gg/SOCIALROOM',
    nativeInviteCode: 'SOCIALROOM',
    sourceUrl: 'https://instagram.com/some_creator',
    extractionConfidence: 'EXPLICIT',
    observations: [{ sourceSurface: 'SOCIAL_PROFILES', sourceUrl: 'https://instagram.com/some_creator', rawLocator: 'https://discord.gg/SOCIALROOM', extractionConfidence: 'EXPLICIT' }],
  });
  const owned = { ...social, ...inferDiscordOwnership(social, { creatorName: 'Some Creator' }) };
  const claimed: string[] = [];
  await admitInspectionDiscordCandidates([owned] as never, null, 'chanX', {
    persist: async () => {},
    claim: async (items: Array<{ code: string }>) => {
      claimed.push(...items.map(item => item.code));
      return items.map(item => ({ code: item.code, admitted: true, firstChannelId: 'chanX' }));
    },
    removeLosers: async () => 0,
    executionNow: async () => new Date().toISOString(),
  } as never);
  assert.deepEqual(claimed, ['socialroom']);
});

test('reference-only static candidates stay deferred; creator and partner websites proceed', async () => {
  const falseCandidate = websiteCandidate('N8NDOCS', 'https://docs.n8n.io/integrations/');
  const falseOwned = { ...falseCandidate, ...inferDiscordOwnership(falseCandidate, { creatorName: 'iOSCoding', creatorWebsiteHosts: ['n8n.io'] }) };
  const mixedCandidate = websiteCandidate('MIXEDDOCS', 'https://docs.n8n.io/integrations/');
  const mixedObservations = [
    { sourceSurface: 'CREATOR_WEBSITES' as const, sourceUrl: 'https://docs.n8n.io/integrations/', rawLocator: 'https://discord.gg/MIXEDDOCS', extractionConfidence: 'EXPLICIT' as const },
    { sourceSurface: 'YOUTUBE_COMMENTS' as const, sourceUrl: 'https://youtube.com/channel/UC123', rawLocator: 'https://discord.gg/MIXEDDOCS', extractionConfidence: 'EXPLICIT' as const },
  ];
  const mixedBase = { ...mixedCandidate, observations: mixedObservations };
  const mixed = {
    ...mixedBase,
    ...inferDiscordOwnership(mixedBase, { creatorName: 'iOSCoding', creatorWebsiteHosts: ['n8n.io'] }),
  };
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
  const affiliateCandidate = websiteCandidate('AFFILIATE', 'https://myforexfunds.com/contact-us/');
  const affiliate = { ...affiliateCandidate, ...inferDiscordOwnership(affiliateCandidate, { creatorName: 'T For Trading', creatorWebsiteHosts: ['myforexfunds.com'] }) };
  const propFirmCandidate = websiteCandidate('PROPFIRM', 'https://apextraderfunding.com/member/aff/go/test');
  const propFirm = { ...propFirmCandidate, ...inferDiscordOwnership(propFirmCandidate, { creatorName: 'Apex Trader', creatorWebsiteHosts: ['apextraderfunding.com'] }) };
  // A non-reference software community is not blocked at admission: the
  // actual Discord relevance validation decides, and a non-trading result
  // releases the provisional registry claim.
  const softwareCandidate = websiteCandidate('SOFTWARE', 'https://community.n8n.io/');
  const software = { ...softwareCandidate, ...inferDiscordOwnership(softwareCandidate, { creatorName: 'iOSCoding' }) };
  const missingUrl = makeDiscordCandidate({
    locatorType: 'NATIVE_INVITE',
    sourceSurface: 'CREATOR_WEBSITES',
    rawLocator: 'https://discord.gg/MISSINGURL',
    normalizedLocator: 'https://discord.gg/MISSINGURL',
    nativeInviteCode: 'MISSINGURL',
    extractionConfidence: 'EXPLICIT',
    observations: [{ sourceSurface: 'CREATOR_WEBSITES', rawLocator: 'https://discord.gg/MISSINGURL', extractionConfidence: 'EXPLICIT' }],
  });
  const result = await admitInspectionDiscordCandidates([falseOwned, mixed, legitOwned, affiliate, propFirm, software, missingUrl] as never, null, 'chanX', deps as never);
  assert.deepEqual(claimed.sort(), ['affiliate', 'dmsclass', 'propfirm', 'software']);
  assert.deepEqual(result.candidates.map(candidate => candidate.nativeInviteCode).sort(), ['AFFILIATE', 'DMSCLASS', 'PROPFIRM', 'SOFTWARE']);
  assert.equal(persisted.includes(falseOwned.candidateId), false);
  assert.equal(persisted.includes(mixed.candidateId), false);
  assert.equal(persisted.includes(missingUrl.candidateId), false, 'missing website provenance stays deferred');
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
  for (const referenceUrl of [
    'https://docs.n8n.io/integrations/',
    'https://es.wikipedia.org/wiki/Portal:Comunidad',
    'https://play.google.com/store/apps/details?id=com.example',
    'https://chromewebstore.google.com/detail/x',
    'https://github.com/UnionKeyHQ/firmware',
  ]) {
    const reference = shouldFollowDestination({
      url: referenceUrl,
      currentUrl: seed,
      seedUrl: seed,
      anchorText: 'Join the community',
    });
    assert.equal(reference.eligible, false, referenceUrl);
    assert.equal(reference.reason, 'reference-host', referenceUrl);
  }
  const partnerSite = shouldFollowDestination({
    url: 'https://myforexfunds.com/contact-us/',
    currentUrl: seed,
    seedUrl: seed,
    anchorText: 'Join the trading community',
  });
  assert.equal(partnerSite.eligible, true, 'affiliate/prop-firm sites remain crawlable');
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

test('seed scheme/apex redirects stay first-party in static and rendered policy', () => {
  const seed = 'http://www.creator.example';
  const redirected = shouldFollowDestination({
    url: 'https://unknown.example/community',
    currentUrl: 'https://creator.example/',
    seedUrl: seed,
    anchorText: 'Join the community',
  });
  assert.equal(redirected.eligible, true);
  const docsHop = shouldFollowDestination({
    url: 'https://unknown.example/community',
    currentUrl: 'https://docs.n8n.io/integrations/',
    seedUrl: seed,
    anchorText: 'Join the community',
  });
  assert.equal(docsHop.eligible, false);
  assert.equal(docsHop.reason, 'external-page-hop');
  assert.equal(shouldEnqueueRenderedCrossOriginLink({
    url: 'https://unknown.example/community',
    currentUrl: 'https://creator.example/',
    seedUrl: seed,
    anchorText: 'Join the community',
  }), true);
  assert.equal(shouldEnqueueRenderedCrossOriginLink({
    url: 'https://unknown.example/community',
    currentUrl: 'https://docs.n8n.io/integrations/',
    seedUrl: seed,
    anchorText: 'Join the community',
  }), false);
  assert.equal(isSkippableNavigableAnchorClick(
    { href: 'https://unknown.example/community', text: 'Join the community' },
    'https://creator.example/',
    { seedUrl: seed, crossOriginPursued: false },
  ), false);
  assert.equal(isSkippableNavigableAnchorClick(
    { href: 'https://unknown.example/community', text: 'Join the community' },
    'https://docs.n8n.io/integrations/',
    { seedUrl: seed, crossOriginPursued: false },
  ), true);
});

test('creator first-party redirects may hand off to a separate community domain', () => {
  const seed = new URL('http://www.creator.example');
  const redirectedSeed = new URL('https://creator.example');
  assert.equal(isAllowedChildRedirect(seed, redirectedSeed, new URL('https://community.example/join')), true,
    'a creator-authored /join redirect is not an external-page hop');
  const sharedParentHop = shouldFollowDestination({
    url: 'https://substack.com/',
    currentUrl: 'https://docs.n8n.io/integrations/',
    seedUrl: 'https://alice.substack.com/',
    anchorText: 'Join the community',
  });
  assert.equal(sharedParentHop.eligible, false,
    'a multi-tenant shared apex is not the tenant creator site');
  assert.equal(isAllowedChildRedirect(new URL('https://creator.example'), new URL('https://docs.n8n.io/integrations/'), new URL('https://unknown.example/community')), false,
    'once off the creator site, unrelated hosts remain blocked');
  assert.equal(isAllowedChildRedirect(new URL('https://creator.example'), new URL('https://docs.n8n.io/integrations/'), new URL('https://www.skool.com/trader')), true,
    'an evidenced community platform remains reachable from a reference page');
});

test('merged pre-click cross-origin links keep their source document', () => {
  const url = 'https://unknown.example/community';
  const plan = planRenderedCrossOriginEnqueues({
    candidates: [{ url, text: 'Join the community', sourceUrl: 'https://creator.example/' }],
    currentUrl: 'https://docs.n8n.io/integrations/',
    seedUrl: 'https://creator.example/',
    alreadyVisited: new Set(),
    queued: new Set(),
    maxEnqueues: 5,
  });
  assert.deepEqual(plan.admitted, [url], 'a creator-origin pre-click anchor is not reclassified against the post-click docs page');
});

test('creator-owned docs subdomains keep same-site navigation but block third-party docs', () => {
  const docsSeed = new URL('https://docs.creator.example');
  assert.equal(isAllowedChildRedirect(docsSeed, docsSeed, new URL('https://docs.creator.example/start')), true);
  assert.equal(isAllowedChildRedirect(new URL('https://creator.example'), new URL('https://creator.example/'), new URL('https://docs.n8n.io/start')), false);
  const dottedReference = shouldFollowDestination({
    url: 'https://github.com./owner/repo',
    currentUrl: 'https://creator.example/',
    seedUrl: 'https://creator.example/',
    anchorText: 'Join the community',
  });
  assert.equal(dottedReference.eligible, false);
  assert.equal(dottedReference.reason, 'reference-host');
});
