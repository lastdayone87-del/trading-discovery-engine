import { ChannelActivityBand, CountryMetadataStatus, CountryVocabulary } from '../src/types';
import { incrementQuota, getAppSetting, getYouTubeKeyPool, appendProviderCallEvent } from './db';
import { executeProviderCall } from './providerResilience';
import { RetrievalLane } from './retrievalLanes';
import { SearchOrdering, youtubeOrder } from './searchOrdering';
import { isQuotaExceeded, youtubePoolBackoff, type YouTubePoolAcquisition } from './youtubePoolBackoff';
import { recordExecutionStage, recordFirstYouTubeRequest } from './executionTrace';
import { youtubeRequestScheduler } from './youtubeRequestScheduler';
import { youtubeProviderCooldown, YouTubeProvidersCoolingDownError } from './youtubeProviderCooldown';
export type { SearchOrdering } from './searchOrdering';
export type { RetrievalLane } from './retrievalLanes';

/**
 * STRICT BANNED KEYWORD SANITIZER
 * Strips any occurrence of 'discord' or related forbidden search keywords.
 */
const BARE_GEOGRAPHIC_TERMS = [
  'netherlands', 'amsterdam', 'holland', 'italy', 'rome', 'milan', 'south africa',
  'united kingdom', 'london', 'germany', 'berlin', 'france', 'paris', 'spain', 'madrid',
  'australia', 'sydney', 'canada', 'toronto', 'united states'
];

export function sanitizeSearchQuery(query: string, defaultCountry = ''): string {
  let cleaned = query.replace(/discord/gi, '').trim();
  cleaned = cleaned.replace(/\s+/g, ' ');

  // If query is purely a geographic term or empty, anchor it with trading terms
  const lower = cleaned.toLowerCase();
  if (BARE_GEOGRAPHIC_TERMS.includes(lower)) {
    cleaned = `${cleaned} trading marktanalyse`;
  } else if (cleaned.length < 3) {
    cleaned = defaultCountry ? `${defaultCountry} trading analysis` : 'trading market structure';
  }

  return cleaned;
}

/**
 * Generates country-specific trading search queries using real native terminology.
 */
export function generateCountryQueries(vocab: CountryVocabulary, count = 5): string[] {
  const queries: string[] = [];

  const terms = vocab.native_trading_terminology || [];
  const instruments = vocab.popular_instruments || [];
  const formats = vocab.common_content_format_names || [];
  const phrases = vocab.local_market_phrases || [];

  // Combine terms with instruments or content formats
  for (let i = 0; i < count; i++) {
    const term = terms[i % terms.length] || 'trading';
    const inst = instruments[i % instruments.length] || '';
    const fmt = formats[i % formats.length] || '';
    const phrase = phrases[i % phrases.length] || '';

    let q = '';
    if (i % 3 === 0) q = `${term} ${fmt}`.trim();
    else if (i % 3 === 1) q = `${inst} ${term}`.trim();
    else q = `${phrase} ${term}`.trim();

    const sanitized = sanitizeSearchQuery(q);
    if (sanitized && !queries.includes(sanitized)) {
      queries.push(sanitized);
    }
  }

  return queries;
}

export interface DiscoveredChannelRaw {
  channelId: string;
  channelName: string;
  youtubeUrl: string;
  description: string;
  videoTitles: string[];
  locationTag?: string;
  channelLinks?: string[];
  pinnedComment?: string;
  videoDescriptions?: string[];
  subscriberCount?: string;
  channelThumbnailUrl?: string;
  countryMetadataStatus?: CountryMetadataStatus;
  countryMetadataCheckedAt?: string;
  uploadTimestamps?: string[];
  latestUploadAt?: string;
  uploadsLast30Days?: number;
  uploadsLast90Days?: number;
  uploadsLast365Days?: number;
  activityBand?: ChannelActivityBand;
  activityScore?: number;
  activityObservedAt?: string;
}
export interface PlaylistChannelObservation {channelId:string;channelName:string;description:string;videoTitles:string[];observedAt:string}

