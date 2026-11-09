import assert from 'node:assert/strict';
import test from 'node:test';
import { inferDiscordOwnership, makeDiscordCandidate, mergeDiscordCandidates } from './discordCandidates';
import { scoreCommunitySurface } from './communitySurfacePolicy';
import { runChannelInspectionForTest as runChannelInspection } from './testCrawlHelpers';

const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/html' } });

const baseDescriptions = ['one', 'two', 'three', 'four', 'five'];

test('L1 a pinned-comment invite is retained with PINNED_COMMENT provenance', async () => {
  const result = await runChannelInspection({
    channelId: 'l1-direct',
    channelName: 'L1 Direct',
    channelBio: 'No invite',
    channelLinks: [],
    pinnedComment: 'Pinned: join the desk https://discord.gg/pinned-room',
    videoDescriptions: baseDescriptions,
  });

  assert.equal(result.foundInvite, 'pinned-room');
  const step = result.steps.find(item => item.step === 'PINNED_COMMENT');
  assert.equal(step?.status, 'FOUND');
  assert.equal(step?.inviteLocation, 'PINNED_COMMENT');
  assert.equal(step?.detectedInvite, 'pinned-room');

  const candidate = result.discordCandidates?.find(item => item.nativeInviteCode === 'pinned-room');
  assert.equal(candidate?.sourceSurface, 'PINNED_COMMENT');
  assert.ok(candidate?.observations?.some(observation =>
    observation.sourceSurface === 'PINNED_COMMENT'
    && observation.sourceUrl === 'youtube:channel:l1-direct:pinned-comment'));
  assert.ok(result.acquisitionOutcomes?.some(outcome =>
    outcome.surface === 'PINNED_COMMENT' && outcome.outcome === 'FOUND'));
});

test('L1 pinned and description provenance merge on one invited candidate', async () => {
  const result = await runChannelInspection({
    channelId: 'l1-merged',
    channelName: 'L1 Merged',
    channelBio: 'No invite',
    channelLinks: [],
    pinnedComment: 'Pinned: https://discord.gg/shared-room',
    videoDescriptions: ['Newest upload: https://discord.gg/shared-room', 'two', 'three', 'four', 'five'],
  });

  assert.equal(result.foundInvite, 'shared-room');
  assert.equal(result.discordCandidates?.length, 1);
  const surfaces = new Set(result.discordCandidates?.[0]?.observations?.map(observation => observation.sourceSurface));
  assert.ok(surfaces.has('PINNED_COMMENT'), 'pinned-comment observation must survive the merge');
  assert.ok(surfaces.has('RECENT_VIDEO_DESCRIPTIONS'), 'description observation must survive the merge');
  assert.equal(result.discordCandidates?.[0]?.ownershipStatus, 'CREATOR_OWNED');
});

test('L1 a link found in the pinned comment still flows through the crawler', async () => {
  const fetched: string[] = [];
  const result = await runChannelInspection({
    channelId: 'l1-link',
    channelName: 'L1 Link',
    channelBio: 'No invite',
    channelLinks: [],
    pinnedComment: 'Community: https://linktr.ee/l1creator',
    videoDescriptions: baseDescriptions,
    externalFetchImpl: (async (input: any) => {
      fetched.push(String(input));
      return html('<html><body><a href="https://discord.gg/link-room">Join</a></body></html>');
    }) as typeof fetch,
  });

  assert.equal(result.foundInvite, 'link-room');
  assert.ok(fetched.some(url => url.includes('linktr.ee/l1creator')));
  const candidate = result.discordCandidates?.find(item => item.nativeInviteCode === 'link-room');
  assert.ok(
    candidate?.observations?.some(observation =>
      observation.sourceSurface === 'PINNED_COMMENT'
      && observation.sourceUrl === 'https://linktr.ee/l1creator'),
    'the crawled invite must retain the pinned-comment seed provenance',
  );
  assert.equal(result.steps.find(item => item.step === 'PINNED_COMMENT')?.status, 'NOT_FOUND');
  assert.equal(result.steps.find(item => item.step === 'CUSTOM_DOMAINS')?.status, 'FOUND');
});

