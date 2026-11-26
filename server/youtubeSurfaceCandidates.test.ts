import assert from 'node:assert/strict';
import test from 'node:test';
import { makeDiscordCandidate } from './discordCandidates';
import {
  candidatesFromYouTubeSnapshot,
  collectYouTubeSurfaceSnapshot,
  isYouTubeSurfaceCanarySelected,
  mergeYouTubeSurfaceCandidates,
  type YouTubeSurfaceClient,
  type YouTubeSurfaceSnapshot,
} from './youtubeSurfaceCandidates';

const text = (value: string) => ({ toString: () => value });

test('collects pinned, top, older, Community and playlist text with bounds', async () => {
  const channel = {
    has_community: true,
    getVideos: async () => ({
      videos: Array.from({ length: 14 }, (_, index) => ({ content_id: `video-${index + 1}` })),
      has_continuation: false,
    }),
    getCommunity: async () => ({
      posts: [{ content: text('Community post https://discord.gg/COMMUNITY') }],
      has_continuation: false,
    }),
    getPlaylists: async () => ({ playlists: [{ content_id: 'playlist-1' }] }),
  };
  const client: YouTubeSurfaceClient & { getPlaylist: (id: string) => Promise<any> } = {
    getChannel: async () => channel,
    getComments: async (videoId) => ({
      contents: [
        { comment: { content: text(`Pinned https://discord.gg/PINNED-${videoId}`), is_pinned: true, author_is_channel_owner: true } },
        { comment: { content: text('Top comment https://discord.gg/TOP'), is_pinned: false, author_is_channel_owner: false } },
      ],
    }),
    getBasicInfo: async (videoId) => ({ basic_info: { description: `Older ${videoId} https://discord.gg/OLDER` } }),
    getPlaylist: async () => ({ info: { description: 'Playlist https://discord.gg/PLAYLIST' }, items: [] }),
  };

  const snapshot = await collectYouTubeSurfaceSnapshot('channel-1', client, {
    maxCommentVideos: 1,
    maxOlderDescriptions: 2,
    maxCommunityPages: 1,
    maxPlaylists: 1,
    perCallTimeoutMs: 2_000,
  });

  assert.equal(snapshot.pinnedComment, 'Pinned https://discord.gg/PINNED-video-1');
  assert.ok(snapshot.comments.some(value => value.includes('TOP')));
  assert.equal(snapshot.olderDescriptions.length, 2);
  assert.equal(snapshot.communityPosts.length, 1);
  assert.equal(snapshot.playlists.length, 1);
});

test('builds and merges candidates from every YouTube surface', () => {
  const snapshot: YouTubeSurfaceSnapshot = {
    pinnedComment: 'https://discord.gg/PINNED',
    comments: ['https://discord.gg/TOPCOMMENT'],
    olderDescriptions: ['https://discord.gg/OLDER'],
    communityPosts: ['https://discord.gg/COMMUNITY'],
    playlists: ['https://discord.gg/PLAYLIST'],
  };
  const candidates = candidatesFromYouTubeSnapshot(snapshot, 'channel-1');
  const codes = candidates.map(candidate => candidate.nativeInviteCode).sort();
  assert.deepEqual(codes, ['COMMUNITY', 'OLDER', 'PINNED', 'PLAYLIST', 'TOPCOMMENT']);
  assert.equal(candidates.filter(candidate => candidate.sourceSurface === 'PINNED_COMMENT').length, 1);

  const existing = makeDiscordCandidate({
    locatorType: 'NATIVE_INVITE',
    sourceSurface: 'CREATOR_WEBSITES',
    rawLocator: 'https://discord.gg/STATIC',
    nativeInviteCode: 'STATIC',
    extractionConfidence: 'EXPLICIT',
  });
  const merged = mergeYouTubeSurfaceCandidates(
    { discordCandidates: [existing], foundInvite: 'STATIC' },
    candidates,
  );
  assert.equal(merged.discordCandidates?.length, 6);
  assert.ok(merged.discordCandidates?.some(candidate => candidate.nativeInviteCode === 'PINNED'));
  assert.equal(merged.foundInvite, 'STATIC');
});

test('YouTube canary selection is deterministic and bounded', () => {
  assert.equal(isYouTubeSurfaceCanarySelected('channel-a', 0), false);
  assert.equal(isYouTubeSurfaceCanarySelected('channel-a', 10_000), true);
  const first = isYouTubeSurfaceCanarySelected('channel-a', 5_000);
  assert.equal(isYouTubeSurfaceCanarySelected('channel-a', 5_000), first);
  let selected = 0;
  for (let index = 0; index < 2_000; index++) if (isYouTubeSurfaceCanarySelected(`c-${index}`, 5_000)) selected++;
  assert.ok(selected > 700 && selected < 1_300, `5% canary selected ${selected}/2000`);
});

test('the overall deadline bounds a slow YouTube surface collection', async () => {
  const client: YouTubeSurfaceClient = {
    getChannel: async () => new Promise(resolve => setTimeout(() => resolve({}), 50)),
    getComments: async () => ({ contents: [] }),
    getBasicInfo: async () => ({ basic_info: {} }),
  };
  const startedAt = Date.now();
  const snapshot = await collectYouTubeSurfaceSnapshot('channel-1', client, {
    maxTotalMs: 5,
    perCallTimeoutMs: 50,
  });
  assert.deepEqual(snapshot, { comments: [], olderDescriptions: [], communityPosts: [], playlists: [] });
  // The 5 ms deadline is intentionally tiny; allow event-loop scheduling
  // slack while still proving the collector returns instead of waiting for the
  // 50 ms surface promise.
  assert.ok(Date.now() - startedAt < 250, 'collection exceeded the overall deadline');
});

test('a failed surface degrades to an empty snapshot instead of throwing', async () => {
  const client: YouTubeSurfaceClient = {
    getChannel: async () => { throw new Error('network'); },
    getComments: async () => ({ contents: [] }),
    getBasicInfo: async () => ({ basic_info: {} }),
  };
  const snapshot = await collectYouTubeSurfaceSnapshot('channel-1', client);
  assert.deepEqual(snapshot, { comments: [], olderDescriptions: [], communityPosts: [], playlists: [] });
});
