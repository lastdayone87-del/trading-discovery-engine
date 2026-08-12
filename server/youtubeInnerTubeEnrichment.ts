import { appendProviderCallEvent } from './db';
import { executeProviderCall, type ProviderCallContext } from './providerResilience';

export interface InnerTubeEnrichmentVideo {
  id?: string;
  title: string;
  description?: string;
  published_at?: string;
  content_type: 'youtube_video';
}

export interface InnerTubeEnrichmentPlaylist {
  id?: string;
  name: string;
  description?: string;
}

export interface InnerTubeChannelEnrichmentResult {
  videos: InnerTubeEnrichmentVideo[];
  playlists: InnerTubeEnrichmentPlaylist[];
  pagesFetched: number;
  detailCalls: number;
}

interface InnerTubeChannelLike {
  has_videos?: boolean;
  has_playlists?: boolean;
  videos?: any[];
  playlists?: any[];
  getVideos?: () => Promise<InnerTubeChannelLike>;
  getPlaylists?: () => Promise<InnerTubeChannelLike>;
  has_continuation?: boolean;
  getContinuation?: () => Promise<InnerTubeChannelLike>;
}

interface InnerTubeClientLike {
  getChannel(id: string): Promise<InnerTubeChannelLike>;
  getBasicInfo(id: string): Promise<any>;
}

let clientPromise: Promise<InnerTubeClientLike> | null = null;

async function getClient(): Promise<InnerTubeClientLike> {
  if (!clientPromise) clientPromise = import('youtubei.js').then(async (mod: any) => mod.Innertube.create());
  return clientPromise;
}

function textValue(value: any): string {
  if (typeof value === 'string') return value.trim();
  return String(value?.text || value?.simpleText || value?.toString?.() || '').trim();
}

