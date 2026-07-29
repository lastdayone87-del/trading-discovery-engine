import { CountryVocabulary } from '../src/types';
import { incrementQuota, getAppSetting, getYouTubeKeyPool, appendProviderCallEvent } from './db';
import { executeProviderCall } from './providerResilience';
import { RetrievalLane } from './retrievalLanes';
import { SearchOrdering, youtubeOrder } from './searchOrdering';
import { isQuotaExceeded, youtubePoolBackoff } from './youtubePoolBackoff';
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
}
export interface PlaylistChannelObservation {channelId:string;channelName:string;description:string;videoTitles:string[];observedAt:string}

/** One bounded playlistItems call (cost: one unit); no pagination is followed by the canary. */
export async function fetchYouTubePlaylistChannels(playlistId:string,limit:number):Promise<PlaylistChannelObservation[]> {
  const keys=getYouTubeKeyPool();if(!keys.length)throw new Error('YouTube playlist inspection requires an API key.');
  youtubePoolBackoff.beginAcquisition(); let quotaExceededCount=0;
  const maxResults=Math.min(50,Math.max(1,Math.trunc(limit)));const observedAt=new Date().toISOString();
  for(let attempt=0;attempt<keys.length;attempt++){const index=(activeKeyIndex+attempt)%keys.length;
    try{const url=`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${encodeURIComponent(playlistId)}&maxResults=${maxResults}&key=${keys[index]}`;const response=await youtubeFetch(url,'playlist-items',1,attempt+1);const data=await response.json();await incrementQuota(1);activeKeyIndex=index;youtubePoolBackoff.reportSuccess();
      return (data.items||[]).map((item:any)=>({channelId:String(item.snippet?.videoOwnerChannelId||''),channelName:String(item.snippet?.videoOwnerChannelTitle||''),description:String(item.snippet?.description||''),videoTitles:[String(item.snippet?.title||'')],observedAt})).filter((x:PlaylistChannelObservation)=>x.channelId&&x.channelName);
    }catch(error){if(isQuotaExceeded(error))quotaExceededCount++;if(attempt===keys.length-1){youtubePoolBackoff.reportFailure(quotaExceededCount===keys.length);if(quotaExceededCount===keys.length)youtubePoolBackoff.beginAcquisition();throw error;}}
  }throw new Error('All configured YouTube API keys failed for playlist inspection.');
}

/**
 * Retrieves all valid YouTube API keys available in environment variables.
 * Checks YOUTUBE_API_KEY and YOUTUBE_API_KEY_1..5.
 */
let activeKeyIndex = 0;

async function youtubeFetch(url:string,operation:string,actualCost:number,attempt=1):Promise<Response>{
  const enabled=(await getAppSetting('provider_deadlines_enabled',process.env.PROVIDER_DEADLINES_ENABLED||'false'))==='true';
  const timeout=Number(await getAppSetting('youtube_provider_timeout_ms',process.env.YOUTUBE_PROVIDER_TIMEOUT_MS||'30000'));
  return executeProviderCall({context:{provider:'youtube',operation,attempt,reservedCost:actualCost,actualCost},timeoutMs:timeout,enabled,emit:appendProviderCallEvent,call:async signal=>{const response=await fetch(url,{signal});if(!response.ok){const body=await response.clone().json().catch(()=>null) as any;const reasons=(body?.error?.errors||[]).map((item:any)=>item?.reason).filter(Boolean);const quotaExceeded=reasons.some((reason:string)=>/^(quotaExceeded|dailyLimitExceeded)$/i.test(reason));const error=Object.assign(new Error(`YouTube HTTP ${response.status}${reasons.length?` (${reasons.join(', ')})`:''}`),{status:response.status,quotaExceeded});throw error;}return response;}});
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
  youtubePoolBackoff.beginAcquisition();
  let quotaExceededCount = 0;

  if (keyPool.length > 0) {
    const attemptsCount = keyPool.length;
    for (let attempt = 0; attempt < attemptsCount; attempt++) {
      const currentIndex = (activeKeyIndex + attempt) % keyPool.length;
      const apiKey = keyPool[currentIndex];

      try {
        console.log(`[YouTube API Pool] Attempting search with key #${currentIndex + 1}/${keyPool.length} (${apiKey.slice(0, 6)}...)...`);
        const searchType = lane === 'VIDEO' ? 'video' : 'channel';
        const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=${searchType}&order=${youtubeOrder(ordering)}&q=${encodeURIComponent(
          sanitizedQuery
        )}&maxResults=${maxResults}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}&key=${apiKey}`;

        const res = await youtubeFetch(searchUrl,'search',100,attempt+1);

        if (res.ok) {
          activeKeyIndex = currentIndex; // Pin working key as preferred
          youtubePoolBackoff.reportSuccess();
          await incrementQuota(100); // 100 units for YouTube Search call
          const data = await res.json();
          const results = extractDiscoveredChannels(data.items || [], lane, sanitizedQuery);

          console.log(`[YouTube API Pool] Key #${currentIndex + 1} succeeded. ${lane} lane discovered ${results.length} unique channels.`);
          // An empty successful response is authoritative. Retrying the same
          // query against every key would multiply quota cost without changing it.
          return { channels: results, nextPageToken: data.nextPageToken || null, rawResultCount: (data.items || []).length };
        }
      } catch (e) {
        if (isQuotaExceeded(e)) quotaExceededCount++;
        console.warn(`[YouTube API Pool] Key #${currentIndex + 1} fetch error:`, e);
      }
    }
    youtubePoolBackoff.reportFailure(quotaExceededCount === keyPool.length);
    if (quotaExceededCount === keyPool.length) youtubePoolBackoff.beginAcquisition();
    console.warn('[YouTube API Pool] All API keys in pool encountered quotaExceeded or error or returned no results.');
  }

  throw new Error('All configured YouTube API keys failed for this discovery request.');
}

