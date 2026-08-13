import { ChannelActivityBand, CountryMetadataStatus, CountryVocabulary } from '../src/types';
import { incrementQuota, getAppSetting, getYouTubeKeyPool, appendProviderCallEvent } from './db';
import { executeProviderCall, ProviderCallError } from './providerResilience';
import { RetrievalLane } from './retrievalLanes';
import { SearchOrdering, youtubeOrder } from './searchOrdering';
import { countrySearchHints } from './countrySearchHints';
import { isQuotaExceeded, youtubePoolBackoff, type YouTubePoolAcquisition } from './youtubePoolBackoff';
import { recordExecutionStage, recordFirstYouTubeRequest } from './executionTrace';
import { youtubeRequestScheduler } from './youtubeRequestScheduler';
import { youtubeProviderCooldown, YouTubeProvidersCoolingDownError } from './youtubeProviderCooldown';
import { FEATURED_CHANNEL_PROVIDER_COST, parseFeaturedChannelSections, type FeaturedChannelProviderResult } from './featuredChannelAdapter';
import { fetchInnerTubeChannelEnrichment } from './youtubeInnerTubeEnrichment';
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
  videos?: Array<{id?:string;title:string;description?:string;published_at?:string;content_type?:string;language?:string;script?:string;source_family_id?:string;source_entity_id?:string}>;
  playlists?: Array<{id?:string;name:string;description?:string}>;
  transcriptExcerpts?: Array<{video_id?:string;text:string;language?:string}>;
  detectedLanguages?: Array<{language:string;confidence?:number;field?:import('./evidenceEngine').EvidenceFieldType}>;
  externalLinkDetails?: Array<{label?:string;url:string;domain?:string;resolved_entity_type?:string;source_family_id?:string;source_entity_id?:string}>;
  visualEvidence?: Array<{source_ref:string;description:string;model_provenance:string}>;
  enrichmentStage?: number;
  investigationId?: string;
  /** The retrieval document nominated this channel; it is not channel About metadata. */
  matchedDocument?: {type:'VIDEO'|'CHANNEL'|'PLAYLIST'|'EXTERNAL'|'MANUAL'|'UNKNOWN';providerNativeId?:string;title?:string;description?:string;publishedAt?:string;locator?:string};
  nominationId?: string;
  queryRunId?: string;
  discoveryJobId?: string;
}
export interface PlaylistChannelObservation {channelId:string;channelName:string;description:string;videoTitles:string[];observedAt:string}

/** One bounded channelSections.list request; only explicit multipleChannels IDs survive parsing. */
export async function fetchYouTubeFeaturedChannels(sourceChannelId: string, maximumFanout: number): Promise<FeaturedChannelProviderResult> {
  if (!/^UC[A-Za-z0-9_-]{22}$/.test(sourceChannelId) || !Number.isInteger(maximumFanout) || maximumFanout < 1 || maximumFanout > 10) throw new Error('INVALID_FEATURED_CHANNEL_PROVIDER_INPUT');
  const keys = getYouTubeKeyPool(); if (!keys.length) throw new Error('YouTube featured-channel inspection requires an API key.');
  const acquisition = youtubePoolBackoff.beginAcquisition();
  try {
    const index = availableKeyIndexes(keys)[0];
    const url = buildYouTubeApiUrl('channelSections', keys[index], { part: 'snippet,contentDetails', channelId: sourceChannelId, maxResults: Math.min(50, maximumFanout) });
    let response: Response;
    try {
      response = await youtubeFetch(url, 'featured-channel-sections', FEATURED_CHANNEL_PROVIDER_COST, 1, acquisition);
    } catch (error) { recordProviderFailure(keys[index], error); acquisition.providerFailed(isQuotaExceeded(error) ? 'QUOTA_EXHAUSTED' : 'INDETERMINATE'); throw error; }
    await incrementQuota(FEATURED_CHANNEL_PROVIDER_COST); activeKeyIndex = index;
    return parseFeaturedChannelSections({ sourceChannelId, maximumFanout, response: await readYouTubeJsonObject(response, 'featured-channel-sections'), observedAt: new Date().toISOString() });
  } finally { acquisition.release(); }
}

