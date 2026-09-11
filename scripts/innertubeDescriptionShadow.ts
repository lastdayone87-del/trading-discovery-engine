/**
 * Live shadow-measurement runner: youtubei.js video-description recovery.
 *
 * Shadow-only: reads an explicit channel list, calls public YouTube metadata
 * endpoints through a local youtubei.js session, and writes a telemetry JSON
 * report. No database access, no queue interaction, no enrichment decisions,
 * no retry scheduling, no provider-priority changes, no browser/Playwright.
 *
 * Input JSONL lines: {"id": "<channelId>", "priorFailure": "<class|UNKNOWN>"}.
 *
 * Usage: tsx scripts/innertubeDescriptionShadow.ts --channels UCxx,UCyy [--limit 20]
 *        tsx scripts/innertubeDescriptionShadow.ts --cases cases.jsonl [--out report.json]
 *        [--interval-ms 1500] [--max-videos 10] [--timeout-ms 30000]
 */
import fs from 'node:fs/promises';
import { Innertube } from 'youtubei.js';
import {
  collectChannelVideoDescriptions,
  type InnertubeShadowResult,
  type InnertubeShadowSession,
} from '../server/youtubeInnertubeDescriptions.js';

const args = new Map(
  process.argv.slice(2).flatMap((arg, i, all) => (arg.startsWith('--') ? [[arg.slice(2), all[i + 1] ?? '']] : [])),
);
const channelsArg = args.get('channels') || '';
const casesPath = args.get('cases') || '';
const outPath = args.get('out') || 'benchmark/results/innertube-descriptions.json';
const intervalMs = Math.max(0, Math.floor(Number(args.get('interval-ms') ?? '1500')) || 0);
const maxVideos = Math.min(25, Math.max(1, Math.floor(Number(args.get('max-videos') ?? '10')) || 10));
const timeoutMs = Math.max(1000, Math.floor(Number(args.get('timeout-ms') ?? '30000')) || 30000);
const limit = Math.max(0, Math.floor(Number(args.get('limit') ?? '20')) || 0);

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const text = (value as { text?: unknown }).text;
    if (typeof text === 'string') return text;
  }
  return '';
}