/**
 * Fetches recent video titles and descriptions for a channel using YouTube Data API.
 * Rotates API key pool automatically.
 */
export async function fetchRecentVideoDescriptionsFromAPI(channelId: string): Promise<string[]> {
  const keyPool = getYouTubeKeyPool();
  if (keyPool.length === 0 || !channelId) return [];
  youtubePoolBackoff.beginAcquisition();
  let quotaExceededCount = 0;

  for (let attempt = 0; attempt < keyPool.length; attempt++) {
    const currentIndex = (activeKeyIndex + attempt) % keyPool.length;
    const apiKey = keyPool[currentIndex];

    try {
      const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&order=date&type=video&maxResults=5&key=${apiKey}`;
      const res = await youtubeFetch(searchUrl,'recent-videos-search',100,attempt+1);

      if (res.ok) {
        activeKeyIndex = currentIndex;
        youtubePoolBackoff.reportSuccess();
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
          const videosUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoIds.join(',')}&key=${apiKey}`;
          const vRes = await youtubeFetch(videosUrl,'video-details',1,1);
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
      if (isQuotaExceeded(e)) quotaExceededCount++;
      console.warn(`[YouTube API] Failed to fetch video descriptions for ${channelId}:`, e);
    }
  }

  youtubePoolBackoff.reportFailure(quotaExceededCount === keyPool.length);
  if (quotaExceededCount === keyPool.length) youtubePoolBackoff.beginAcquisition();

  return [];
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
  youtubePoolBackoff.beginAcquisition();

  let lastError: Error | null = null;
  let quotaExceededCount = 0;
  for (let attempt = 0; attempt < keyPool.length; attempt++) {
    const currentIndex = (activeKeyIndex + attempt) % keyPool.length;
    const apiKey = keyPool[currentIndex];
    try {
      const channelUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet,brandingSettings,statistics&id=${encodeURIComponent(channelId)}&key=${apiKey}`;
      const recentUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${encodeURIComponent(channelId)}&order=date&type=video&maxResults=10&key=${apiKey}`;
      const [channelResponse, recentResponse] = await Promise.all([youtubeFetch(channelUrl,'channel-details',1,attempt+1),youtubeFetch(recentUrl,'channel-uploads',100,attempt+1)]);

      activeKeyIndex = currentIndex;
      youtubePoolBackoff.reportSuccess();
      await incrementQuota(101);
      const channelData = await channelResponse.json();
      const recentData = await recentResponse.json();
      const channel = channelData.items?.[0];
      if (!channel) throw new Error(`YouTube channel '${channelId}' was not found.`);

      const description = channel.snippet?.description || fallback.description;
      const recentItems = recentData.items || [];
      const extractedLinks = description.match(/https?:\/\/[^\s)\]}]+/g) || [];

      return {
        ...fallback,
        channelId,
        channelName: channel.snippet?.title || fallback.channelName,
        youtubeUrl: `https://www.youtube.com/channel/${channelId}`,
        description,
        videoTitles: recentItems.map((item: any) => item.snippet?.title).filter(Boolean),
        videoDescriptions: recentItems.map((item: any) => item.snippet?.description).filter(Boolean),
        locationTag: channel.snippet?.country || fallback.locationTag,
        channelLinks: Array.from(new Set([...(fallback.channelLinks || []), ...extractedLinks])),
        subscriberCount: channel.statistics?.subscriberCount || fallback.subscriberCount,
        channelThumbnailUrl: channel.snippet?.thumbnails?.high?.url || channel.snippet?.thumbnails?.default?.url || fallback.channelThumbnailUrl
      };
    } catch (error: any) {
      if (isQuotaExceeded(error)) quotaExceededCount++;
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  youtubePoolBackoff.reportFailure(quotaExceededCount === keyPool.length);
  if (quotaExceededCount === keyPool.length) youtubePoolBackoff.beginAcquisition();

  throw lastError || new Error(`YouTube enrichment failed for '${channelId}'.`);
}