test('L1 a pinned Discord server page keeps PINNED_COMMENT on the resolved candidate', async () => {
  const result = await runChannelInspection({
    channelId: 'l1-server-page',
    channelName: 'L1 Server Page',
    channelBio: 'No invite',
    channelLinks: [],
    pinnedComment: 'Pinned server: https://discord.com/servers/trading-322850917248663552',
    videoDescriptions: baseDescriptions,
    externalFetchImpl: (async (input: any) => {
      assert.match(String(input), /discord\.com\/servers\/trading-322850917248663552/);
      return html('<a href="https://discord.gg/pinned-surface">Join</a>');
    }) as typeof fetch,
  });

  assert.equal(result.foundInvite, 'pinned-surface');
  assert.equal(result.discordCandidates?.[0]?.sourceSurface, 'PINNED_COMMENT');
  assert.ok(result.acquisitionOutcomes?.some(outcome =>
    outcome.surface === 'PINNED_COMMENT' && outcome.outcome === 'FOUND'),
  'the acquisition ledger must keep pinned-comment provenance');
  assert.equal(result.steps.find(item => item.step === 'PINNED_COMMENT')?.status, 'NOT_FOUND');
  assert.equal(result.steps.find(item => item.step === 'DISCORD_SURFACES')?.status, 'FOUND');
});

test('L1 pinned-comment URLs outrank video-description URLs for crawl order', () => {
  const pinned = scoreCommunitySurface({ url: 'https://linktr.ee/creator', source: 'PINNED_COMMENT', contextMatches: false } as never);
  const description = scoreCommunitySurface({ url: 'https://linktr.ee/creator', source: 'VIDEO_1_DESCRIPTION', contextMatches: false } as never);
  assert.ok(pinned > description, `pinned ${pinned} must outrank description ${description}`);
});

test('L1 pinned-comment ownership is provenance-distinct and corroborates across surfaces', () => {
  const pinned = makeDiscordCandidate({
    locatorType: 'NATIVE_INVITE',
    sourceSurface: 'PINNED_COMMENT',
    rawLocator: 'https://discord.gg/provenance-room',
    nativeInviteCode: 'provenance-room',
    normalizedLocator: 'https://discord.gg/provenance-room',
    sourceUrl: 'youtube:channel:l1:pinned-comment',
    extractionConfidence: 'EXPLICIT',
  });
  const alone = inferDiscordOwnership(pinned, {});
  assert.equal(alone.ownershipStatus, 'UNCERTAIN', 'a pinned comment alone is creator-curated but not ownership-proof');
  assert.ok(alone.ownershipReasons?.includes('DIRECT_PINNED_COMMENT'));

  const channelLink = makeDiscordCandidate({
    locatorType: 'NATIVE_INVITE',
    sourceSurface: 'CHANNEL_EXTERNAL_LINKS',
    rawLocator: 'https://discord.gg/provenance-room',
    nativeInviteCode: 'provenance-room',
    normalizedLocator: 'https://discord.gg/provenance-room',
    sourceUrl: 'https://example.test/links',
    extractionConfidence: 'EXPLICIT',
  });
  const merged = mergeDiscordCandidates([pinned, channelLink], {});
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.ownershipStatus, 'CREATOR_OWNED');
  assert.ok(merged[0]?.ownershipReasons?.includes('CROSS_CREATOR_SURFACE_CORROBORATION'));

  // A generic social profile or linked website must not be treated as
  // identity corroboration merely because it carries the same invite.
  for (const sourceSurface of ['SOCIAL_PROFILES', 'CREATOR_WEBSITES'] as const) {
    const generic = makeDiscordCandidate({
      locatorType: 'NATIVE_INVITE',
      sourceSurface,
      rawLocator: 'https://discord.gg/provenance-room',
      nativeInviteCode: 'provenance-room',
      normalizedLocator: 'https://discord.gg/provenance-room',
      sourceUrl: sourceSurface === 'SOCIAL_PROFILES' ? 'https://instagram.com/random' : 'https://example.test/links',
      extractionConfidence: 'EXPLICIT',
    });
    const genericMerged = mergeDiscordCandidates([pinned, generic], {});
    assert.equal(genericMerged[0]?.ownershipStatus, 'UNCERTAIN', sourceSurface);
    assert.ok(!genericMerged[0]?.ownershipReasons?.includes('CROSS_CREATOR_SURFACE_CORROBORATION'), sourceSurface);
  }
});

test('L1 empty and invite-free pinned comments stay explicit', async () => {
  const empty = await runChannelInspection({
    channelId: 'l1-empty',
    channelName: 'L1 Empty',
    channelBio: 'No invite',
    channelLinks: [],
    pinnedComment: '   ',
    videoDescriptions: baseDescriptions,
  });
  assert.equal(empty.steps.find(item => item.step === 'PINNED_COMMENT')?.status, 'SKIPPED');

  const none = await runChannelInspection({
    channelId: 'l1-none',
    channelName: 'L1 None',
    channelBio: 'No invite',
    channelLinks: [],
    pinnedComment: 'Thanks for watching; no links here.',
    videoDescriptions: baseDescriptions,
  });
  assert.equal(none.foundInvite, null);
  assert.equal(none.steps.find(item => item.step === 'PINNED_COMMENT')?.status, 'NOT_FOUND');
});
