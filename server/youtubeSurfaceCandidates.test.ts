import assert from 'node:assert/strict';
import test from 'node:test';
import { makeDiscordCandidate } from './discordCandidates';
import {
  candidatesFromYouTubeSnapshot,
  collectYouTubeSurfaceSnapshot,
  isYouTubeSurfaceCanarySelected,
  isYouTubeSurfaceExpansionEligible,
  mergeYouTubeSurfaceCandidates,
  YOUTUBE_SURFACE_SESSION_OPTIONS,
  type YouTubeSurfaceClient,
  type YouTubeSurfaceSnapshot,
} from './youtubeSurfaceCandidates';

const text = (value: string) => ({ toString: () => value });

test('production Innertube client uses a fast local session', () => {
  assert.equal(YOUTUBE_SURFACE_SESSION_OPTIONS.retrieve_player, false);
  assert.equal(YOUTUBE_SURFACE_SESSION_OPTIONS.retrieve_innertube_config, false);
  assert.equal(YOUTUBE_SURFACE_SESSION_OPTIONS.generate_session_locally, true);
  assert.equal(YOUTUBE_SURFACE_SESSION_OPTIONS.enable_session_cache, false);
});

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
  let commentCalls = 0;
  const client: YouTubeSurfaceClient & { getPlaylist: (id: string) => Promise<any> } = {
    getChannel: async () => channel,
    getComments: async (videoId) => {
      commentCalls += 1;
      return ({
      contents: [
        { comment: { content: text(`Pinned https://discord.gg/PINNED-${videoId}`), is_pinned: true, author_is_channel_owner: true } },
        { comment: { content: text('Top comment https://discord.gg/TOP'), is_pinned: false, author_is_channel_owner: false } },
      ],
      });
    },
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
  assert.equal(snapshot.pinnedCommentCreator, true);
  assert.ok(snapshot.comments.some(value => value.text.includes('TOP')));
  assert.equal(snapshot.comments.find(value => value.text.includes('TOP'))?.creator, false);
  assert.equal(commentCalls, 1, 'maxCommentVideos bounds comment fetches');
  assert.equal(snapshot.olderDescriptions.length, 2);
  assert.equal(snapshot.communityPosts.length, 1);
  assert.equal(snapshot.playlists.length, 1);
});

test('continuation fetching is bounded by the configured page cap', async () => {
  let videoFeedCalls = 0;
  let communityFeedCalls = 0;
  const videoFeed = (page: number): any => {
    videoFeedCalls += 1;
    return {
      videos: [{ content_id: `video-${page}` }],
      has_continuation: true,
      getContinuation: async () => videoFeed(page + 1),
    };
  };
  const communityFeed = (page: number): any => {
    communityFeedCalls += 1;
    return {
      posts: [{ content: text(`post-${page}`) }],
      has_continuation: true,
      getContinuation: async () => communityFeed(page + 1),
    };
  };
  const channel = {
    has_community: true,
    getVideos: async () => videoFeed(1),
    getCommunity: async () => communityFeed(1),
    getPlaylists: async () => ({ playlists: [] }),
  };
  const client: YouTubeSurfaceClient = {
    getChannel: async () => channel,
    getComments: async () => ({ contents: [] }),
    getBasicInfo: async () => ({}),
  };
  await collectYouTubeSurfaceSnapshot('channel-1', client, {
    maxVideoPages: 2,
    maxCommunityPages: 1,
    maxCommentVideos: 0,
    maxOlderDescriptions: 0,
    maxPlaylists: 0,
    perCallTimeoutMs: 1_000,
    maxTotalMs: 5_000,
  });
  assert.equal(videoFeedCalls, 2, 'initial video page plus one continuation only');
  assert.equal(communityFeedCalls, 1, 'Community is capped at its first page');
});

test('a rejected Innertube call is contained instead of becoming unhandled', async () => {
  const client: YouTubeSurfaceClient = {
    getChannel: async () => {
      throw new Error('network down');
    },
    getComments: async () => ({ contents: [] }),
    getBasicInfo: async () => ({}),
  };
  const snapshot = await collectYouTubeSurfaceSnapshot('channel-1', client);
  assert.deepEqual(snapshot.comments, []);
  assert.deepEqual(snapshot.olderDescriptions, []);
});

test('a rejection after the per-call timeout stays contained', async () => {
  const client: YouTubeSurfaceClient = {
    getChannel: () => new Promise((_, reject) => setTimeout(() => reject(new Error('late network error')), 25)),
    getComments: async () => ({ contents: [] }),
    getBasicInfo: async () => ({}),
  };
  const snapshot = await collectYouTubeSurfaceSnapshot('channel-1', client, {
    maxTotalMs: 10,
    perCallTimeoutMs: 5,
  });
  assert.deepEqual(snapshot.comments, []);
  // Let the abandoned promise reject; the guarded timeout must not surface an
  // unhandledRejection to the test runner.
  await new Promise(resolve => setTimeout(resolve, 40));
});