/** One bounded playlistItems call (cost: one unit); no pagination is followed by the canary. */
export async function fetchYouTubePlaylistChannels(playlistId:string,limit:number):Promise<PlaylistChannelObservation[]> {
  const keys=getYouTubeKeyPool();if(!keys.length)throw new Error('YouTube playlist inspection requires an API key.');
  const acquisition=youtubePoolBackoff.beginAcquisition(); let quotaExceededCount=0;
  const maxResults=Math.min(50,Math.max(1,Math.trunc(limit)));const observedAt=new Date().toISOString();
  try {
    const providerIndexes=availableKeyIndexes(keys);
    for(let attempt=0;attempt<providerIndexes.length;attempt++){const index=providerIndexes[attempt];
      try{const url=buildYouTubeApiUrl('playlistItems',keys[index],{part:'snippet',playlistId,maxResults});const response=await youtubeFetch(url,'playlist-items',1,attempt+1,acquisition);const data=await response.json();await incrementQuota(1);activeKeyIndex=index;
        return (data.items||[]).map((item:any)=>({channelId:String(item.snippet?.videoOwnerChannelId||''),channelName:String(item.snippet?.videoOwnerChannelTitle||''),description:String(item.snippet?.description||''),videoTitles:[String(item.snippet?.title||'')],observedAt})).filter((x:PlaylistChannelObservation)=>x.channelId&&x.channelName);
      }catch(error){recordProviderFailure(keys[index],error);if(isQuotaExceeded(error))quotaExceededCount++;if(attempt===providerIndexes.length-1){acquisition.providerFailed(quotaExceededCount===providerIndexes.length?'QUOTA_EXHAUSTED':'INDETERMINATE');throw error;}}
    }throw new Error('All configured YouTube API keys failed for playlist inspection.');
  } finally { acquisition.release(); }
}

/**
 * Retrieves all valid YouTube API keys available in environment variables.
 * Checks YOUTUBE_API_KEY and YOUTUBE_API_KEY_1..5.
 */
let activeKeyIndex = 0;
let outboundTraceSequence = 0;

function availableKeyIndexes(keys: string[]): number[] {
  const indexes = keys.map((_key, index) => (activeKeyIndex + index) % keys.length)
    .filter(index => youtubeProviderCooldown.eligible(keys[index]));
  if (indexes.length) return indexes;
  const retryAt = Math.min(...keys.map(key => youtubeProviderCooldown.retryAt(key)).filter(Boolean));
  throw new YouTubeProvidersCoolingDownError(retryAt);
}

function recordProviderFailure(key: string, error: unknown): void {
  if (isQuotaExceeded(error)) youtubeProviderCooldown.failed(key, 'DAILY_QUOTA_EXHAUSTED');
  else if (isYouTubeRateLimited(error)) youtubeProviderCooldown.failed(key, 'RATE_LIMITED');
}

const YOUTUBE_API_ROOT = 'https://youtube.googleapis.com/youtube/v3';

/**
 * Build a canonical YouTube Data API request without hand-concatenating query
 * parameters.
 */
export function buildYouTubeApiUrl(
  resource: 'search' | 'videos' | 'channels' | 'playlistItems',
  apiKey: string,
  parameters: Record<string, string | number | undefined>
): string {
  const url = new URL(`${YOUTUBE_API_ROOT}/${resource}`);
  for (const [name, value] of Object.entries(parameters)) {
    if (value !== undefined) url.searchParams.set(name, String(value));
  }
  url.searchParams.set('prettyPrint', 'false');
  url.searchParams.set('key', apiKey);
  return url.toString();
}

async function youtubeFetch(url:string,operation:string,actualCost:number,attempt=1,acquisition?:YouTubePoolAcquisition):Promise<Response>{
  const traceId = `${operation}-${attempt}-${++outboundTraceSequence}`;
  const trace = (stage: string) => console.log(`[YouTube Outbound Trace] ${traceId} ${stage}`);
  trace('entered youtubeFetch; before timeout-setting-read at server/youtube.ts:119');
  const configuredTimeout=Number(await getAppSetting('youtube_provider_timeout_ms',process.env.YOUTUBE_PROVIDER_TIMEOUT_MS||'30000'));
  trace('after timeout-setting-read at server/youtube.ts:119');
  const timeout=Number.isFinite(configuredTimeout)&&configuredTimeout>0?configuredTimeout:30_000;
  // A scheduler can only advance once its head call settles. YouTube requests
  // therefore always need a deadline; the general provider feature flag must
  // not be allowed to leave this process-wide request lane blocked forever.
  trace('before scheduler-run at server/youtube.ts:126');
  return youtubeRequestScheduler.run(()=>executeProviderCall({context:{provider:'youtube',operation,attempt,reservedCost:actualCost,actualCost},timeoutMs:timeout,enabled:true,emit:appendProviderCallEvent,trace,call:async signal=>{
    trace('before first-request-record at server/youtube.ts:128');
    await recordFirstYouTubeRequest(operation);
    trace('after first-request-record at server/youtube.ts:128');
    trace('before HTTP fetch at server/youtube.ts:131');
    const response=await fetch(url,{signal});
    trace(`after HTTP fetch at server/youtube.ts:131 (status=${response.status})`);
    if(!response.ok){
      trace('before HTTP-error-body-read at server/youtube.ts:135');
      const error=await youtubeHttpError(response,trace);
      trace('after HTTP-error-body-read at server/youtube.ts:135');
      throw error;
    }
    acquisition?.providerSucceeded();return response;
  }}), trace);
}

