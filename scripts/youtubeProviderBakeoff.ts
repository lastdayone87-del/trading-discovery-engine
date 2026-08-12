import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

type ProviderName = 'YOUTUBE_DATA_API' | 'YOUTUBE_JS' | 'YOUTUBE_SEARCH_API';
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

function youtubeJsProvider(): Provider {
  return {
    name: 'YOUTUBE_JS', available: () => true,
    async search(query, page) {
      const mod: any = await import('youtubei.js');
      const yt = await mod.Innertube.create();
      const result: any = page ? await (page as any).getContinuation() : await yt.search(query, { type: 'video' });
      const items = result.videos || result.results || [];
      const candidates = items.map((x: any) => ({ videoId: x.id, channelId: x.author?.id, title: x.title?.text || x.title?.toString?.(), channelTitle: x.author?.name, publishedAt: x.published?.text || x.published?.toString?.() }));
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
      return { candidates: (j.items || []).filter((x: any) => x.type === 'video').map((x: any) => ({ videoId: x.id, channelId: x.channelId, title: x.title, channelTitle: x.channelTitle })), next: j.nextPage };
    }
  };
}

const providers: Provider[] = [dataApiProvider(), youtubeJsProvider(), youtubeSearchApiProvider()];
const rows: any[] = [];
for (const provider of providers) {
  if (!provider.available()) { rows.push({ provider: provider.name, skipped: true, reason: 'missing credentials' }); continue; }
  for (const query of selectedQueries) {
    let next: unknown; const seen = new Set<string>(); let pages = 0; let failures = 0; const started = performance.now();
    for (let p = 0; p < maxPages; p++) {
      try {
        const page = await provider.search(query, next); pages++;
        for (const c of page.candidates) if (c.channelId) seen.add(c.channelId);
        next = page.next; if (!next) break;
      } catch (e) { failures++; rows.push({ provider: provider.name, query, error: e instanceof Error ? e.message : String(e) }); break; }
    }
    rows.push({ provider: provider.name, query, pages, uniqueChannels: seen.size, failures, latencyMs: Math.round(performance.now() - started) });
  }
}
const summary = providers.map(p => {
  const r = rows.filter(x => x.provider === p.name && x.query);
  return { provider: p.name, queries: r.length, pages: r.reduce((a, x) => a + (x.pages || 0), 0), uniqueChannelYieldSum: r.reduce((a, x) => a + (x.uniqueChannels || 0), 0), failures: r.reduce((a, x) => a + (x.failures || 0), 0), avgLatencyMs: r.length ? Math.round(r.reduce((a, x) => a + (x.latencyMs || 0), 0) / r.length) : null };
});
const report = { shadowMode: true, productionWrites: false, queryCount: selectedQueries.length, maxPages, generatedAt: new Date().toISOString(), summary, rows };
await writeFile(process.env.BAKEOFF_OUTPUT || 'youtube-provider-bakeoff.json', JSON.stringify(report, null, 2));
console.table(summary);
console.log('Shadow-mode only: no candidates were written to the production pipeline.');