test('builds and merges candidates from every YouTube surface', () => {
  const snapshot: YouTubeSurfaceSnapshot = {
    pinnedComment: 'https://discord.gg/PINNED',
    pinnedVideoId: 'video-pinned',
    pinnedCommentCreator: true,
    comments: [
      { text: 'https://discord.gg/TOPCOMMENT', videoId: 'video-1', creator: false },
      { text: 'https://discord.gg/CREATORCOMMENT', videoId: 'video-1', creator: true },
    ],
    olderDescriptions: [{ text: 'https://discord.gg/OLDER', videoId: 'video-2' }],
    communityPosts: [{ text: 'https://discord.gg/COMMUNITY', postId: 'post-1' }],
    playlists: [{ text: 'https://discord.gg/PLAYLIST', playlistId: 'playlist-1' }],
  };
  const candidates = candidatesFromYouTubeSnapshot(snapshot, 'channel-1');
  const codes = candidates.map(candidate => candidate.nativeInviteCode).sort();
  assert.deepEqual(codes, ['COMMUNITY', 'CREATORCOMMENT', 'OLDER', 'PINNED', 'PLAYLIST', 'TOPCOMMENT']);
  assert.equal(candidates.filter(candidate => candidate.sourceSurface === 'PINNED_COMMENT').length, 1);
  assert.equal(candidates.find(candidate => candidate.nativeInviteCode === 'TOPCOMMENT')?.sourceSurface, 'YOUTUBE_COMMENTS');
  assert.equal(candidates.find(candidate => candidate.nativeInviteCode === 'CREATORCOMMENT')?.sourceSurface, 'RECENT_VIDEO_DESCRIPTIONS');

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
  assert.equal(merged.discordCandidates?.length, 7);
  assert.ok(merged.discordCandidates?.some(candidate => candidate.nativeInviteCode === 'PINNED'));
  assert.equal(merged.foundInvite, 'STATIC');
});

test('playlist item text is not creator-description evidence', () => {
  const snapshot: YouTubeSurfaceSnapshot = {
    comments: [],
    olderDescriptions: [],
    communityPosts: [],
    playlists: [
      { text: 'https://discord.gg/PLAYLISTDESC', playlistId: 'p1', creatorWritten: true },
      { text: 'https://discord.gg/PLAYLISTITEM', playlistId: 'p1', creatorWritten: false },
    ],
  };
  const candidates = candidatesFromYouTubeSnapshot(snapshot, 'channel-1');
  assert.equal(candidates.find(candidate => candidate.nativeInviteCode === 'PLAYLISTDESC')?.sourceSurface, 'RECENT_VIDEO_DESCRIPTIONS');
  assert.equal(candidates.find(candidate => candidate.nativeInviteCode === 'PLAYLISTITEM')?.sourceSurface, 'YOUTUBE_PLAYLIST_ITEMS');
  assert.notEqual(candidates.find(candidate => candidate.nativeInviteCode === 'PLAYLISTITEM')?.ownershipStatus, 'CREATOR_OWNED');
});

test('a viewer-authored pinned comment is not creator-owned evidence', () => {
  const snapshot: YouTubeSurfaceSnapshot = {
    pinnedComment: 'https://discord.gg/VIEWERPIN',
    pinnedVideoId: 'video-1',
    pinnedCommentCreator: false,
    comments: [],
    olderDescriptions: [],
    communityPosts: [],
    playlists: [],
  };
  const candidate = candidatesFromYouTubeSnapshot(snapshot, 'channel-1')[0];
  assert.equal(candidate?.sourceSurface, 'YOUTUBE_COMMENTS');
  assert.notEqual(candidate?.ownershipStatus, 'CREATOR_OWNED');
});

test('viewer comments never become creator-owned through repetition', () => {
  const snapshot: YouTubeSurfaceSnapshot = {
    comments: [
      { text: 'https://discord.gg/VIEWERONE', videoId: 'video-1', creator: false },
      { text: 'https://discord.gg/VIEWERONE', videoId: 'video-2', creator: false },
    ],
    olderDescriptions: [],
    communityPosts: [],
    playlists: [],
  };
  const candidates = candidatesFromYouTubeSnapshot(snapshot, 'channel-1');
  assert.equal(candidates.every(candidate => candidate.sourceSurface === 'YOUTUBE_COMMENTS'), true);
  assert.equal(candidates.every(candidate => candidate.ownershipStatus !== 'CREATOR_OWNED'), true);
});

test('only a recorded invite suppresses YouTube surface expansion', () => {
  assert.equal(isYouTubeSurfaceExpansionEligible({ trading_status: 'TRADING_CONFIRMED', discord_invite: null }), true);
  assert.equal(isYouTubeSurfaceExpansionEligible({ trading_status: 'TRADING_CONFIRMED', discord_invite: 'https://discord.gg/known' }), false);
  assert.equal(isYouTubeSurfaceExpansionEligible({ trading_status: 'UNCERTAIN', discord_invite: null }), false);
});

test('YouTube canary selection is deterministic and bounded', () => {
  assert.equal(isYouTubeSurfaceCanarySelected('channel-a', 0), false);
  assert.equal(isYouTubeSurfaceCanarySelected('channel-a', 10_000), true);
  const first = isYouTubeSurfaceCanarySelected('channel-a', 500);
  assert.equal(isYouTubeSurfaceCanarySelected('channel-a', 500), first);
  let selected = 0;
  for (let index = 0; index < 2_000; index++) if (isYouTubeSurfaceCanarySelected(`c-${index}`, 500)) selected++;
  assert.ok(selected > 70 && selected < 130, `5% canary selected ${selected}/2000`);
});

test('the overall deadline bounds a slow YouTube surface collection', async () => {
  const client: YouTubeSurfaceClient = {
    // Never resolves: only the deadline timer can make the collector return.
    getChannel: () => new Promise(() => {}),
    getComments: async () => ({ contents: [] }),
    getBasicInfo: async () => ({ basic_info: {} }),
  };
  const snapshot = await collectYouTubeSurfaceSnapshot('channel-1', client, {
    maxTotalMs: 10,
    perCallTimeoutMs: 10,
  });
  assert.deepEqual(snapshot, { comments: [], olderDescriptions: [], communityPosts: [], playlists: [] });
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