/** Preserve both legacy and google.rpc ErrorInfo reasons for actionable runtime diagnostics. */
export async function youtubeHttpError(response:Response,trace?:(stage:string)=>void):Promise<Error>{
  trace?.('before response-body-json-read at server/youtube.ts:147');
  const body=await response.clone().json().catch(()=>null) as any;
  trace?.('after response-body-json-read at server/youtube.ts:147');
  const legacy=(body?.error?.errors||[]).map((item:any)=>item?.reason);
  const detailed=(body?.error?.details||[]).map((item:any)=>item?.reason);
  const providerReasons=Array.from(new Set([...legacy,...detailed].filter((reason):reason is string=>typeof reason==='string'&&reason.length>0)));
  const quotaExceeded=providerReasons.some(reason=>/^(quotaExceeded|dailyLimitExceeded)$/i.test(reason));
  const providerStatus=typeof body?.error?.status==='string'?body.error.status:'';
  return Object.assign(new Error(`YouTube HTTP ${response.status}${providerStatus?` ${providerStatus}`:''}${providerReasons.length?` (${providerReasons.join(', ')})`:''}`),{status:response.status,quotaExceeded,providerReasons});
}

/** A request-rate limit is common to this runtime; changing project keys cannot clear it. */
export function isYouTubeRateLimited(error: unknown): boolean {
  let current: any = error;
  for (let depth = 0; current && depth < 5; depth++, current = current.cause) {
    if (current.quotaExceeded === true) return false;
    if (current.status === 429 || current.providerReasons?.some((reason: unknown) => /^rateLimitExceeded$/i.test(String(reason)))) return true;
  }
  return false;
}

export function extractDiscoveredChannels(items: any[], lane: RetrievalLane, sanitizedQuery: string): DiscoveredChannelRaw[] {
  const results = new Map<string, DiscoveredChannelRaw>();
  for (const item of items) {
    const channelId = lane === 'VIDEO' ? item.snippet?.channelId : (item.id?.channelId || item.snippet?.channelId);
    const channelName = item.snippet?.channelTitle || item.snippet?.title;
    const thumb = item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url;
    if (!channelId || !channelName) continue;
    const existing = results.get(channelId);
    const videoTitle = lane === 'VIDEO' ? item.snippet?.title : undefined;
    const videoDescription = lane === 'VIDEO' ? item.snippet?.description : undefined;
    if (existing) {
      if (videoTitle && !existing.videoTitles.includes(videoTitle)) existing.videoTitles.push(videoTitle);
      if (videoDescription && !existing.videoDescriptions?.includes(videoDescription)) existing.videoDescriptions?.push(videoDescription);
      continue;
    }
    results.set(channelId, {
      channelId,
      channelName,
      youtubeUrl: `https://www.youtube.com/channel/${channelId}`,
      description: item.snippet?.description || '',
      videoTitles: videoTitle ? [videoTitle] : [sanitizedQuery],
      videoDescriptions: videoDescription ? [videoDescription] : [],
      locationTag: item.snippet?.country || undefined,
      channelLinks: [],
      channelThumbnailUrl: thumb
    });
  }
  return [...results.values()];
}

/**
 * Searches real YouTube channels using API key rotation and fails explicitly
 * when no key can serve the request; production discovery never synthesizes results.
 */
export async function searchYouTubeChannels(
  query: string,
  countryName: string,
  vocab?: CountryVocabulary,
  lane: RetrievalLane = 'VIDEO',
  ordering: SearchOrdering = 'RELEVANCE'
): Promise<DiscoveredChannelRaw[]> {
  return (await searchYouTubeChannelPage(query, countryName, vocab, lane, null, ordering)).channels;
}

export interface YouTubeChannelPage {
  channels: DiscoveredChannelRaw[];
  nextPageToken: string | null;
  rawResultCount: number;
}