/** One bounded playlistItems call (cost: one unit); no pagination is followed by the canary. */
export async function fetchYouTubePlaylistChannels(playlistId:string,limit:number):Promise<PlaylistChannelObservation[]> {
  const keys=getYouTubeKeyPool();if(!keys.length)throw new Error('YouTube playlist inspection requires an API key.');
  const acquisition=youtubePoolBackoff.beginAcquisition(); let quotaExceededCount=0;
  const maxResults=Math.min(50,Math.max(1,Math.trunc(limit)));const observedAt=new Date().toISOString();
  try {
    const providerIndexes=availableKeyIndexes(keys);
    for(let attempt=0;attempt<providerIndexes.length;attempt++){const index=providerIndexes[attempt];
      try{const url=buildYouTubeApiUrl('playlistItems',keys[index],{part:'snippet',playlistId,maxResults});const response=await youtubeFetch(url,'playlist-items',1,attempt+1,acquisition);const data=await readYouTubeJsonObject(response, 'playlist-items');await incrementQuota(1);activeKeyIndex=index;
        return (data.items||[]).map((item:any)=>({channelId:String(item.snippet?.videoOwnerChannelId||''),channelName:String(item.snippet?.videoOwnerChannelTitle||''),description:String(item.snippet?.description||''),videoTitles:[String(item.snippet?.title||'')],observedAt})).filter((x:PlaylistChannelObservation)=>x.channelId&&x.channelName);
      }catch(error){recordProviderFailure(keys[index],error);if(isQuotaExceeded(error))quotaExceededCount++;if(attempt===providerIndexes.length-1){acquisition.providerFailed(quotaExceededCount===providerIndexes.length?'QUOTA_EXHAUSTED':'INDETERMINATE');throwIfAllProvidersCoolingDown(keys);throw error;}}
    }throw new Error('All configured YouTube API keys failed for playlist inspection.');
  } finally { acquisition.release(); }
}

/**
 * Retrieves all valid YouTube API keys available in environment variables.
 * Checks the configuration-driven YouTube key environment-variable pool.
 */
let activeKeyIndex = 0;
let outboundTraceSequence = 0;

function availableKeyIndexes(keys: string[]): number[] {
  const indexes = keys.map((_key, index) => (activeKeyIndex + index) % keys.length)
    .filter(index => youtubeProviderCooldown.eligible(keys[index]));
  if (indexes.length) return indexes;
  throwIfAllProvidersCoolingDown(keys);
  return [];
}

