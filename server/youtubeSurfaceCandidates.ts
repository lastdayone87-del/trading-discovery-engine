/**
 * Public YouTube community-surface collection.
 *
 * The current inspector reads the newest 10 video descriptions and a pinned
 * comment only when a caller supplies one. Production has no pinned-comment
 * producer (PINNED_COMMENT=0). This module fills the highest-yield public
 * surfaces without changing the existing inspection pipeline:
 *
 * - pinned and top comments (Innertube; `is_pinned` is only exposed there);
 * - descriptions for older uploads (beyond the newest 10);
 * - public Community posts;
 * - optional playlist descriptions.
 *
 * It returns bounded text plus Discord candidates. YouTube is a public
 * surface; live validation and ownership still happen downstream. If any
 * surface is unavailable (comments disabled, transient network, parser
 * change), it is skipped rather than failing the inspection.
 */

import { createHash } from 'node:crypto';
import {
  extractDiscordCandidates,
  mergeDiscordCandidates,
  type DiscordCandidate,
} from './discordCandidates';

export interface YouTubeCommentSnapshot {
  text: string;
  videoId: string;
  creator: boolean;
}

export interface YouTubeDescriptionSnapshot {
  text: string;
  videoId: string;
}

export interface YouTubeCommunityPostSnapshot {
  text: string;
  postId: string;
}

export interface YouTubeSurfaceSnapshot {
  pinnedComment?: string;
  pinnedVideoId?: string;
  comments: YouTubeCommentSnapshot[];
  olderDescriptions: YouTubeDescriptionSnapshot[];
  communityPosts: YouTubeCommunityPostSnapshot[];
  playlists: Array<{ text: string; playlistId: string }>;
}

export interface YouTubeSurfaceLimits {
  maxVideoPages: number;
  maxCommentVideos: number;
  maxOlderDescriptions: number;
  maxCommunityPages: number;
  maxPlaylists: number;
  perCallTimeoutMs: number;
  maxTotalMs: number;
}

export const DEFAULT_YOUTUBE_SURFACE_LIMITS: YouTubeSurfaceLimits = {
  maxVideoPages: 3,
  maxCommentVideos: 2,
  maxOlderDescriptions: 20,
  maxCommunityPages: 2,
  maxPlaylists: 2,
  perCallTimeoutMs: 15_000,
  maxTotalMs: 60_000,
};

export interface YouTubeSurfaceClient {
  getChannel(channelId: string): Promise<any>;
  getComments(videoId: string, sort?: string): Promise<any>;
  getBasicInfo(videoId: string): Promise<any>;
  getPlaylist?(playlistId: string): Promise<any>;
}

/** Production adapter. Dynamic import keeps the YouTube parser and its
 * initialization cost out of workers that never touch these surfaces. */
export async function createYouTubeSurfaceClient(): Promise<YouTubeSurfaceClient> {
  const { Innertube } = await import('youtubei.js');
  const yt: any = await Innertube.create({ lang: 'en', location: 'US' });
  return {
    getChannel: (channelId: string) => yt.getChannel(channelId),
    getComments: (videoId: string, sort?: string) => yt.getComments(videoId, sort),
    getBasicInfo: async (videoId: string) => {
      const basic: any = await yt.getBasicInfo(videoId);
      if (basic?.basic_info?.description) return basic;
      // BasicInfo sometimes omits the description; fall back to the full
      // watch page only for videos that need it.
      try { return await yt.getInfo(videoId); } catch { return basic; }
    },
    getPlaylist: (playlistId: string) => yt.getPlaylist(playlistId),
  };
}