/** Fetch one explicit result page so durable callers can resume without replaying pages. */
export async function searchYouTubeChannelPage(
  query: string,
  countryName: string,
  vocab?: CountryVocabulary,
  lane: RetrievalLane = 'VIDEO',
  pageToken?: string | null,
  ordering: SearchOrdering = 'RELEVANCE'
): Promise<YouTubeChannelPage> {
  const sanitizedQuery = sanitizeSearchQuery(query, countryName);
  if (!sanitizedQuery) return { channels: [], nextPageToken: null, rawResultCount: 0 };

  const keyPool = getYouTubeKeyPool();
  const configuredMaxResults = Number(await getAppSetting('youtube_discovery_max_results', process.env.YOUTUBE_DISCOVERY_MAX_RESULTS || '25'));
  const maxResults = Math.min(50, Math.max(10, Number.isFinite(configuredMaxResults) ? configuredMaxResults : 25));

  if (keyPool.length === 0) {
    throw new Error('YouTube discovery requires at least one configured YouTube API key.');
  }
  await recordExecutionStage('PROVIDER_ACQUISITION','REACHED',{provider:'youtube',configuredKeys:keyPool.length});
  const acquisition = youtubePoolBackoff.beginAcquisition();
  let quotaExceededCount = 0;

  try { if (keyPool.length > 0) {
    const providerIndexes = availableKeyIndexes(keyPool);
    for (let attempt = 0; attempt < providerIndexes.length; attempt++) {
      const currentIndex = providerIndexes[attempt];
      const apiKey = keyPool[currentIndex];

      try {
        console.log(`[YouTube API Pool] Attempting search with key #${currentIndex + 1}/${keyPool.length} (${apiKey.slice(0, 6)}...)...`);
        console.log(`[YouTube Outbound Trace] search attempt log returned; constructing request for key #${currentIndex + 1}, attempt ${attempt + 1}`);
        const searchType = lane === 'VIDEO' ? 'video' : 'channel';
        const searchUrl = buildYouTubeApiUrl('search', apiKey, {
          part: 'snippet', type: searchType, order: youtubeOrder(ordering),
          q: sanitizedQuery, maxResults, pageToken: pageToken || undefined
        });

        console.log(`[YouTube Outbound Trace] search-${attempt + 1} before youtubeFetch at server/youtube.ts:255`);
        const res = await youtubeFetch(searchUrl,'search',100,attempt+1,acquisition);
        console.log(`[YouTube Outbound Trace] search-${attempt + 1} after youtubeFetch at server/youtube.ts:255`);

        if (res.ok) {
          activeKeyIndex = currentIndex; // Pin working key as preferred
          console.log(`[YouTube Outbound Trace] search-${attempt + 1} before quota-write at server/youtube.ts:261`);
          await incrementQuota(100); // 100 units for YouTube Search call
          console.log(`[YouTube Outbound Trace] search-${attempt + 1} after quota-write at server/youtube.ts:261`);
          console.log(`[YouTube Outbound Trace] search-${attempt + 1} before success-body-read at server/youtube.ts:264`);
          const data = await res.json();
          console.log(`[YouTube Outbound Trace] search-${attempt + 1} after success-body-read at server/youtube.ts:264`);
          const results = extractDiscoveredChannels(data.items || [], lane, sanitizedQuery);

          console.log(`[YouTube API Pool] Key #${currentIndex + 1} succeeded. ${lane} lane discovered ${results.length} unique channels.`);
          // An empty successful response is authoritative. Retrying the same
          // query against every key would multiply quota cost without changing it.
          return { channels: results, nextPageToken: data.nextPageToken || null, rawResultCount: (data.items || []).length };
        }
      } catch (e) {
        recordProviderFailure(apiKey, e);
        if (isQuotaExceeded(e)) quotaExceededCount++;
        console.warn(`[YouTube API Pool] Key #${currentIndex + 1} fetch error:`, e);
      }
    }
    acquisition.providerFailed(quotaExceededCount === providerIndexes.length ? 'QUOTA_EXHAUSTED' : 'INDETERMINATE');
    console.warn('[YouTube API Pool] All API keys in pool encountered quotaExceeded or error or returned no results.');
  }

  throw new Error('All configured YouTube API keys failed for this discovery request.');
  } finally { acquisition.release(); }
}

/**
 * Fetches recent video titles and descriptions for a channel using YouTube Data API.
 * Rotates API key pool automatically.
 */
