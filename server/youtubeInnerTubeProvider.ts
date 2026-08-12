import type { DiscoveredChannelRaw } from './youtube';

export type InnerTubeDiscoveryLane = 'MONTH' | 'YEAR' | 'DEFAULT';

export interface InnerTubeProviderHealth {
  provider: 'YOUTUBE_JS';
  lane: InnerTubeDiscoveryLane;
  requests: number;
  failures: number;
  candidates: number;
  uniqueChannels: number;
  lastLatencyMs: number | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  coolingDownUntil: string | null;
}

export interface InnerTubeDiscoveryResult {
  provider: 'YOUTUBE_JS';
  lane: InnerTubeDiscoveryLane;
  query: string;
  pagesFetched: number;
  channels: DiscoveredChannelRaw[];
  exhausted: boolean;
  health: InnerTubeProviderHealth;
}

export interface InnerTubeDiscoveryOptions {
  lane?: InnerTubeDiscoveryLane;
  maxPages?: number;
  maxChannels?: number;
  timeoutMs?: number;
}

type SearchPage = {
  results?: any[];
  videos?: any[];
  has_continuation?: boolean;
  getContinuation?: () => Promise<SearchPage>;
};

type InnerTubeClient = {
  search(query: string, options: Record<string, unknown>): Promise<SearchPage>;
};

let clientPromise: Promise<InnerTubeClient> | null = null;
const healthByLane = new Map<InnerTubeDiscoveryLane, InnerTubeProviderHealth>();

function initialHealth(lane: InnerTubeDiscoveryLane): InnerTubeProviderHealth {
  return {
    provider: 'YOUTUBE_JS', lane, requests: 0, failures: 0, candidates: 0,
    uniqueChannels: 0, lastLatencyMs: null, lastSuccessAt: null,
    lastFailureAt: null, coolingDownUntil: null
  };
}

function health(lane: InnerTubeDiscoveryLane): InnerTubeProviderHealth {
  if (!healthByLane.has(lane)) healthByLane.set(lane, initialHealth(lane));
  return healthByLane.get(lane)!;
}

function updateHealth(lane: InnerTubeDiscoveryLane, patch: Partial<InnerTubeProviderHealth>): void {
  healthByLane.set(lane, { ...health(lane), ...patch });
}

export function getInnerTubeProviderHealth(): InnerTubeProviderHealth[] {
  return (['MONTH', 'YEAR', 'DEFAULT'] as InnerTubeDiscoveryLane[]).map(lane => ({ ...health(lane) }));
}

export function resetInnerTubeProviderHealthForTests(): void {
  healthByLane.clear();
}

async function getClient(): Promise<InnerTubeClient> {
  if (!clientPromise) {
    clientPromise = import('youtubei.js').then(async (mod: any) => mod.Innertube.create());
  }
  return clientPromise;
}

function searchOptions(lane: InnerTubeDiscoveryLane): Record<string, unknown> {
  if (lane === 'MONTH') return { type: 'video', upload_date: 'month' };
  if (lane === 'YEAR') return { type: 'video', upload_date: 'year' };
  return { type: 'video' };
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

function toCandidate(item: any): DiscoveredChannelRaw | null {
  const channelId = textValue(item?.author?.id || item?.channel?.id || item?.channel_id);
  const channelName = textValue(item?.author?.name || item?.channel?.name || item?.author);
  const title = textValue(item?.title);
  if (!channelId || !channelName || !title) return null;
  const publishedAt = normalizePublishedAt(item?.published || item?.published_time || item?.metadata?.published);
  return {
    channelId,
    channelName,
    youtubeUrl: `https://www.youtube.com/channel/${channelId}`,
    description: '',
    videoTitles: [title],
    videoDescriptions: [],
    matchedDocument: {
      type: 'VIDEO',
      providerNativeId: textValue(item?.id) || undefined,
      title,
      publishedAt,
      locator: textValue(item?.id) ? `https://www.youtube.com/watch?v=${textValue(item.id)}` : undefined
    }
  };
}

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? Math.trunc(value!) : fallback));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('YOUTUBE_JS_TIMEOUT'), { code: 'YOUTUBE_JS_TIMEOUT' })), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function discoverWithInnerTube(
  query: string,
  options: InnerTubeDiscoveryOptions = {},
  injectedClient?: InnerTubeClient
): Promise<InnerTubeDiscoveryResult> {
  const lane = options.lane || 'MONTH';
  const maxPages = bounded(options.maxPages, 2, 1, 3);
  const maxChannels = bounded(options.maxChannels, 100, 1, 150);
  const timeoutMs = bounded(options.timeoutMs, 15_000, 1_000, 30_000);
  const state = health(lane);
  if (state.coolingDownUntil && Date.parse(state.coolingDownUntil) > Date.now()) {
    throw Object.assign(new Error('YOUTUBE_JS_COOLING_DOWN'), { retryAt: state.coolingDownUntil });
  }

  const started = Date.now();
  const seen = new Map<string, DiscoveredChannelRaw>();
  let pagesFetched = 0;
  let page: SearchPage | undefined;
  try {
    const client = injectedClient || await getClient();
    page = await withTimeout(client.search(query, searchOptions(lane)), timeoutMs);
    while (page && pagesFetched < maxPages && seen.size < maxChannels) {
      pagesFetched++;
      const items = page.videos || page.results || [];
      for (const item of items) {
        const candidate = toCandidate(item);
        if (candidate && !seen.has(candidate.channelId)) seen.set(candidate.channelId, candidate);
        if (seen.size >= maxChannels) break;
      }
      if (!page.has_continuation || !page.getContinuation || pagesFetched >= maxPages || seen.size >= maxChannels) break;
      page = await withTimeout(page.getContinuation(), timeoutMs);
    }
    const current = health(lane);
    updateHealth(lane, {
      requests: current.requests + pagesFetched,
      candidates: current.candidates + seen.size,
      uniqueChannels: current.uniqueChannels + seen.size,
      lastLatencyMs: Date.now() - started,
      lastSuccessAt: new Date().toISOString(),
      coolingDownUntil: null
    });
    return {
      provider: 'YOUTUBE_JS', lane, query, pagesFetched,
      channels: [...seen.values()],
      exhausted: !page?.has_continuation,
      health: { ...health(lane) }
    };
  } catch (error) {
    const current = health(lane);
    const cooldownMs = 60_000;
    updateHealth(lane, {
      failures: current.failures + 1,
      lastLatencyMs: Date.now() - started,
      lastFailureAt: new Date().toISOString(),
      coolingDownUntil: new Date(Date.now() + cooldownMs).toISOString()
    });
    throw error;
  }
}

export function chooseInnerTubeLane(input: { monthAttempts: number; monthUniqueYield: number; yearAttempts?: number }): InnerTubeDiscoveryLane {
  if (input.monthAttempts < 2) return 'MONTH';
  if (input.monthUniqueYield >= 5) return 'MONTH';
  if ((input.yearAttempts || 0) < 2) return 'YEAR';
  return 'DEFAULT';
}