function textOf(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  const candidate = value as { toString?: () => string; text?: unknown };
  if (typeof candidate.toString === 'function') {
    try {
      const rendered = candidate.toString();
      if (typeof rendered === 'string' && rendered !== '[object Object]') return rendered;
    } catch { /* fall through */ }
  }
  return typeof candidate.text === 'string' ? candidate.text : '';
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function commentText(comment: any): { text: string; pinned: boolean; owner: boolean } {
  const text = textOf(comment?.content).trim();
  return {
    text,
    pinned: comment?.is_pinned === true,
    owner: comment?.author_is_channel_owner === true,
  };
}

/**
 * Collect a bounded public YouTube surface snapshot. Every network call is
 * individually time-boxed; a surface failure degrades to empty rather than
 * blocking the channel inspection.
 */
export async function collectYouTubeSurfaceSnapshot(
  channelId: string,
  client: YouTubeSurfaceClient,
  limits: Partial<YouTubeSurfaceLimits> = {},
): Promise<YouTubeSurfaceSnapshot> {
  const settings = { ...DEFAULT_YOUTUBE_SURFACE_LIMITS, ...limits };
  const deadline = Date.now() + Math.max(1_000, settings.maxTotalMs);
  const callTimeout = (): number => Math.max(1, Math.min(settings.perCallTimeoutMs, deadline - Date.now()));
  const expired = (): boolean => Date.now() >= deadline;
  const snapshot: YouTubeSurfaceSnapshot = {
    comments: [],
    olderDescriptions: [],
    communityPosts: [],
    playlists: [],
  };
  if (!channelId) return snapshot;

  let channel: any = null;
  try {
    channel = await withTimeout(client.getChannel(channelId), callTimeout());
  } catch {
    channel = null;
  }
  if (!channel) return snapshot;

  // ---- video inventory (newest first), bounded by pages -----------------
  const videoIds: string[] = [];
  try {
    let feed: any = await withTimeout(channel.getVideos?.(), callTimeout());
    let pages = 0;
    while (feed && pages < settings.maxVideoPages && !expired()) {
      for (const video of feed.videos || []) {
        const id = video?.content_id || video?.id;
        if (typeof id === 'string' && id) videoIds.push(id);
      }
      if (!feed.has_continuation) break;
      feed = await withTimeout(feed.getContinuation?.(), callTimeout());
      pages += 1;
    }
  } catch { /* video inventory is best-effort */ }

  // ---- pinned + top comments (first page of the selected videos) --------
  for (const videoId of videoIds.slice(0, settings.maxCommentVideos)) {
    if (expired()) break;
    try {
      const comments = await withTimeout(client.getComments(videoId, 'TOP_COMMENTS'), callTimeout());
      for (const item of comments?.contents || []) {
        const parsed = commentText(item?.comment ?? item);
        if (!parsed.text) continue;
        if (parsed.pinned && !snapshot.pinnedComment) {
          snapshot.pinnedComment = parsed.text;
          snapshot.pinnedVideoId = videoId;
        }
        // Authorship is preserved: only creator-authored comments may become
        // RECENT_VIDEO_DESCRIPTIONS evidence. Viewer comments use the
        // distinct YOUTUBE_COMMENTS surface and cannot gain creator ownership
        // through repetition.
        snapshot.comments.push({ text: parsed.text, videoId, creator: parsed.owner });
      }
    } catch { /* comments may be disabled */ }
  }

  // ---- older descriptions (beyond the newest 10) ------------------------
  for (const videoId of videoIds.slice(10, 10 + settings.maxOlderDescriptions)) {
    if (expired()) break;
    try {
      const info: any = await withTimeout(client.getBasicInfo(videoId), callTimeout());
      const description = textOf(info?.basic_info?.description || info?.secondary_info?.description).trim();
      if (description) snapshot.olderDescriptions.push({ text: description, videoId });
    } catch { /* one failed description does not stop the surface */ }
  }

  // ---- public Community posts ------------------------------------------
  if (channel.has_community && typeof channel.getCommunity === 'function') {
    try {
      let feed: any = await withTimeout(channel.getCommunity(), callTimeout());
      let pages = 0;
      while (feed && pages < settings.maxCommunityPages && !expired()) {
        for (const post of feed.posts || []) {
          const text = textOf(post?.content).trim();
          if (text) snapshot.communityPosts.push({ text, postId: String(post?.id || '') });
        }
        if (!feed.has_continuation) break;
        feed = await withTimeout(feed.getContinuation?.(), callTimeout());
        pages += 1;
      }
    } catch { /* Community tab may be unavailable */ }
  }

  // ---- playlists (descriptions + first page items) ----------------------
  if (typeof channel.getPlaylists === 'function') {
    try {
      const feed: any = await withTimeout(channel.getPlaylists(), callTimeout());
      for (const playlist of (feed?.playlists || []).slice(0, settings.maxPlaylists)) {
        if (expired()) break;
        const id = playlist?.content_id || playlist?.id;
        if (typeof id !== 'string' || !id) continue;
        try {
          const full: any = client.getPlaylist
            ? await withTimeout(client.getPlaylist(id), callTimeout())
            : null;
          const description = textOf(full?.info?.description).trim();
          if (description) snapshot.playlists.push({ text: description, playlistId: id });
          for (const item of (full?.items || []).slice(0, 20)) {
            const text = textOf(item?.description || item?.title).trim();
            if (text) snapshot.playlists.push({ text, playlistId: id });
          }
        } catch { /* playlist may be private/deleted */ }
      }
    } catch { /* playlist tab may be unavailable */ }
  }

  snapshot.comments = [...new Map(snapshot.comments.map(comment => [`${comment.videoId}\u0000${comment.text}`, comment])).values()].slice(0, 40);
  snapshot.olderDescriptions = [...new Map(snapshot.olderDescriptions.map(description => [description.videoId, description])).values()].slice(0, settings.maxOlderDescriptions);
  snapshot.communityPosts = [...new Map(snapshot.communityPosts.map(post => [post.postId || post.text, post])).values()].slice(0, 20);
  snapshot.playlists = [...new Map(snapshot.playlists.map(playlist => [`${playlist.playlistId}\u0000${playlist.text}`, playlist])).values()].slice(0, 20);
  return snapshot;
}

/**
 * Deterministic channel canary. `basisPoints` 10000 = all, 0 = none; the
 * default rollout uses 5% while zero-invite channels are prioritized. The
 * hash is stable per channel so a retry cannot flip treatment.
 */
export function isYouTubeSurfaceCanarySelected(channelId: string, basisPoints: number): boolean {
  const bp = Number.isFinite(basisPoints) ? Math.max(0, Math.min(10_000, Math.floor(basisPoints))) : 0;
  if (bp <= 0) return false;
  if (bp >= 10_000) return true;
  const digest = createHash('sha256').update(String(channelId || '')).digest();
  return digest.readUInt32BE(0) % 10_000 < bp;
}

/** Build candidates from a snapshot. Pure and deterministic for tests. */
export function candidatesFromYouTubeSnapshot(
  snapshot: YouTubeSurfaceSnapshot,
  channelId: string,
): DiscordCandidate[] {
  const out: DiscordCandidate[] = [];
  const source = (suffix: string) => `youtube:channel:${channelId}:${suffix}`;
  if (snapshot.pinnedComment) {
    out.push(...extractDiscordCandidates(
      snapshot.pinnedComment,
      'PINNED_COMMENT',
      source(`video:${snapshot.pinnedVideoId || 'unknown'}:pinned-comment`),
    ));
  }
  for (let i = 0; i < snapshot.comments.length; i++) {
    const comment = snapshot.comments[i];
    // Viewer comments are retained for discovery but can never contribute
    // creator-video ownership points. Only the creator's own comments use the
    // creator-description surface.
    out.push(...extractDiscordCandidates(
      comment.text,
      comment.creator ? 'RECENT_VIDEO_DESCRIPTIONS' : 'YOUTUBE_COMMENTS',
      source(`video:${comment.videoId || 'unknown'}:comment:${i + 1}`),
    ));
  }
  for (let i = 0; i < snapshot.olderDescriptions.length; i++) {
    const description = snapshot.olderDescriptions[i];
    out.push(...extractDiscordCandidates(
      description.text,
      'RECENT_VIDEO_DESCRIPTIONS',
      source(`video:${description.videoId || 'unknown'}:older-description:${i + 1}`),
    ));
  }
  for (let i = 0; i < snapshot.communityPosts.length; i++) {
    const post = snapshot.communityPosts[i];
    out.push(...extractDiscordCandidates(
      post.text,
      'RECENT_VIDEO_DESCRIPTIONS',
      source(`community-post:${post.postId || i + 1}`),
    ));
  }
  for (let i = 0; i < snapshot.playlists.length; i++) {
    const playlist = snapshot.playlists[i];
    out.push(...extractDiscordCandidates(
      playlist.text,
      'RECENT_VIDEO_DESCRIPTIONS',
      source(`playlist:${playlist.playlistId || i + 1}:${i + 1}`),
    ));
  }
  return mergeDiscordCandidates(out.filter(candidate => !!candidate.nativeInviteCode));
}

/** Merge YouTube candidates into an existing inspection result without
 * discarding static/rendered candidates or changing their precedence. */
export function mergeYouTubeSurfaceCandidates<T extends {
  discordCandidates?: DiscordCandidate[];
  foundInvite?: string | null;
}>(
  inspection: T,
  youtubeCandidates: DiscordCandidate[],
): T {
  if (!youtubeCandidates.length) return inspection;
  const merged = mergeDiscordCandidates([...(inspection.discordCandidates || []), ...youtubeCandidates]);
  return {
    ...inspection,
    discordCandidates: merged,
    foundInvite: inspection.foundInvite || merged.find(candidate => candidate.nativeInviteCode)?.nativeInviteCode || null,
  };
}