function throwIfAllProvidersCoolingDown(keys: string[]): void {
  const retryAt = youtubeProviderCooldown.earliestRetryAtIfAllCooling(keys);
  if (retryAt !== null) throw new YouTubeProvidersCoolingDownError(retryAt);
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
  resource: 'search' | 'videos' | 'channels' | 'playlistItems' | 'channelSections',
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

/**
 * Reads a successful YouTube provider response only after validating its
 * status, content type, JSON syntax, and top-level object shape. Proxies and
 * provider edges occasionally return plain text or HTML with a successful
 * transport status; those responses are operationally retryable, not data.
 */
export async function readYouTubeJsonObject<T extends Record<string, any> = Record<string, any>>(response: Response, operation: string): Promise<T> {
  if (!response.ok) throw await youtubeHttpError(response);
  const status = response.status;
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const body = (await response.text()).trim();
  if (!body) throw new ProviderCallError(`YouTube ${operation} returned an empty response (HTTP ${status}).`, 'TRANSIENT', true, { status });
  if (!contentType.includes('json')) throw new ProviderCallError(`YouTube ${operation} returned a non-JSON response (HTTP ${status}).`, 'TRANSIENT', true, { status });
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (cause) {
    throw new ProviderCallError(`YouTube ${operation} returned invalid JSON (HTTP ${status}).`, 'TRANSIENT', true, { status, cause });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProviderCallError(`YouTube ${operation} returned an invalid JSON object (HTTP ${status}).`, 'TRANSIENT', true, { status });
  }
  const object = parsed as Record<string, any>;
  if (object.error) {
    throw new ProviderCallError(`YouTube ${operation} returned a provider error payload (HTTP ${status}).`, 'TRANSIENT', true, { status });
  }
  if (!Array.isArray(object.items)) {
    throw new ProviderCallError(`YouTube ${operation} returned a JSON body without an items array (HTTP ${status}).`, 'TRANSIENT', true, { status });
  }
  return object as T;
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
      // A VIDEO search snippet describes the matched video, not the channel.
      // Preserve it as retrieval provenance and leave About unknown until the
      // authoritative channels resource is hydrated.
      description: lane === 'VIDEO' ? '' : (item.snippet?.description || ''),
      videoTitles: videoTitle ? [videoTitle] : [sanitizedQuery],
      videoDescriptions: videoDescription ? [videoDescription] : [],
      locationTag: item.snippet?.country || undefined,
      channelLinks: [],
      channelThumbnailUrl: thumb,
      matchedDocument: lane==='VIDEO'
        ? {type:'VIDEO',providerNativeId:item.id?.videoId,title:videoTitle,description:videoDescription,publishedAt:item.snippet?.publishedAt,locator:item.id?.videoId?`youtube:video:${item.id.videoId}`:undefined}
        : {type:'CHANNEL',providerNativeId:channelId,title:item.snippet?.title,description:item.snippet?.description,locator:`youtube:channel:${channelId}`}
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
  const searchHints = countrySearchHints(countryName, vocab?.languages || []);

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
          q: sanitizedQuery, maxResults, pageToken: pageToken || undefined,
          regionCode: searchHints.regionCode, relevanceLanguage: searchHints.relevanceLanguage
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
          const data = await readYouTubeJsonObject(res, 'search');
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
    throwIfAllProvidersCoolingDown(keyPool);
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
  if (!channelId) return [];
  if (keyPool.length === 0) throw new Error('Recent-video description API is unavailable because no provider is configured.');
  const acquisition = youtubePoolBackoff.beginAcquisition();
  let quotaExceededCount = 0;

  let acquiredResponse = false;
  try { const providerIndexes=availableKeyIndexes(keyPool); for (let attempt = 0; attempt < providerIndexes.length; attempt++) {
    const currentIndex = providerIndexes[attempt];
    const apiKey = keyPool[currentIndex];

    try {
      const searchUrl = buildYouTubeApiUrl('search',apiKey,{part:'snippet',channelId,order:'date',type:'video',maxResults:5});
      const res = await youtubeFetch(searchUrl,'recent-videos-search',100,attempt+1,acquisition);

      if (res.ok) {
        acquiredResponse = true;
        activeKeyIndex = currentIndex;
        await incrementQuota(100);
        const data = await readYouTubeJsonObject(res, 'recent-videos-search');
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
            const vData = await readYouTubeJsonObject(vRes, 'video-details');
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

  if(!acquiredResponse)throw new Error('Recent-video description API acquisition failed for every configured provider.');
  return [];
  } finally { acquisition.release(); }
}

/**
 * Fetches richer official channel metadata and recent uploads for a borderline
 * creator. Unlike discovery search, this is only called by a durable enrichment
 * job and throws when all configured keys fail so queue retry/backoff applies.
 */
async function fetchYouTubeChannelEnrichmentOfficial(
  channelId: string,
  fallback: DiscoveredChannelRaw,
  stage:1|2|3=1
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
      const channelData = await readYouTubeJsonObject(channelResponse, 'channel-details');
      const recentData = await readYouTubeJsonObject(recentResponse, 'channel-uploads');
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
      let videos=recentItems.map((item:any)=>({id:item.id?.videoId,title:String(item.snippet?.title||''),description:String(item.snippet?.description||''),published_at:item.snippet?.publishedAt,content_type:'youtube_video'})).filter((video:any)=>video.title);
      let playlists=fallback.playlists||[];
      if(stage>=2){
        const ids=videos.map(video=>video.id).filter(Boolean).join(',');
        const requests:Promise<Response>[]=[];
        if(ids)requests.push(youtubeFetch(buildYouTubeApiUrl('videos',apiKey,{part:'snippet',id:ids}),'enrichment-video-details',1,attempt+1,acquisition));
        requests.push(youtubeFetch(buildYouTubeApiUrl('search',apiKey,{part:'snippet',channelId,type:'playlist',maxResults:10}),'enrichment-playlists',100,attempt+1,acquisition));
        const detailResponses=await Promise.all(requests);await incrementQuota(requests.length===2?101:100);
        for(const response of detailResponses){const payload=await readYouTubeJsonObject(response, 'enrichment-details');if(payload.items?.some((item:any)=>item.id?.kind==='youtube#playlist'||typeof item.id==='object'))playlists=payload.items.map((item:any)=>({id:item.id?.playlistId,name:String(item.snippet?.title||''),description:String(item.snippet?.description||'')})).filter((item:any)=>item.name);else{const byId=new Map(payload.items?.map((item:any)=>[item.id,item.snippet])||[]);videos=videos.map(video=>({...video,description:String((byId.get(video.id) as any)?.description||video.description||'')}));}}
      }

      return {
        ...fallback,
        channelId,
        channelName: channel.snippet?.title || fallback.channelName,
        youtubeUrl: `https://www.youtube.com/channel/${channelId}`,
        description,
        videoTitles: recentItems.map((item: any) => item.snippet?.title || ''),
        videos,playlists,videoDescriptions:videos.map(video=>video.description||''),
        locationTag: officialCountry || fallback.locationTag,
        countryMetadataStatus: officialCountry ? 'AVAILABLE_DECLARED' : 'AVAILABLE_NOT_DECLARED',
        countryMetadataCheckedAt: observedAt.toISOString(),
        channelLinks: Array.from(new Set([...(fallback.channelLinks || []), ...extractedLinks])),
        subscriberCount: channel.statistics?.subscriberCount || fallback.subscriberCount,
        channelThumbnailUrl: channel.snippet?.thumbnails?.high?.url || channel.snippet?.thumbnails?.default?.url || fallback.channelThumbnailUrl,
        uploadTimestamps, latestUploadAt, uploadsLast30Days, uploadsLast90Days, uploadsLast365Days,
        activityBand, activityScore, activityObservedAt: observedAt.toISOString(), enrichmentStage:stage,
        externalLinkDetails:extractedLinks.map(url=>{try{return {url,domain:new URL(url).hostname.toLowerCase()};}catch{return {url};}})
      };
    } catch (error: any) {
      recordProviderFailure(apiKey,error);
      if (isQuotaExceeded(error)) quotaExceededCount++;
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  acquisition.providerFailed(quotaExceededCount === keyPool.length ? 'QUOTA_EXHAUSTED' : 'INDETERMINATE');
  throwIfAllProvidersCoolingDown(keyPool);

  throw lastError || new Error(`YouTube enrichment failed for '${channelId}'.`);
  } finally { acquisition.release(); }
}


/**
 * Quota-free hybrid evidence acquisition for channels whose country attribution
 * is already independently CONFIRMED. This deliberately does not invent or
 * upgrade official country metadata; it only supplies creator-owned recent
 * uploads/activity/playlists from YouTube.js so official quota exhaustion cannot
 * block trading-evidence processing.
 */
export async function fetchYouTubeChannelEnrichmentQuotaFree(
  channelId: string,
  fallback: DiscoveredChannelRaw,
  stage:1|2|3=1
): Promise<DiscoveredChannelRaw> {
  const inner=await fetchInnerTubeChannelEnrichment(channelId,{maxVideos:10,detailVideos:stage>=2?10:6,includePlaylists:stage>=2,timeoutMs:Number(await getAppSetting('youtube_provider_timeout_ms',process.env.YOUTUBE_PROVIDER_TIMEOUT_MS||'30000'))});
  const observedAt=new Date();
  const videos=inner.videos.map(video=>({id:video.id,title:video.title,description:video.description||'',published_at:video.published_at,content_type:'youtube_video'}));
  const uploadTimestamps=videos.map(video=>video.published_at).filter((value):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value)));
  const countSince=(days:number)=>uploadTimestamps.filter(value=>Date.parse(value)>=observedAt.getTime()-days*86_400_000).length;
  const latestUploadAt=uploadTimestamps.slice().sort().at(-1);
  const uploadsLast30Days=countSince(30),uploadsLast90Days=countSince(90),uploadsLast365Days=countSince(365);
  const ageDays=latestUploadAt?(observedAt.getTime()-Date.parse(latestUploadAt))/86_400_000:Infinity;
  const activityBand:ChannelActivityBand=!latestUploadAt?'UNKNOWN':ageDays<=30?'VERY_ACTIVE':ageDays<=90?'ACTIVE':ageDays<=365?'OCCASIONAL':'DORMANT';
  const activityScore=!latestUploadAt?50:Math.max(5,Math.round(100*Math.exp(-ageDays/365)));
  return {...fallback,channelId,youtubeUrl:`https://www.youtube.com/channel/${channelId}`,videoTitles:videos.map(video=>video.title),videos,playlists:inner.playlists.length?inner.playlists:(fallback.playlists||[]),videoDescriptions:videos.map(video=>video.description||''),uploadTimestamps,latestUploadAt,uploadsLast30Days,uploadsLast90Days,uploadsLast365Days,activityBand,activityScore,activityObservedAt:observedAt.toISOString(),enrichmentStage:stage,countryMetadataStatus:fallback.countryMetadataStatus||'NOT_REQUESTED'};
}

/** Hybrid quota-light enrichment: YouTube.js for expensive creator evidence; official channels.list for authoritative metadata. */
export async function fetchYouTubeChannelEnrichment(
  channelId: string,
  fallback: DiscoveredChannelRaw,
  stage:1|2|3=1
): Promise<DiscoveredChannelRaw> {
  const hybridEnabled=await getAppSetting('youtube_js_hybrid_enrichment_enabled',process.env.YOUTUBE_JS_HYBRID_ENRICHMENT_ENABLED||'false')==='true';
  if(!hybridEnabled) return fetchYouTubeChannelEnrichmentOfficial(channelId,fallback,stage);
  const inner=await fetchInnerTubeChannelEnrichment(channelId,{maxVideos:10,detailVideos:stage>=2?10:6,includePlaylists:stage>=2,timeoutMs:Number(await getAppSetting('youtube_provider_timeout_ms',process.env.YOUTUBE_PROVIDER_TIMEOUT_MS||'30000'))});
  const keyPool=getYouTubeKeyPool();
  if(!keyPool.length) throw new ProviderCallError('Hybrid YouTube enrichment requires one official API key for authoritative channel metadata.','CREDENTIALS_EXHAUSTED',true);
  const acquisition=youtubePoolBackoff.beginAcquisition();
  let lastError:Error|null=null,quotaExceededCount=0;
  try {
    const providerIndexes=availableKeyIndexes(keyPool);
    for(let attempt=0;attempt<providerIndexes.length;attempt++){
      const currentIndex=providerIndexes[attempt],apiKey=keyPool[currentIndex];
      try{
        const channelUrl=buildYouTubeApiUrl('channels',apiKey,{part:'snippet,brandingSettings,statistics',id:channelId});
        const response=await youtubeFetch(channelUrl,'hybrid-enrichment-channel-details',1,attempt+1,acquisition);
        const channelData=await readYouTubeJsonObject(response,'hybrid-enrichment-channel-details');
        const channel=channelData.items?.[0];
        if(!channel) throw new Error(`YouTube channel '${channelId}' was not found.`);
        activeKeyIndex=currentIndex;await incrementQuota(1);
        const description=channel.snippet?.description||fallback.description;
        const observedAt=new Date();
        const videos=inner.videos.map(video=>({id:video.id,title:video.title,description:video.description||'',published_at:video.published_at,content_type:'youtube_video'}));
        const uploadTimestamps=videos.map(video=>video.published_at).filter((value):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value)));
        const countSince=(days:number)=>uploadTimestamps.filter(value=>Date.parse(value)>=observedAt.getTime()-days*86_400_000).length;
        const latestUploadAt=uploadTimestamps.slice().sort().at(-1);
        const uploadsLast30Days=countSince(30),uploadsLast90Days=countSince(90),uploadsLast365Days=countSince(365);
        const ageDays=latestUploadAt?(observedAt.getTime()-Date.parse(latestUploadAt))/86_400_000:Infinity;
        const activityBand:ChannelActivityBand=!latestUploadAt?'UNKNOWN':ageDays<=30?'VERY_ACTIVE':ageDays<=90?'ACTIVE':ageDays<=365?'OCCASIONAL':'DORMANT';
        const activityScore=!latestUploadAt?50:Math.max(5,Math.round(100*Math.exp(-ageDays/365)));
        const officialCountry=channel.brandingSettings?.channel?.country;
        const extractedLinks=description.match(/https?:\/\/[^\s)\]}]+/g)||[];
        const playlists=inner.playlists.length?inner.playlists:(fallback.playlists||[]);
        return {...fallback,channelId,channelName:channel.snippet?.title||fallback.channelName,youtubeUrl:`https://www.youtube.com/channel/${channelId}`,description,videoTitles:videos.map(video=>video.title),videos,playlists,videoDescriptions:videos.map(video=>video.description||''),locationTag:officialCountry||fallback.locationTag,countryMetadataStatus:officialCountry?'AVAILABLE_DECLARED':'AVAILABLE_NOT_DECLARED',countryMetadataCheckedAt:observedAt.toISOString(),channelLinks:Array.from(new Set([...(fallback.channelLinks||[]),...extractedLinks])),subscriberCount:channel.statistics?.subscriberCount||fallback.subscriberCount,channelThumbnailUrl:channel.snippet?.thumbnails?.high?.url||channel.snippet?.thumbnails?.default?.url||fallback.channelThumbnailUrl,uploadTimestamps,latestUploadAt,uploadsLast30Days,uploadsLast90Days,uploadsLast365Days,activityBand,activityScore,activityObservedAt:observedAt.toISOString(),enrichmentStage:stage,externalLinkDetails:extractedLinks.map(url=>{try{return {url,domain:new URL(url).hostname.toLowerCase()};}catch{return {url};}})};
      }catch(error:any){recordProviderFailure(apiKey,error);if(isQuotaExceeded(error))quotaExceededCount++;lastError=error instanceof Error?error:new Error(String(error));}
    }
    acquisition.providerFailed(quotaExceededCount===keyPool.length?'QUOTA_EXHAUSTED':'INDETERMINATE');
    throwIfAllProvidersCoolingDown(keyPool);
    throw lastError||new Error(`Hybrid YouTube enrichment failed for '${channelId}'.`);
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
      const data = await readYouTubeJsonObject(response, 'channel-country-metadata');
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