export async function fetchRecentVideoDescriptionsFromAPI(channelId: string): Promise<string[]> {
  const keyPool = getYouTubeKeyPool();
  if (keyPool.length === 0 || !channelId) return [];
  const acquisition = youtubePoolBackoff.beginAcquisition();
  let quotaExceededCount = 0;

  try { const providerIndexes=availableKeyIndexes(keyPool); for (let attempt = 0; attempt < providerIndexes.length; attempt++) {
    const currentIndex = providerIndexes[attempt];
    const apiKey = keyPool[currentIndex];

    try {
      const searchUrl = buildYouTubeApiUrl('search',apiKey,{part:'snippet',channelId,order:'date',type:'video',maxResults:5});
      const res = await youtubeFetch(searchUrl,'recent-videos-search',100,attempt+1,acquisition);

      if (res.ok) {
        activeKeyIndex = currentIndex;
        await incrementQuota(100);
        const data = await res.json();
        const videoIds: string[] = [];
        const snippets: string[] = [];

        for (const item of data.items || []) {
          const vId = item.id?.videoId;
          if (vId) videoIds.push(vId);
          if (item.snippet?.description) {
            snippets.push(item.snippet.description);
          }
        }

        if (videoIds.length > 0) {
          const videosUrl = buildYouTubeApiUrl('videos',apiKey,{part:'snippet',id:videoIds.join(',')});
          const vRes = await youtubeFetch(videosUrl,'video-details',1,1,acquisition);
          if (vRes.ok) {
            await incrementQuota(1);
            const vData = await vRes.json();
            const fullDescs: string[] = [];
            for (const item of vData.items || []) {
              if (item.snippet?.description) {
                fullDescs.push(item.snippet.description);
              }
            }
            if (fullDescs.length > 0) return fullDescs;
          }
        }

        if (snippets.length > 0) return snippets;
      }
    } catch (e) {
      recordProviderFailure(apiKey,e);
      if (isQuotaExceeded(e)) quotaExceededCount++;
      console.warn(`[YouTube API] Failed to fetch video descriptions for ${channelId}:`, e);
    }
  }

  acquisition.providerFailed(quotaExceededCount === keyPool.length ? 'QUOTA_EXHAUSTED' : 'INDETERMINATE');

  return [];
  } finally { acquisition.release(); }
}

/**
 * Fetches richer official channel metadata and recent uploads for a borderline
 * creator. Unlike discovery search, this is only called by a durable enrichment
 * job and throws when all configured keys fail so queue retry/backoff applies.
 */