async function main(): Promise<void> {
  let cases: Array<{ id: string; priorFailure?: string }> = [];
  if (channelsArg) {
    cases = channelsArg.split(',').map(id => id.trim()).filter(Boolean).map(id => ({ id }));
  } else if (casesPath) {
    try {
      const raw = await fs.readFile(casesPath, 'utf8');
      cases = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => JSON.parse(line));
    } catch {
      console.error(JSON.stringify({ status: 'BLOCKED', reason: `Cases file not readable: ${casesPath}.` }));
      process.exit(2);
    }
  } else {
    console.error(JSON.stringify({ status: 'BLOCKED', reason: 'Missing --channels <ids> or --cases <cases.jsonl>.' }));
    process.exit(2);
  }
  if (!cases.length) {
    console.error(JSON.stringify({ status: 'BLOCKED', reason: 'No cases provided.' }));
    process.exit(2);
  }
  const selected = (limit > 0 ? cases.slice(0, limit) : cases).filter(c => typeof c?.id === 'string' && c.id);
  if (!selected.length) {
    console.error(JSON.stringify({ status: 'BLOCKED', reason: 'No valid channel ids.' }));
    process.exit(2);
  }

  let session: Awaited<ReturnType<typeof Innertube.create>>;
  let sessionInvalidations = 0;
  try {
    session = await Innertube.create();
  } catch (error) {
    console.error(JSON.stringify({ status: 'BLOCKED', reason: `Innertube session failed: ${String((error as Error)?.message || error).slice(0, 200)}` }));
    process.exit(2);
  }
  const adapter: InnertubeShadowSession = {
    listChannelVideos: async channelId => {
      const channel = await session.getChannel(channelId);
      let tab: unknown;
      try {
        tab = await channel.getVideos();
      } catch (error) {
        if (/tab|videos/i.test(String((error as Error)?.message || ''))) {
          return { videos: [], listingNote: 'NO_VIDEOS_TAB' };
        }
        throw error;
      }
      const raw = (tab as { videos?: unknown }).videos;
      if (!Array.isArray(raw)) return { videos: [], listingNote: 'LISTING_SHAPE_UNRECOGNIZED' };
      return {
        videos: raw
          .map((node: any) => ({ id: String(node?.content_id || node?.id || ''), title: textOf(node?.metadata?.title).slice(0, 120) }))
          .filter(video => video.id),
      };
    },
    fetchVideoDescription: async videoId => {
      const info: any = await session.getBasicInfo(videoId);
      const description = String(info?.basic_info?.short_description || '');
      return description.trim() ? { description } : null;
    },
    onSessionError: () => {
      sessionInvalidations += 1;
    },
  };
  console.error(JSON.stringify({ status: 'RUNNING', channels: selected.length, interval_ms: intervalMs, max_videos: maxVideos }));
  const results: InnertubeShadowResult[] = [];
  for (const [index, value] of selected.entries()) {
    if (index > 0 && intervalMs > 0) await new Promise(resolve => setTimeout(resolve, intervalMs));
    try {
      results.push(await collectChannelVideoDescriptions(adapter, value.id, { maxVideos, intervalMs, timeoutMs }));
    } catch (error) {
      results.push({
        channelId: value.id, videosListed: 0, videosAttempted: 0, descriptionsRecovered: 0,
        calls: 0, callsPerDescription: null,
        latencyMs: { totalMs: 0, perCallP50Ms: 0, perCallMaxMs: 0 },
        rateLimited: 0, sessionErrors: 0, timeouts: 0, notFound: 0, parseFailures: 0,
        failed: true, error: String((error as Error)?.message || error).slice(0, 300),
      });
    }
    (results[results.length - 1] as InnertubeShadowResult & { priorFailure?: string }).priorFailure = value.priorFailure || 'UNKNOWN';
  }
  const sum = (pick: (row: InnertubeShadowResult) => number) => results.reduce((total, row) => total + pick(row), 0);
  const byPrior: Record<string, { channels: number; recovered: number }> = {};
  for (const row of results as Array<InnertubeShadowResult & { priorFailure?: string }>) {
    const key = row.priorFailure || 'UNKNOWN';
    byPrior[key] = byPrior[key] || { channels: 0, recovered: 0 };
    byPrior[key].channels += 1;
    byPrior[key].recovered += row.descriptionsRecovered;
  }
  const report = {
    status: 'COMPLETED',
    generatedAt: new Date().toISOString(),
    channels: results.length,
    channelRecoveryRate: results.filter(row => row.descriptionsRecovered > 0).length / Math.max(1, results.length),
    descriptionsRecovered: sum(row => row.descriptionsRecovered),
    videosListed: sum(row => row.videosListed),
    videosAttempted: sum(row => row.videosAttempted),
    calls: sum(row => row.calls),
    callsPerDescription: sum(row => row.descriptionsRecovered) > 0
      ? Math.round((sum(row => row.calls) / sum(row => row.descriptionsRecovered)) * 100) / 100
      : null,
    rateLimited: sum(row => row.rateLimited),
    sessionInvalidations,
    timeouts: sum(row => row.timeouts),
    notFound: sum(row => row.notFound),
    parseFailures: sum(row => row.parseFailures),
    failedChannels: results.filter(row => row.failed).length,
    byPriorFailure: byPrior,
    cases: results,
  };
  await fs.mkdir(outPath.split('/').slice(0, -1).join('/') || '.', { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, cases: undefined }, null, 2));
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'ERROR', error: String(error instanceof Error ? error.message : error).slice(0, 500) }));
  process.exit(1);
});