function normalizePublishedAt(value: unknown, nowMs = Date.now()): string | undefined {
  const raw = textValue(value);
  if (!raw) return undefined;
  const direct = Date.parse(raw);
  if (Number.isFinite(direct)) return new Date(direct).toISOString();
  const text = raw.toLowerCase().replace(/^(streamed|premiered|published|uploaded)\s+/, '').trim();
  if (text === 'today' || text === 'live now') return new Date(nowMs).toISOString();
  if (text === 'yesterday') return new Date(nowMs - 86_400_000).toISOString();
  const article = text.match(/^(?:a|an)\s+(second|minute|hour|day|week|month|year)\s+ago$/);
  const numeric = text.match(/^(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/);
  const amount = article ? 1 : numeric ? Number(numeric[1]) : NaN;
  const unit = article?.[1] || numeric?.[2];
  if (!unit || !Number.isFinite(amount)) return undefined;
  const days: Record<string, number> = { second: 1 / 86400, minute: 1 / 1440, hour: 1 / 24, day: 1, week: 7, month: 30.4375, year: 365.25 };
  return new Date(nowMs - amount * days[unit] * 86_400_000).toISOString();
}

function videoId(item: any): string {
  return textValue(item?.id || item?.video_id || item?.endpoint?.payload?.videoId || item?.endpoint?.payload?.video_id);
}

function titleOf(item: any): string {
  return textValue(item?.title || item?.headline);
}

function publishedOf(item: any): string | undefined {
  return normalizePublishedAt(item?.published || item?.published_time || item?.published_at || item?.metadata?.published);
}

function playlistId(item: any): string {
  return textValue(item?.id || item?.playlist_id || item?.endpoint?.payload?.playlistId);
}

function playlistName(item: any): string {
  return textValue(item?.title || item?.name);
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return output;
}

export async function fetchInnerTubeChannelEnrichment(
  channelId: string,
  options: {
    maxVideos?: number;
    detailVideos?: number;
    includePlaylists?: boolean;
    timeoutMs?: number;
    telemetry?: Pick<ProviderCallContext, 'requestId' | 'runId' | 'jobId' | 'attempt'>;
  } = {},
  injectedClient?: InnerTubeClientLike
): Promise<InnerTubeChannelEnrichmentResult> {
  const maxVideos = Math.min(20, Math.max(1, Math.trunc(options.maxVideos ?? 10)));
  const detailVideos = Math.min(maxVideos, Math.max(0, Math.trunc(options.detailVideos ?? 10)));
  const timeoutMs = Math.min(30_000, Math.max(2_000, Math.trunc(options.timeoutMs ?? 15_000)));
  const client = injectedClient || await getClient();
  const baseContext: ProviderCallContext = {
    provider: 'youtube_js', operation: 'channel-enrichment',
    requestId: options.telemetry?.requestId, runId: options.telemetry?.runId,
    jobId: options.telemetry?.jobId, attempt: options.telemetry?.attempt,
    reservedCost: 0, actualCost: 0, policyVersion: 'youtube-js-hybrid-enrichment-v1'
  };

  const channel = await executeProviderCall({
    context: baseContext, timeoutMs, emit: appendProviderCallEvent,
    call: async () => client.getChannel(channelId)
  });

  let videosFeed: InnerTubeChannelLike = channel;
  if (channel.getVideos && channel.has_videos !== false) {
    videosFeed = await executeProviderCall({
      context: { ...baseContext, operation: 'channel-enrichment-videos' }, timeoutMs, emit: appendProviderCallEvent,
      call: async () => channel.getVideos!()
    });
  }

  const rawVideos: any[] = [];
  let current: InnerTubeChannelLike | undefined = videosFeed;
  let pagesFetched = 0;
  while (current && rawVideos.length < maxVideos && pagesFetched < 2) {
    pagesFetched++;
    for (const item of Array.from(current.videos || [])) {
      const id = videoId(item), title = titleOf(item);
      if (!id || !title || rawVideos.some(existing => videoId(existing) === id)) continue;
      rawVideos.push(item);
      if (rawVideos.length >= maxVideos) break;
    }
    if (rawVideos.length >= maxVideos || !current.has_continuation || !current.getContinuation) break;
    current = await executeProviderCall({
      context: { ...baseContext, operation: 'channel-enrichment-videos-continuation', attempt: (options.telemetry?.attempt || 1) + pagesFetched },
      timeoutMs, emit: appendProviderCallEvent, call: async () => current!.getContinuation!()
    });
  }

  const selected = rawVideos.slice(0, maxVideos);
  const detailed = await mapWithConcurrency(selected, 4, async (item, index) => {
    const id = videoId(item);
    const base: InnerTubeEnrichmentVideo = { id, title: titleOf(item), published_at: publishedOf(item), content_type: 'youtube_video' };
    if (!id || index >= detailVideos) return base;
    try {
      const info = await executeProviderCall({
        context: { ...baseContext, operation: 'channel-enrichment-video-detail', attempt: index + 1 },
        timeoutMs, emit: appendProviderCallEvent, call: async () => client.getBasicInfo(id)
      });
      const basic = info?.basic_info || {};
      return {
        ...base,
        title: textValue(basic.title) || base.title,
        description: textValue(basic.short_description) || undefined
      };
    } catch {
      return base;
    }
  });

  let playlists: InnerTubeEnrichmentPlaylist[] = [];
  if (options.includePlaylists && channel.getPlaylists && channel.has_playlists !== false) {
    try {
      const playlistFeed = await executeProviderCall({
        context: { ...baseContext, operation: 'channel-enrichment-playlists' }, timeoutMs, emit: appendProviderCallEvent,
        call: async () => channel.getPlaylists!()
      });
      playlists = Array.from(playlistFeed.playlists || []).slice(0, 10).map(item => ({
        id: playlistId(item) || undefined,
        name: playlistName(item),
        description: textValue((item as any)?.description || (item as any)?.description_snippet) || undefined
      })).filter(item => item.name);
    } catch {
      playlists = [];
    }
  }

  return { videos: detailed, playlists, pagesFetched, detailCalls: Math.min(detailVideos, selected.length) };
}

export function resetInnerTubeEnrichmentClientForTests(): void {
  clientPromise = null;
}