export async function fetchYouTubeChannelEnrichment(
  channelId: string,
  fallback: DiscoveredChannelRaw
): Promise<DiscoveredChannelRaw> {
  const keyPool = getYouTubeKeyPool();
  if (keyPool.length === 0) {
    throw new Error('YouTube enrichment requires at least one configured YouTube API key.');
  }
  const acquisition = youtubePoolBackoff.beginAcquisition();

  let lastError: Error | null = null;
  let quotaExceededCount = 0;
  try { const providerIndexes=availableKeyIndexes(keyPool); for (let attempt = 0; attempt < providerIndexes.length; attempt++) {
    const currentIndex = providerIndexes[attempt];
    const apiKey = keyPool[currentIndex];
    try {
      const channelUrl = buildYouTubeApiUrl('channels',apiKey,{part:'snippet,brandingSettings,statistics',id:channelId});
      const recentUrl = buildYouTubeApiUrl('search',apiKey,{part:'snippet',channelId,order:'date',type:'video',maxResults:10});
      const [channelResponse, recentResponse] = await Promise.all([youtubeFetch(channelUrl,'channel-details',1,attempt+1,acquisition),youtubeFetch(recentUrl,'channel-uploads',100,attempt+1,acquisition)]);

      activeKeyIndex = currentIndex;
      await incrementQuota(101);
      const channelData = await channelResponse.json();
      const recentData = await recentResponse.json();
      const channel = channelData.items?.[0];
      if (!channel) throw new Error(`YouTube channel '${channelId}' was not found.`);

      const description = channel.snippet?.description || fallback.description;
      const recentItems = recentData.items || [];
      const observedAt = new Date();
      const uploadTimestamps = recentItems.map((item: any) => item.snippet?.publishedAt).filter((value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)));
      const countSince = (days: number) => uploadTimestamps.filter(value => Date.parse(value) >= observedAt.getTime() - days * 86_400_000).length;
      const latestUploadAt = uploadTimestamps.slice().sort().at(-1);
      const uploadsLast30Days = countSince(30), uploadsLast90Days = countSince(90), uploadsLast365Days = countSince(365);
      const ageDays = latestUploadAt ? (observedAt.getTime() - Date.parse(latestUploadAt)) / 86_400_000 : Infinity;
      const activityBand: ChannelActivityBand = !latestUploadAt ? 'UNKNOWN' : ageDays <= 30 ? 'VERY_ACTIVE' : ageDays <= 90 ? 'ACTIVE' : ageDays <= 365 ? 'OCCASIONAL' : 'DORMANT';
      const activityScore = !latestUploadAt ? 50 : Math.max(5, Math.round(100 * Math.exp(-ageDays / 365)));
      const officialCountry = channel.brandingSettings?.channel?.country;
      const extractedLinks = description.match(/https?:\/\/[^\s)\]}]+/g) || [];

      return {
        ...fallback,
        channelId,
        channelName: channel.snippet?.title || fallback.channelName,
        youtubeUrl: `https://www.youtube.com/channel/${channelId}`,
        description,
        videoTitles: recentItems.map((item: any) => item.snippet?.title).filter(Boolean),
        videoDescriptions: recentItems.map((item: any) => item.snippet?.description).filter(Boolean),
        locationTag: officialCountry || fallback.locationTag,
        countryMetadataStatus: officialCountry ? 'AVAILABLE_DECLARED' : 'AVAILABLE_NOT_DECLARED',
        countryMetadataCheckedAt: observedAt.toISOString(),
        channelLinks: Array.from(new Set([...(fallback.channelLinks || []), ...extractedLinks])),
        subscriberCount: channel.statistics?.subscriberCount || fallback.subscriberCount,
        channelThumbnailUrl: channel.snippet?.thumbnails?.high?.url || channel.snippet?.thumbnails?.default?.url || fallback.channelThumbnailUrl,
        uploadTimestamps, latestUploadAt, uploadsLast30Days, uploadsLast90Days, uploadsLast365Days,
        activityBand, activityScore, activityObservedAt: observedAt.toISOString()
      };
    } catch (error: any) {
      recordProviderFailure(apiKey,error);
      if (isQuotaExceeded(error)) quotaExceededCount++;
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  acquisition.providerFailed(quotaExceededCount === keyPool.length ? 'QUOTA_EXHAUSTED' : 'INDETERMINATE');

  throw lastError || new Error(`YouTube enrichment failed for '${channelId}'.`);
  } finally { acquisition.release(); }
}

/** One-unit metadata hydration used only when country evidence remains uncertain. */
export async function fetchYouTubeChannelCountryMetadata(channelId: string, fallback: DiscoveredChannelRaw): Promise<DiscoveredChannelRaw> {
  const keys = getYouTubeKeyPool();
  const checkedAt = new Date().toISOString();
  if (!keys.length) return { ...fallback, countryMetadataStatus: 'UNAVAILABLE', countryMetadataCheckedAt: checkedAt };
  let acquisition; try { acquisition=youtubePoolBackoff.beginAcquisition(); }
  catch { return { ...fallback, countryMetadataStatus: 'UNAVAILABLE', countryMetadataCheckedAt: checkedAt }; }
  let quotaExceededCount = 0;
  try { const providerIndexes=availableKeyIndexes(keys); for (let attempt = 0; attempt < providerIndexes.length; attempt++) {
    const index = providerIndexes[attempt];
    try {
      const url = buildYouTubeApiUrl('channels',keys[index],{part:'snippet,brandingSettings',id:channelId});
      const response = await youtubeFetch(url, 'channel-country-metadata', 1, attempt + 1, acquisition);
      const data = await response.json();
      const channel = data.items?.[0];
      if (!channel) throw new Error(`YouTube channel '${channelId}' was not found.`);
      await incrementQuota(1); activeKeyIndex = index;
      const officialCountry = channel.brandingSettings?.channel?.country;
      return { ...fallback, description: channel.snippet?.description || fallback.description,
        locationTag: officialCountry || fallback.locationTag,
        countryMetadataStatus: officialCountry ? 'AVAILABLE_DECLARED' : 'AVAILABLE_NOT_DECLARED', countryMetadataCheckedAt: checkedAt };
    } catch (error) { recordProviderFailure(keys[index],error);if (isQuotaExceeded(error)) quotaExceededCount++; }
  }
  acquisition.providerFailed(quotaExceededCount === keys.length ? 'QUOTA_EXHAUSTED' : 'INDETERMINATE');
  return { ...fallback, countryMetadataStatus: 'UNAVAILABLE', countryMetadataCheckedAt: checkedAt };
  } finally { acquisition.release(); }
}
