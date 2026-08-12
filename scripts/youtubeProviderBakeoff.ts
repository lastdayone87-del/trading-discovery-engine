import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { evaluateProviderShadowCandidate, summarizeProviderShadowQuality, type ProviderShadowCandidateQuality } from '../server/youtubeProviderShadowQuality';

type ProviderName = 'YOUTUBE_DATA_API' | 'YOUTUBE_JS' | 'YOUTUBE_JS_MONTH' | 'YOUTUBE_JS_YEAR' | 'YOUTUBE_SEARCH_API';
type Candidate = { videoId?: string; channelId?: string; title?: string; channelTitle?: string; publishedAt?: string };
type Page = { candidates: Candidate[]; next?: unknown };
type Provider = { name: ProviderName; available(): boolean; search(query: string, page?: unknown): Promise<Page> };

const queries = [
  'day trading', 'stock trading', 'futures trading', 'options trading', 'forex trading', 'crypto trading',
  'DAX trading Deutschland', 'Börsenanalyse trading', 'Daytrading deutsch',
  'trading France analyse marché', 'trader français live',
  'trading España análisis', 'trading futuros español',
  'trading Italia analisi', 'trader italiano live',
  'trading Nederland analyse', 'daytrading Nederlands',
  'trading Schweiz Börse', 'trading Suisse analyse',
  'trading 日本 デイトレード', '株 トレード 解説',
  'trading Brasil análise', 'day trade Brasil',
  'trading México análisis', 'trader mexicano',
  'trading Canada stocks', 'trading Australia futures',
  'trading Singapore stocks', 'trading India intraday', 'trading South Africa forex'
];
const maxPages = Math.max(1, Math.min(3, Number(process.env.BAKEOFF_MAX_PAGES || 3)));
const selectedQueries = queries.slice(0, Math.max(1, Math.min(30, Number(process.env.BAKEOFF_QUERY_LIMIT || 30))));

