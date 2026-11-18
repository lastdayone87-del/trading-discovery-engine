import test from 'node:test';
import assert from 'node:assert/strict';
import { runChannelInspectionForTest as runChannelInspection } from './testCrawlHelpers';
import type { BrowserFallbackResult } from './browserCommunityFallback';

const LEASE = '11111111-1111-4111-8111-111111111111';

const html = (body: string) =>
  new Response(`<html><body>${body}</body></html>`, { status: 200, headers: { 'content-type': 'text/html' } });
const noInviteHtml = async () => html('No Discord invite here');
const emptyRendered = async (seedUrl: string): Promise<BrowserFallbackResult> => ({
  foundInvite: null,
  foundLocation: seedUrl,
  inspectedPages: 0,
  scrolls: 0,
  clicks: 0,
  complete: true,
  retryable: false,
  detail: 'test rendered surface inspected without invite',
});
const fillers = ['one', 'two', 'three', 'four', 'five'];

test('ledger-seeded direct invite is validated without a channel link', async () => {
  const result = await runChannelInspection({
    channelId: 'acq-ledger-direct-seed',
    channelName: 'Ledger Direct Seed',
    channelBio: 'Trading notes',
    channelLinks: ['https://out-of-scope.example/'],
    videoDescriptions: fillers,
    creatorLikelyTrading: false,
    allowedCommunityUrl: (url) => url === 'https://discord.gg/ledger-direct',
    ledgerSeedUrls: [{
      url: 'https://discord.gg/ledger-direct',
      surface: 'CHANNEL_EXTERNAL_LINKS',
      leaseToken: LEASE,
    }],
    externalFetchImpl: noInviteHtml as typeof fetch,
    renderedFallback: emptyRendered,
  });

  assert.ok(
    result.discordCandidates?.some((candidate) => candidate.nativeInviteCode === 'ledger-direct'),
    'the claimed direct invite must enter the candidate collection',
  );
  const bound = result.acquisitionOutcomes?.find((outcome) =>
    outcome.requestedUrl === 'https://discord.gg/ledger-direct' && outcome.outcome === 'FOUND');
  assert.ok(bound, 'the claimed direct invite must produce a FOUND observation');
  assert.equal(bound.surface, 'CHANNEL_EXTERNAL_LINKS');
  assert.equal((bound as { workLeaseToken?: string }).workLeaseToken, LEASE);
});

test('bounded slices retain outside direct candidates on the separate validation surface', async () => {
  const result = await runChannelInspection({
    channelId: 'acq-ledger-scope',
    channelName: 'Ledger Scope',
    channelBio: 'Join https://discord.gg/bio-outside',
    channelLinks: ['https://discord.gg/link-outside'],
    pinnedComment: 'Join https://discord.gg/pinned-outside',
    videoDescriptions: ['Join https://discord.gg/video-outside', ...fillers],
    creatorLikelyTrading: false,
    allowedCommunityUrl: (url) => url === 'https://discord.gg/ledger-inside',
    ledgerSeedUrls: [{
      url: 'https://discord.gg/ledger-inside',
      surface: 'CHANNEL_EXTERNAL_LINKS',
      leaseToken: LEASE,
    }],
    externalFetchImpl: noInviteHtml as typeof fetch,
    renderedFallback: emptyRendered,
  });

  const codes = (result.discordCandidates || []).map((candidate) => candidate.nativeInviteCode);
  assert.ok(codes.includes('ledger-inside'), `claimed invite retained: ${codes}`);
  for (const outside of ['bio-outside', 'link-outside', 'pinned-outside', 'video-outside']) {
    assert.ok(codes.includes(outside), `every retained invite must survive the slice: ${outside}`);
    const outcome = (result.acquisitionOutcomes || []).find((item) =>
      String(item.requestedUrl || '').includes(outside) && item.outcome === 'FOUND');
    assert.ok(outcome, `outside invite must have explicit accounting: ${outside}`);
    assert.equal(outcome.surface, 'DISCORD_VALIDATION');
    assert.equal((outcome as { workLeaseToken?: string }).workLeaseToken, undefined,
      'outside invites never consume a claimed URL lease');
  }
  const claimedSurface = (result.acquisitionOutcomes || []).filter((outcome) =>
    String(outcome.requestedUrl || '').includes('outside') && outcome.surface !== 'DISCORD_VALIDATION');
  assert.deepEqual(claimedSurface, [], 'outside candidates must not masquerade as claimed URL work');
});

test('claimed website seeds keep the legacy surface and canonicalize tracking parameters', async () => {
  const fetched: string[] = [];
  const result = await runChannelInspection({
    channelId: 'acq-ledger-surface',
    channelName: 'Ledger Surface',
    channelBio: 'Trading notes',
    channelLinks: [],
    videoDescriptions: fillers,
    creatorLikelyTrading: false,
    allowedCommunityUrl: (url) => url === 'https://creator.example.com/page',
    ledgerSeedUrls: [{
      url: 'https://creator.example.com/page?utm_source=newsletter',
      surface: 'LINKED_WEBSITES',
      leaseToken: LEASE,
    }],
    externalFetchImpl: (async (input) => {
      fetched.push(String(input));
      return noInviteHtml();
    }) as typeof fetch,
    renderedFallback: emptyRendered,
  });

  assert.ok(fetched.some((url) => url === 'https://creator.example.com/page'),
    `the claimed canonical URL must be crawled: ${fetched}`);
  const bound = result.acquisitionOutcomes?.find((outcome) =>
    outcome.requestedUrl === 'https://creator.example.com/page');
  assert.ok(bound, 'the claimed website must produce an observation');
  assert.equal(bound.surface, 'LINKED_WEBSITES',
    'legacy surface identity must survive writeback so the claimed row can complete');
  assert.equal((bound as { workLeaseToken?: string }).workLeaseToken, LEASE);
});
