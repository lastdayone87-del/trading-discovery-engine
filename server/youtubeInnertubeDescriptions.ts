/**
 * Shadow-only Innertube video-description collector.
 *
 * Pure acquisition logic over an injected session interface: no database, no
 * queue, no enrichment decisions, no retry scheduling, no provider priority,
 * no browser. The shadow runner script wires a real youtubei.js session;
 * unit tests inject stubs. Telemetry-only output per channel.
 */

export interface InnertubeShadowVideoRef {
  id: string;
  title: string;
}

export interface InnertubeShadowSession {
  listChannelVideos(channelId: string): Promise<{ videos: InnertubeShadowVideoRef[]; listingNote?: string }>;
  fetchVideoDescription(videoId: string): Promise<{ description: string } | null>;
  onSessionError?: () => void;
}

export interface InnertubeShadowOptions {
  maxVideos?: number;
  intervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}

export interface InnertubeShadowLatency {
  totalMs: number;
  perCallP50Ms: number;
  perCallMaxMs: number;
}

export interface InnertubeShadowResult {
  channelId: string;
  videosListed: number;
  videosAttempted: number;
  descriptionsRecovered: number;
  calls: number;
  callsPerDescription: number | null;
  latencyMs: InnertubeShadowLatency;
  rateLimited: number;
  sessionErrors: number;
  timeouts: number;
  notFound: number;
  parseFailures: number;
  listingNote?: string;
  failed: boolean;
  error?: string;
}

const RATE_LIMIT = /too many requests|rate.?limit|quota.?exceeded|429/;
const SESSION = /session.{0,20}(expired|invalid)|visitor.{0,20}(data|expired)|invalid session/i;
const NOT_FOUND = /not.?found|private|deleted|unavailable|404/;

function classifyShadowError(error: unknown): 'rateLimited' | 'session' | 'notFound' | 'timeout' | 'other' {
  if (error instanceof Error && error.name === 'ShadowTimeout') return 'timeout';
  const status = Number((error as { status?: unknown })?.status);
  if (status === 429) return 'rateLimited';
  if (status === 404) return 'notFound';
  const message = String((error as Error)?.message || error || '');
  if (RATE_LIMIT.test(message)) return 'rateLimited';
  if (SESSION.test(message)) return 'session';
  if (NOT_FOUND.test(message)) return 'notFound';
  return 'other';
}

function percentile(sorted: number[], ratio: number): number {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(ratio * sorted.length)));
  return sorted[index];
}

export async function collectChannelVideoDescriptions(
  session: InnertubeShadowSession,
  channelId: string,
  opts: InnertubeShadowOptions = {},
): Promise<InnertubeShadowResult> {
  const maxVideos = Math.min(25, Math.max(1, Math.floor(opts.maxVideos ?? 10) || 10));
  const intervalMs = Math.max(0, Math.floor(opts.intervalMs ?? 1500) || 0);
  const timeoutMs = Math.max(1000, Math.floor(opts.timeoutMs ?? 30000) || 30000);
  const now = opts.now ?? Date.now;
  const wait = opts.wait ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const startedAt = now();
  const callLatencies: number[] = [];
  const result: InnertubeShadowResult = {
    channelId,
    videosListed: 0,
    videosAttempted: 0,
    descriptionsRecovered: 0,
    calls: 0,
    callsPerDescription: null,
    latencyMs: { totalMs: 0, perCallP50Ms: 0, perCallMaxMs: 0 },
    rateLimited: 0,
    sessionErrors: 0,
    timeouts: 0,
    notFound: 0,
    parseFailures: 0,
    failed: false,
  };
  const timed = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
    const callStarted = now();
    result.calls += 1;
    if (result.calls > 1 && intervalMs > 0) await wait(intervalMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const timeout = new Error(`${label} timed out after ${timeoutMs}ms`);
            timeout.name = 'ShadowTimeout';
            reject(timeout);
          }, timeoutMs);
        }),
      ]);
      return value;
    } finally {
      if (timer) clearTimeout(timer);
      callLatencies.push(Math.max(0, now() - callStarted));
    }
  };
  const noteError = (error: unknown): 'rateLimited' | 'session' | 'notFound' | 'timeout' | 'other' => {
    const kind = classifyShadowError(error);
    if (kind === 'rateLimited') result.rateLimited += 1;
    else if (kind === 'session') {
      result.sessionErrors += 1;
      try {
        session.onSessionError?.();
      } catch {
        // Telemetry callback must never break measurement.
      }
    } else if (kind === 'notFound') result.notFound += 1;
    else if (kind === 'timeout') result.timeouts += 1;
    else result.parseFailures += 1;
    return kind;
  };
  try {
    let listed: InnertubeShadowVideoRef[];
    try {
      const listing = await timed('listChannelVideos', () => session.listChannelVideos(channelId));
      if (!listing || !Array.isArray(listing.videos)) {
        result.parseFailures += 1;
        result.failed = true;
        result.error = 'listing shape unrecognized';
        return result;
      }
      listed = listing.videos.filter(video => typeof video?.id === 'string' && video.id);
      if (listing.listingNote) result.listingNote = String(listing.listingNote).slice(0, 200);
    } catch (error) {
      noteError(error);
      result.failed = true;
      result.error = String((error as Error)?.message || error).slice(0, 300);
      return result;
    }
    result.videosListed = listed.length;
    for (const video of listed.slice(0, maxVideos)) {
      result.videosAttempted += 1;
      try {
        const fetched = await timed('fetchVideoDescription', () => session.fetchVideoDescription(video.id));
        if (fetched && typeof fetched.description === 'string') {
          if (fetched.description.trim()) result.descriptionsRecovered += 1;
          else result.notFound += 1;
        } else if (fetched === null) {
          result.notFound += 1;
        } else {
          result.parseFailures += 1;
        }
      } catch (error) {
        noteError(error);
      }
    }
    return result;
  } finally {
    const ordered = [...callLatencies].sort((a, b) => a - b);
    result.latencyMs = {
      totalMs: Math.max(0, now() - startedAt),
      perCallP50Ms: percentile(ordered, 0.5),
      perCallMaxMs: ordered.length ? ordered[ordered.length - 1] : 0,
    };
    result.callsPerDescription = result.descriptionsRecovered > 0
      ? Math.round((result.calls / result.descriptionsRecovered) * 100) / 100
      : null;
  }
}