function relativePublishedAt(value: unknown, nowMs = Date.now()): string | undefined {
  if (!value) return undefined;
  const raw = typeof value === 'string' ? value : (value as any)?.text || (value as any)?.simpleText || (value as any)?.toString?.();
  if (!raw || typeof raw !== 'string') return undefined;
  const direct = Date.parse(raw);
  if (Number.isFinite(direct)) return new Date(direct).toISOString();
  const text = raw.trim().toLowerCase();
  if (text === 'today') return new Date(nowMs).toISOString();
  if (text === 'yesterday') return new Date(nowMs - 86_400_000).toISOString();
  const match = text.match(/(?:streamed\s+|premiered\s+)?(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unitDays: Record<string, number> = { second: 1 / 86_400, minute: 1 / 1_440, hour: 1 / 24, day: 1, week: 7, month: 30.4375, year: 365.25 };
  return new Date(nowMs - amount * unitDays[match[2]] * 86_400_000).toISOString();
}

function textValue(value: any): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  const text = value?.text || value?.simpleText || value?.runs?.map((r: any) => r?.text).filter(Boolean).join('');
  return typeof text === 'string' && text.trim() ? text.trim() : undefined;
}

function firstString(...values: any[]): string | undefined {
  for (const value of values) {
    const text = textValue(value);
    if (text) return text;
  }
  return undefined;
}

function youtubeSearchApiCandidate(x: any): Candidate {
  const channel = x?.channel || x?.author || x?.owner || x?.shortBylineText;
  return {
    videoId: firstString(x?.id, x?.videoId),
    channelId: firstString(
      x?.channelId,
      channel?.id,
      channel?.channelId,
      x?.authorId,
      x?.ownerChannelId,
      x?.shortBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId
    ),
    title: firstString(x?.title),
    channelTitle: firstString(
      x?.channelTitle,
      channel?.title,
      channel?.name,
      x?.channel,
      x?.author,
      x?.shortBylineText,
      x?.shortBylineText?.runs?.[0]?.text
    ),
    publishedAt: relativePublishedAt(
      x?.publishedAt || x?.publishedTime || x?.publishTime || x?.published || x?.publishedText || x?.metadata?.publishedAt
    )
  };
}

function dataApiProvider(): Provider {
  const key = process.env.YOUTUBE_API_KEY || '';
  return {
    name: 'YOUTUBE_DATA_API', available: () => Boolean(key),
    async search(query, page) {
      const u = new URL('https://www.googleapis.com/youtube/v3/search');
      u.searchParams.set('part', 'snippet'); u.searchParams.set('type', 'video'); u.searchParams.set('maxResults', '50');
      u.searchParams.set('q', query); u.searchParams.set('key', key);
      if (page) u.searchParams.set('pageToken', String(page));
      const r = await fetch(u); if (!r.ok) throw new Error(`Data API ${r.status}`); const j: any = await r.json();
      return { candidates: (j.items || []).map((x: any) => ({ videoId: x.id?.videoId, channelId: x.snippet?.channelId, title: x.snippet?.title, channelTitle: x.snippet?.channelTitle, publishedAt: x.snippet?.publishedAt })), next: j.nextPageToken };
    }
  };
}

function youtubeJsProvider(name: 'YOUTUBE_JS' | 'YOUTUBE_JS_MONTH' | 'YOUTUBE_JS_YEAR', uploadDate?: 'month' | 'year'): Provider {
  let clientPromise: Promise<any> | null = null;
  const getClient = async () => {
    if (!clientPromise) clientPromise = import('youtubei.js').then(async (mod: any) => mod.Innertube.create());
    return clientPromise;
  };
  return {
    name, available: () => true,
    async search(query, page) {
      const yt = await getClient();
      const result: any = page ? await (page as any).getContinuation() : await yt.search(query, { type: 'video', ...(uploadDate ? { upload_date: uploadDate } : {}) });
      const items = result.videos || result.results || [];
      const candidates = items.map((x: any) => ({
        videoId: x.id,
        channelId: x.author?.id,
        title: x.title?.text || x.title?.toString?.(),
        channelTitle: x.author?.name,
        publishedAt: relativePublishedAt(x.published)
      }));
      return { candidates, next: result.has_continuation ? result : undefined };
    }
  };
}

function youtubeSearchApiProvider(): Provider {
  return {
    name: 'YOUTUBE_SEARCH_API', available: () => true,
    async search(query, page) {
      const mod: any = await import('youtube-search-api'); const api = mod.default || mod;
      const j: any = page ? await api.NextPage(page, false, 50) : await api.GetListByKeyword(query, false, 50, [{ type: 'video' }]);
      const rawItems = (j.items || []).filter((x: any) => x.type === 'video');
      const candidates = rawItems.map(youtubeSearchApiCandidate);
      const missingChannelIds = candidates.reduce((n: number, c: Candidate) => n + (c.channelId ? 0 : 1), 0);
      if (process.env.BAKEOFF_DEBUG_PROVIDER_SHAPES === '1' && rawItems.length && missingChannelIds) {
        console.log(JSON.stringify({ provider: 'YOUTUBE_SEARCH_API', query, missingChannelIds, itemKeys: Object.keys(rawItems[0] || {}), sample: rawItems[0] }, null, 2));
      }
      return { candidates, next: j.nextPage };
    }
  };
}

const providers: Provider[] = [
  dataApiProvider(),
  youtubeJsProvider('YOUTUBE_JS'),
  youtubeJsProvider('YOUTUBE_JS_MONTH', 'month'),
  youtubeJsProvider('YOUTUBE_JS_YEAR', 'year'),
  youtubeSearchApiProvider()
];
const rows: any[] = [];
for (const provider of providers) {
  if (!provider.available()) { rows.push({ provider: provider.name, skipped: true, reason: 'missing credentials' }); continue; }
  for (const query of selectedQueries) {
    let next: unknown; const seen = new Set<string>(); let pages = 0; let failures = 0; const started = performance.now();
    const qualityItems: ProviderShadowCandidateQuality[] = [];
    for (let p = 0; p < maxPages; p++) {
      try {
        const page = await provider.search(query, next); pages++;
        for (const c of page.candidates) {
          if (c.channelId) seen.add(c.channelId);
          qualityItems.push(evaluateProviderShadowCandidate(c));
        }
        next = page.next; if (!next) break;
      } catch (e) { failures++; rows.push({ provider: provider.name, query, error: e instanceof Error ? e.message : String(e) }); break; }
    }
    rows.push({
      provider: provider.name,
      query,
      pages,
      uniqueChannels: seen.size,
      failures,
      latencyMs: Math.round(performance.now() - started),
      shadowQuality: summarizeProviderShadowQuality(qualityItems)
    });
  }
}
const summary = providers.map(p => {
  const r = rows.filter(x => x.provider === p.name && x.query && !x.error);
  const q = r.map(x => x.shadowQuality).filter(Boolean);
  const candidates = q.reduce((a, x) => a + x.candidatesEvaluated, 0);
  const plausible = q.reduce((a, x) => a + x.plausibleTradingCandidates, 0);
  const knownFreshness = q.reduce((a, x) => a + x.knownFreshnessCandidates, 0);
  const recent90d = q.reduce((a, x) => a + x.recent90d, 0);
  return {
    provider: p.name,
    queries: r.length,
    pages: r.reduce((a, x) => a + (x.pages || 0), 0),
    uniqueChannelYieldSum: r.reduce((a, x) => a + (x.uniqueChannels || 0), 0),
    failures: rows.filter(x => x.provider === p.name && x.error).length + r.reduce((a, x) => a + (x.failures || 0), 0),
    avgLatencyMs: r.length ? Math.round(r.reduce((a, x) => a + (x.latencyMs || 0), 0) / r.length) : null,
    candidatesEvaluated: candidates,
    plausibleTradingCandidates: plausible,
    plausibleTradingRate: candidates ? Math.round(plausible / candidates * 10_000) / 10_000 : null,
    knownFreshnessCandidates: knownFreshness,
    recent90dCandidates: recent90d,
    recent90dRateAmongKnown: knownFreshness ? Math.round(recent90d / knownFreshness * 10_000) / 10_000 : null,
    staleOver730d: q.reduce((a, x) => a + x.staleOver730d, 0),
    unknownFreshness: q.reduce((a, x) => a + x.unknownFreshness, 0),
    productionConfirmationMeasured: false,
    productionWrites: false
  };
});
const report = {
  shadowMode: true,
  productionWrites: false,
  productionConfirmationMeasured: false,
  qualitySemantics: 'Uses the production autonomous retrieval firewall and matched-video freshness only. It does not classify search hits as TRADING_CONFIRMED; creator-level enrichment is required for that.',
  queryCount: selectedQueries.length,
  maxPages,
  generatedAt: new Date().toISOString(),
  summary,
  rows
};
await writeFile(process.env.BAKEOFF_OUTPUT || 'youtube-provider-bakeoff.json', JSON.stringify(report, null, 2));
console.table(summary);
console.log('Shadow-mode only: no candidates were written to the production pipeline and no search hit was treated as production-confirmed.');
