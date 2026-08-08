import * as cheerio from 'cheerio';
import { InspectionStep } from '../src/types';
import { incrementQuota } from './db';
import { fetchRecentVideoDescriptionsFromAPI } from './youtube';
import {extractDiscordCandidates,makeDiscordCandidate,type DiscordCandidate} from './discordCandidates';

export interface InspectionResult {
  debugLog?: any;
  foundInvite: string | null;
  foundLocation?: string;
  steps: InspectionStep[];
  extractedThumbnailUrl?: string;
  observedAboutBio: string;
  observedChannelLinks: string[];
  acquisitionStatus?: ExternalAcquisitionStatus;
  acquisitionOutcomes?: ExternalAcquisitionObservation[];
  discordCandidates?: DiscordCandidate[];
}
export type ExternalAcquisitionStatus='FOUND'|'INSPECTED_NO_MATCH'|'PARTIALLY_INSPECTED'|'ACQUISITION_FAILED';
export type AcquisitionSurface='YOUTUBE_ABOUT'|'RECENT_VIDEO_DESCRIPTIONS'|'CHANNEL_EXTERNAL_LINKS'|'CREATOR_WEBSITES'|'SOCIAL_PROFILES'|'DISCORD_VALIDATION';
export interface ExternalAcquisitionObservation {requestedUrl:string;finalUrl?:string;wrapperUrl?:string;surface:AcquisitionSurface;required:boolean;outcome:ExternalAcquisitionStatus;retryable:boolean;httpStatus?:number;failureClass?:string;detail:string;observedAt:string}

export interface NormalizedExternalUrl {url:string;wrapperUrl?:string;kind:'WEBSITE'|'SOCIAL'}
const socialHosts=new Set(['twitter.com','www.twitter.com','x.com','www.x.com','instagram.com','www.instagram.com','tiktok.com','www.tiktok.com']);
export function normalizeExternalUrl(raw:string):NormalizedExternalUrl|null {
  try {
    let parsed=new URL(raw.match(/^https?:\/\//i)?raw:`https://${raw}`),wrapperUrl:string|undefined;
    if((parsed.hostname==='youtube.com'||parsed.hostname.endsWith('.youtube.com'))&&parsed.pathname==='/redirect'){
      wrapperUrl=parsed.toString();let destination=parsed.searchParams.get('q');
      if(!destination)return null;
      for(let i=0;i<2;i++)try{const decoded=decodeURIComponent(destination);if(decoded===destination)break;destination=decoded;}catch{break;}
      parsed=new URL(destination);
    }
    if(!['http:','https:'].includes(parsed.protocol))return null;
    const host=parsed.hostname.toLowerCase();
    if(host==='youtube.com'||host.endsWith('.youtube.com')||host==='youtu.be')return null;
    parsed.hash='';
    for(const key of [...parsed.searchParams.keys()])if(/^utm_|^(fbclid|gclid|ref|feature)$/i.test(key))parsed.searchParams.delete(key);
    parsed.hostname=host;parsed.pathname=parsed.pathname.replace(/\/$/,'')||'/';
    const kind=socialHosts.has(host)?'SOCIAL':'WEBSITE';
    return {url:parsed.toString(),wrapperUrl,kind};
  }catch{return null;}
}

/**
 * Extracts clean Discord invite code or link from raw text.
 * Handles obfuscated formats, JSON escaping, and alternative URL formats:
 * - discord.gg/XXXXX
 * - discord.com/invite/XXXXX
 * - discordapp.com/invite/XXXXX
 * - discord.app/invite/XXXXX
 * - dsc.gg/XXXXX
 * - discord.me/XXXXX
 * - discord.io/XXXXX
 * - disboard.org/server/XXXXX
 * - Obfuscated: discord [dot] gg / XXXXX, discord.gg: XXXXX
 */
export function extractDiscordInvite(text: string): string | null {
  return extractDiscordCandidates(text).find(candidate=>candidate.nativeInviteCode)?.nativeInviteCode||null;
}

/**
 * Extracts raw HTTP/HTTPS URLs embedded in any arbitrary text block.
 */
export function extractExternalUrlsFromText(text: string): string[] {
  if (!text) return [];
  const clean = text
    .replace(/\\\/|\\u002f/gi, '/')
    .replace(/\\u003a/gi, ':')
    .replace(/\\u0026/gi, '&')
    .replace(/%2f/gi, '/')
    .replace(/%3a/gi, ':');

  const regex = /https?:\/\/[^\s"'<>\)\\]+/gi;
  const matches = clean.match(regex) || [];

  const results: string[] = [];
  for (let m of matches) {
    m = m.replace(/[\.,\)\;\:\>\<\"]+$/, ''); // Clean trailing punctuation
    const lowerM = m.toLowerCase();
    if (
      !lowerM.includes('youtube.com') &&
      !lowerM.includes('youtu.be') &&
      !lowerM.includes('google.com') &&
      !lowerM.includes('googleusercontent.com') &&
      !lowerM.includes('ggpht.com') &&
      !lowerM.includes('gstatic.com') &&
      !lowerM.includes('doubleclick.net') &&
      !lowerM.includes('googlesyndication.com') &&
      !lowerM.includes('schema.org') &&
      !lowerM.includes('w3.org') &&
      !lowerM.includes('googleapis.com') &&
      !lowerM.includes('googlevideo.com') &&
      !lowerM.includes('ytimg.com') &&
      !/\.(png|jpg|jpeg|gif|webp|svg|css|js|wasm|ico|woff|woff2|ttf|eot)(\?.*)?$/i.test(m)
    ) {
      if (!results.includes(m)) {
        results.push(m);
      }
    }
  }
  return results;
}

/**
 * Safely fetches a URL with 10s timeout, max redirect depth.
 */
async function fetchWithTimeout(url: string, depth = 0): Promise<{ html: string; finalUrl: string } | null> {
  if (depth > 2) return null;

  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
      },
      redirect: 'follow'
    });
    clearTimeout(id);

    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('json') && !contentType.includes('plain')) {
      return null;
    }

    const html = await res.text();
    return { html, finalUrl: res.url };
  } catch (err) {
    return null;
  }
}

/**
 * Crawls external links (Linktree, Beacons, Carrd, Dub.sh, Bitly, websites) for Discord invites.
 * Resolves HTTP redirects automatically and verifies final landing URL.
 */
export async function crawlExternalLinks(
  links: string[],
  logDetails: string[] = [],
  debugLog?: any,
  fetchImpl:typeof fetch=fetch,
  surface:AcquisitionSurface='CREATOR_WEBSITES',
  required=false,
  wrapperUrl?:string
): Promise<{ foundInvite: string | null; foundLocation?: string; details: string; outcome:ExternalAcquisitionStatus; observations:ExternalAcquisitionObservation[] }> {
  let scannedCount = 0;
  const observations:ExternalAcquisitionObservation[]=[];

  for (const rawUrl of links) {
    if (!rawUrl || typeof rawUrl !== 'string') continue;
    let url = rawUrl.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = `https://${url}`;
    }

    scannedCount++;
    logDetails.push(`[Link #${scannedCount}] Inspecting target: ${url}`);

    // Direct check if URL itself contains invite code
    const directInvite = extractDiscordInvite(url);
    if (debugLog) debugLog.discordRegexAttempts.push({ source: 'crawlExternalLinks_direct', url, result: directInvite });
    if (directInvite) {
      logDetails.push(`Direct Discord link detected in URL parameter: ${url} (Invite: ${directInvite})`);
      observations.push({requestedUrl:url,finalUrl:url,wrapperUrl,surface,required,outcome:'FOUND',retryable:false,detail:'Direct Discord invite in URL',observedAt:new Date().toISOString()});
      return { foundInvite: directInvite, details: logDetails.join('\n'),outcome:'FOUND',observations };
    }

    // Crawl target page (fetchWithTimeout follows HTTP redirects)
    let page:{html:string;finalUrl:string}|null=null;
    try{const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);const response=await fetchImpl(url,{signal:controller.signal,headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36','Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'},redirect:'follow'});clearTimeout(timer);const contentType=response.headers.get('content-type')||'';if(!response.ok){const retryable=response.status===429||response.status>=500;observations.push({requestedUrl:url,finalUrl:response.url||url,wrapperUrl,surface,required,outcome:'ACQUISITION_FAILED',retryable,httpStatus:response.status,failureClass:response.status===429?'RATE_LIMIT':response.status>=500?'TRANSIENT_HTTP':'HTTP_ERROR',detail:`HTTP ${response.status}`,observedAt:new Date().toISOString()});}else if(!contentType.includes('text/html')&&!contentType.includes('json')&&!contentType.includes('plain'))observations.push({requestedUrl:url,finalUrl:response.url||url,wrapperUrl,surface,required,outcome:'ACQUISITION_FAILED',retryable:false,httpStatus:response.status,failureClass:'UNSUPPORTED_CONTENT_TYPE',detail:`Unsupported content type ${contentType||'unknown'}`,observedAt:new Date().toISOString()});else page={html:await response.text(),finalUrl:response.url||url};}catch(error:any){const timeout=error?.name==='AbortError';observations.push({requestedUrl:url,wrapperUrl,surface,required,outcome:'ACQUISITION_FAILED',retryable:true,failureClass:timeout?'TIMEOUT':'NETWORK_FAILURE',detail:String(error?.message||error),observedAt:new Date().toISOString()});}
    if (debugLog && page) {
      debugLog.redirectsFollowed.push({ from: url, to: page.finalUrl });
    }
    if (!page) {
      logDetails.push(`Failed or timed out trying to reach external URL: ${url}`);
      continue;
    }

    logDetails.push(`Successfully loaded ${page.finalUrl} (${page.html.length} bytes)`);

    // CHECK FINAL URL AFTER REDIRECT RESOLUTION!
    const finalUrlInvite = extractDiscordInvite(page.finalUrl);
    if (debugLog) debugLog.discordRegexAttempts.push({ source: 'crawlExternalLinks_finalUrl', url: page.finalUrl, result: finalUrlInvite });
    if (finalUrlInvite) {
      logDetails.push(`Redirect target URL resolved to Discord invite on ${page.finalUrl} (Invite: ${finalUrlInvite})`);
      observations.push({requestedUrl:url,finalUrl:page.finalUrl,wrapperUrl,surface,required,outcome:'FOUND',retryable:false,httpStatus:200,detail:'Discord invite found after redirect',observedAt:new Date().toISOString()});
      return { foundInvite: finalUrlInvite, details: logDetails.join('\n'),outcome:'FOUND',observations };
    }

    // Extract directly from page HTML (covers embedded JSON state objects in Next.js/React/Nuxt)
    const inviteFromHtml = extractDiscordInvite(page.html);
    if (debugLog) debugLog.discordRegexAttempts.push({ source: 'crawlExternalLinks_html', url: page.finalUrl, textLength: page.html.length, result: inviteFromHtml });
    if (inviteFromHtml) {
      logDetails.push(`Discord invite extracted from page HTML payload on ${page.finalUrl} (Invite: ${inviteFromHtml})`);
      observations.push({requestedUrl:url,finalUrl:page.finalUrl,wrapperUrl,surface,required,outcome:'FOUND',retryable:false,httpStatus:200,detail:'Discord invite found in page content',observedAt:new Date().toISOString()});
      return { foundInvite: inviteFromHtml, details: logDetails.join('\n'),outcome:'FOUND',observations };
    }

    // Parse anchor tags
    const $ = cheerio.load(page.html);
    let pageFound: string | null = null;
    const subpagesToVisit: string[] = [];

    $('a[href]').each((_, el) => {
      const href = ($(el).attr('href') || '').trim();
      if (!href) return;

      const inv = extractDiscordInvite(href);
      if (debugLog) debugLog.discordRegexAttempts.push({ source: 'crawlExternalLinks_anchorHref', url: href, result: inv });
      if (inv) {
        pageFound = inv;
        logDetails.push(`Discord link found in anchor href: ${href}`);
        return false;
      }

      // Check for community subpages on custom website domains
      if (
        (href.includes('/discord') || href.includes('/community') || href.includes('/join') || href.includes('/chat')) &&
        !href.includes('youtube.com') && !href.includes('twitter.com')
      ) {
        let fullSub = href;
        if (href.startsWith('/')) {
          try {
            const parsed = new URL(page.finalUrl);
            fullSub = `${parsed.origin}${href}`;
          } catch (e) {}
        }
        if (fullSub.startsWith('http') && !subpagesToVisit.includes(fullSub)) {
          subpagesToVisit.push(fullSub);
        }
      }
    });

    if (pageFound) {
      observations.push({requestedUrl:url,finalUrl:page.finalUrl,wrapperUrl,surface,required,outcome:'FOUND',retryable:false,httpStatus:200,detail:'Discord invite found in page link',observedAt:new Date().toISOString()});
      return { foundInvite: pageFound, details: logDetails.join('\n'),outcome:'FOUND',observations };
    }

    // Level 2 depth crawl for community subpages
    for (const subUrl of subpagesToVisit.slice(0, 3)) {
      logDetails.push(`Subpage crawl level 2: ${subUrl}`);
      const subPage = await fetchWithTimeout(subUrl, 1);
      if (subPage) {
        if (debugLog) debugLog.redirectsFollowed.push({ from: subUrl, to: subPage.finalUrl });
        const subFinalInv = extractDiscordInvite(subPage.finalUrl);
        if (debugLog) debugLog.discordRegexAttempts.push({ source: 'crawlExternalLinks_subPage_finalUrl', url: subPage.finalUrl, result: subFinalInv });
        if (subFinalInv) {
          logDetails.push(`Subpage redirect reached Discord invite: ${subPage.finalUrl} (Invite: ${subFinalInv})`);
          observations.push({requestedUrl:url,finalUrl:subPage.finalUrl,wrapperUrl,surface,required,outcome:'FOUND',retryable:false,httpStatus:200,detail:'Discord invite found on community subpage redirect',observedAt:new Date().toISOString()});
          return { foundInvite: subFinalInv, details: logDetails.join('\n'),outcome:'FOUND',observations };
        }
        const subInv = extractDiscordInvite(subPage.html);
        if (subInv) {
          logDetails.push(`Discord invite extracted from subpage ${subUrl} (Invite: ${subInv})`);
          observations.push({requestedUrl:url,finalUrl:subUrl,wrapperUrl,surface,required,outcome:'FOUND',retryable:false,httpStatus:200,detail:'Discord invite found on community subpage',observedAt:new Date().toISOString()});
          return { foundInvite: subInv, details: logDetails.join('\n'),outcome:'FOUND',observations };
        }
      }
    }
    observations.push({requestedUrl:url,finalUrl:page.finalUrl,wrapperUrl,surface,required,outcome:'INSPECTED_NO_MATCH',retryable:false,httpStatus:200,detail:'Page and bounded community links inspected without a Discord invite',observedAt:new Date().toISOString()});
  }

  logDetails.push(`Crawled ${scannedCount} external link(s). No Discord invite detected.`);
  const failed=observations.filter(item=>item.outcome==='ACQUISITION_FAILED').length,inspected=observations.filter(item=>item.outcome==='INSPECTED_NO_MATCH').length;
  const outcome:ExternalAcquisitionStatus=failed&&inspected?'PARTIALLY_INSPECTED':failed?'ACQUISITION_FAILED':'INSPECTED_NO_MATCH';
  return { foundInvite: null, details: logDetails.join('\n'),outcome,observations };
}

/**
 * Crawls social profile bios (Twitter/X, Instagram, TikTok).
 */
async function crawlSocialBios(
  socialUrls: string[],
  logDetails: string[] = [],
  debugLog?: any
): Promise<{foundInvite:string|null;foundLocation?:string;details:string;outcome:ExternalAcquisitionStatus;observations:ExternalAcquisitionObservation[]}> {
  // Social profiles use the same bounded acquisition contract as creator-owned
  // websites so an anti-bot response or timeout cannot become confirmed absence.
  return crawlExternalLinks(socialUrls,logDetails,debugLog);
}

/**
 * Web Scraping Fallback: Fetches recent video descriptions from a YouTube channel page.
 * Scrapes top 3 to 5 recent videos from the channel videos tab / watch links.
 */
export async function scrapeRecentVideoDescriptions(youtubeUrl: string): Promise<string[]> {
  return (await scrapeRecentVideoDescriptionsWithCoverage(youtubeUrl)).descriptions;
}
async function scrapeRecentVideoDescriptionsWithCoverage(youtubeUrl:string):Promise<{descriptions:string[];attempted:number;acquired:number}> {
  if (!youtubeUrl || !youtubeUrl.startsWith('http')) return {descriptions:[],attempted:0,acquired:0};
  const videosPageUrl = youtubeUrl.endsWith('/videos') ? youtubeUrl : `${youtubeUrl.replace(/\/+$/, '')}/videos`;
  const page = await fetchWithTimeout(videosPageUrl, 0);
  if (!page) throw new Error('Recent-video page acquisition failed');

    const html = page.html;

    const videoIdMatches = html.match(/\/watch\?v=([a-zA-Z0-9\-_]{11})/g) ||
                           html.match(/"videoId":"([a-zA-Z0-9\-_]{11})"/g) || [];

    const videoIds: string[] = [];
    for (const raw of videoIdMatches) {
      const m = raw.match(/([a-zA-Z0-9\-_]{11})/);
      if (m && m[1] && !videoIds.includes(m[1])) {
        videoIds.push(m[1]);
        if (videoIds.length >= 5) break;
      }
    }

    if (videoIds.length === 0) throw new Error('Recent-video page schema was not recognized; absence is not confirmed');

    const descriptions: string[] = [];
    let acquired=0;
    for (const vId of videoIds.slice(0, 5)) {
      const watchUrl = `https://www.youtube.com/watch?v=${vId}`;
      const vPage = await fetchWithTimeout(watchUrl, 0);
      if (vPage) {
        acquired++;
        const metaDesc = vPage.html.match(/<meta\s+name="description"\s+content="([^"]+)"/i) ||
                         vPage.html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i);
        
        let desc = metaDesc ? metaDesc[1] : '';
        const cleanVHtml = vPage.html.replace(/\\\/|\\u002f/gi, '/').replace(/\\u003a/gi, ':');
        
        const extInVid = extractExternalUrlsFromText(cleanVHtml);
        const invInVid = extractDiscordInvite(cleanVHtml);

        if (invInVid) {
          desc += ` https://discord.gg/${invInVid}`;
        }
        if (extInVid.length > 0) {
          desc += ` ${extInVid.join(' ')}`;
        }

        if (desc.trim()) {
          descriptions.push(desc.trim());
        }
      }
    }

  if(videoIds.length>0&&acquired===0)throw new Error('Recent-video descriptions could not be acquired');
  return {descriptions,attempted:videoIds.length,acquired};
}

/**
 * Live YouTube Channel Extractor
 * Scraping fallback to extract bio, external links, video descriptions, and thumbnail image directly from YouTube channel page.
 */
async function fetchLiveYouTubeChannelData(youtubeUrl: string, enableDebug?: boolean): Promise<{
  rawHtml?: string;
  fetchLog?: string;
  bio?: string;
  channelLinks?: string[];
  videoDescriptions?: string[];
  thumbnailUrl?: string;
} | null> {
  if (!youtubeUrl || !youtubeUrl.startsWith('http')) return null;

  const page = await fetchWithTimeout(youtubeUrl, 0);
  if (!page) return null;

  const html = page.html;
  const cleanHtml = html.replace(/\\\/|\\u002f/gi, '/').replace(/\\u003a/gi, ':');

  let thumbnailUrl: string | undefined;
  let bio: string | undefined;
  let explicitLinks: string[] = [];

  // Parse ytInitialData
  const match = html.match(/ytInitialData\s*=\s*({.*?});<\/script>/);
  if (match) {
    try {
      const ytData = JSON.parse(match[1]);
      
      // Extract Full Bio
      if (ytData.metadata?.channelMetadataRenderer?.description) {
        bio = ytData.metadata.channelMetadataRenderer.description;
      }
      
      if (ytData.metadata?.channelMetadataRenderer?.avatar?.thumbnails?.[0]?.url) {
        thumbnailUrl = ytData.metadata.channelMetadataRenderer.avatar.thumbnails[0].url;
      }

      // Recursively extract external links
      function extractLinks(obj: any) {
        if (typeof obj !== 'object' || obj === null) return;
        
        if (obj.channelExternalLinkViewModel?.link?.content) {
           explicitLinks.push(obj.channelExternalLinkViewModel.link.content);
        }
        
        if (obj.urlEndpoint?.url) {
           const url = obj.urlEndpoint.url;
           if (typeof url === 'string' && url.startsWith('http') && !url.includes('youtube.com/watch') && !url.includes('youtube.com/channel')) {
              explicitLinks.push(url);
           }
        }
        
        for (const key in obj) {
           extractLinks(obj[key]);
        }
      }
      extractLinks(ytData);
      
    } catch (e) {
      console.warn("Failed to parse ytInitialData", e);
    }
  }

  // Fallbacks
  if (!thumbnailUrl) {
    const ogImg = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i) ||
                   html.match(/<link\s+rel="image_src"\s+href="([^"]+)"/i);
    if (ogImg && ogImg[1]) {
      thumbnailUrl = ogImg[1];
    }
  }

  if (!bio) {
    const ogDesc = html.match(/<meta\s+name="description"\s+content="([^"]+)"/i) ||
                   html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i);
    if (ogDesc && ogDesc[1]) {
      bio = ogDesc[1];
    }
  }

  let extractedUrls = Array.from(new Set([...explicitLinks, ...extractExternalUrlsFromText(cleanHtml)]));

  return {
    bio,
    channelLinks: extractedUrls,
    thumbnailUrl,
    rawHtml: enableDebug ? cleanHtml : undefined,
    fetchLog: enableDebug ? `Fetched ${page.finalUrl} (${page.html.length} bytes)` : undefined
  };
}

/**
 * Runs the full 4-step Channel Inspection Engine with EARLY STOPPING and Detailed Audit Logs.
 */
export async function runChannelInspection(channelData: {
  enableDebug?: boolean;
  channelId: string;
  channelBio: string;
  channelLinks?: string[];
  pinnedComment?: string;
  videoDescriptions?: string[];
  socialLinks?: string[];
  youtubeUrl?: string;
  forceLiveFetch?: boolean;
  liveChannelDataLoader?: typeof fetchLiveYouTubeChannelData;
  externalFetchImpl?: typeof fetch;
}): Promise<InspectionResult> {
  const steps: InspectionStep[] = [];
  const now = new Date().toISOString();
  let extractedThumbnailUrl: string | undefined;
  const acquisitionOutcomes:ExternalAcquisitionObservation[]=[];
  let acquiredAboutUrl:string|undefined;
  const acquiredRecentDescriptionSurfaces:string[]=[];

  let debugLog: any = channelData.enableDebug ? {
    rawAboutPageHtml: null,
    fetchLog: null,
    extractedUrls: [],
    redirectsFollowed: [],
    discordRegexAttempts: [],
    failureStep: null
  } : undefined;

  let bio = channelData.channelBio || '';
  let links = channelData.channelLinks || [];
  let videoDescs = channelData.videoDescriptions || [];

  // Live YouTube Fetch & Video Descriptions Enrichment (3 to 5 videos)
  if (channelData.youtubeUrl || channelData.channelId) {
    if (channelData.youtubeUrl && (channelData.forceLiveFetch || links.length === 0 || bio.length < 20)) {
      try {
        if(!channelData.liveChannelDataLoader)await incrementQuota(25); // injected loaders are test/replay inputs, not provider calls
        const liveData = await (channelData.liveChannelDataLoader || fetchLiveYouTubeChannelData)(channelData.youtubeUrl, channelData.enableDebug);
        if (liveData) {
          acquiredAboutUrl=channelData.youtubeUrl;
          if (liveData.bio) bio = `${bio} ${liveData.bio}`.trim();
          if (liveData.channelLinks && liveData.channelLinks.length > 0) {
            links = Array.from(new Set([...links, ...liveData.channelLinks]));
          }
          if (liveData.thumbnailUrl) {
            extractedThumbnailUrl = liveData.thumbnailUrl;
          }
          if (debugLog) {
            debugLog.rawAboutPageHtml = liveData.rawHtml;
            debugLog.fetchLog = liveData.fetchLog;
          }
        } else acquisitionOutcomes.push({requestedUrl:channelData.youtubeUrl,surface:'YOUTUBE_ABOUT',required:true,outcome:'ACQUISITION_FAILED',retryable:true,failureClass:'YOUTUBE_ABOUT_ACQUISITION_FAILED',detail:'YouTube About page could not be acquired',observedAt:now});
      } catch (e) {
        acquisitionOutcomes.push({requestedUrl:channelData.youtubeUrl,surface:'YOUTUBE_ABOUT',required:true,outcome:'ACQUISITION_FAILED',retryable:true,failureClass:'YOUTUBE_ABOUT_ACQUISITION_FAILED',detail:e instanceof Error?e.message:String(e),observedAt:now});
        console.warn('Live YouTube channel scrape failed:', e);
      }
    }

    // EXPAND SEARCH DEPTH: Fetch 3 to 5 recent video descriptions via API or Web Scraper
    if (videoDescs.length < 5) {
      if (channelData.channelId) {
        try {
          const apiDescs = await fetchRecentVideoDescriptionsFromAPI(channelData.channelId);
          acquiredRecentDescriptionSurfaces.push(`youtube-api:channel:${channelData.channelId}:recent-video-descriptions`);
          if (apiDescs.length > 0) {
            videoDescs = Array.from(new Set([...videoDescs, ...apiDescs]));
          }
        } catch (e) {
          acquisitionOutcomes.push({requestedUrl:`youtube-api:channel:${channelData.channelId}:recent-video-descriptions`,surface:'RECENT_VIDEO_DESCRIPTIONS',required:true,outcome:'ACQUISITION_FAILED',retryable:true,failureClass:'RECENT_VIDEO_DESCRIPTION_API_FAILED',detail:e instanceof Error?e.message:String(e),observedAt:now});
          console.warn('API video descriptions fetch failed:', e);
        }
      }

      if (videoDescs.length < 5 && channelData.youtubeUrl) {
        try {
          const scraped=await scrapeRecentVideoDescriptionsWithCoverage(channelData.youtubeUrl),scrapedDescs=scraped.descriptions;
          acquiredRecentDescriptionSurfaces.push(`${channelData.youtubeUrl.replace(/\/+$/,'')}/videos`);
          if(scraped.acquired<scraped.attempted)acquisitionOutcomes.push({requestedUrl:`${channelData.youtubeUrl.replace(/\/+$/,'')}/videos`,surface:'RECENT_VIDEO_DESCRIPTIONS',required:true,outcome:'ACQUISITION_FAILED',retryable:true,failureClass:'RECENT_VIDEO_DESCRIPTION_PARTIAL',detail:`Acquired ${scraped.acquired} of ${scraped.attempted} sampled recent-video descriptions`,observedAt:now});
          if (scrapedDescs.length > 0) {
            videoDescs = Array.from(new Set([...videoDescs, ...scrapedDescs]));
          }
        } catch (e) {
          acquisitionOutcomes.push({requestedUrl:`${channelData.youtubeUrl.replace(/\/+$/,'')}/videos`,surface:'RECENT_VIDEO_DESCRIPTIONS',required:true,outcome:'ACQUISITION_FAILED',retryable:true,failureClass:'RECENT_VIDEO_DESCRIPTION_SCRAPE_FAILED',detail:e instanceof Error?e.message:String(e),observedAt:now});
          console.warn('Scraped video descriptions failed:', e);
        }
      }
    }
  }

  // --- HELPER FUNCTION FOR ADDING STEPS ---
  function addStep(
    stepName: InspectionStep['step'],
    title: string,
    status: InspectionStep['status'],
    detailsArr: string[],
    foundInvite: string | null = null,
    inviteLocation: string | undefined = undefined
  ) {
    steps.push({
      step: stepName,
      title,
      status,
      details: detailsArr.join('\n'),
      detectedInvite: foundInvite || undefined,
      inviteLocation: inviteLocation,
      timestamp: now
    });
    if (debugLog && status === 'NOT_FOUND' && !debugLog.failureStep) {
        debugLog.failureStep = stepName;
    }
  }

  // WE COLLECT ALL EXTERNAL URLS TO CRAWL LATER IN STEP 4 & 6
  let collectedExternalUrls: { url: string; wrapperUrl?:string; kind:'WEBSITE'|'SOCIAL'; contextMatches: boolean; source: string }[] = [];

  const checkContext = (text: string, url: string): boolean => {
    const contextKeywords = ['discord', 'community', 'join', 'trading floor', 'members', 'server'];
    const lowerText = text.toLowerCase();
    
    // Check if the URL is near these keywords (e.g., within 100 characters before or after)
    const urlIndex = lowerText.indexOf(url.toLowerCase());
    if (urlIndex === -1) return false;
    
    const start = Math.max(0, urlIndex - 100);
    const end = Math.min(lowerText.length, urlIndex + url.length + 100);
    const window = lowerText.substring(start, end);
    
    return contextKeywords.some(kw => window.includes(kw));
  };

  const addExternalUrls = (text: string, source: string) => {
    const urls = extractExternalUrlsFromText(text);
    if (debugLog) {
        debugLog.extractedUrls.push(...urls);
    }
    for (const url of urls) {
      const normalized=normalizeExternalUrl(url);
      if(normalized)collectedExternalUrls.push({ ...normalized, contextMatches: checkContext(text, url), source });
    }
  };

  for (const link of links) {
    if (link && typeof link === 'string') {
      if (debugLog) {
        debugLog.extractedUrls.push(link);
      }
      const normalized=normalizeExternalUrl(link);
      if(normalized)collectedExternalUrls.push({ ...normalized, contextMatches: false, source: 'CHANNEL_LINKS' });
    }
  }

  const discoveredCandidates:DiscordCandidate[]=[];
  const retainCandidates=(items:DiscordCandidate[])=>{for(const item of items)if(item.nativeInviteCode&&!discoveredCandidates.some(existing=>existing.candidateId===item.candidateId))discoveredCandidates.push(item);};

  // STEP 1 — Channel Bio & About Section
  const step1Logs: string[] = [];
  step1Logs.push(`Inspecting channel bio text (${bio.length} characters) and embedded links.`);
  const bioCandidates=extractDiscordCandidates(bio,'YOUTUBE_ABOUT',channelData.youtubeUrl),directBioInvite=bioCandidates.find(candidate=>candidate.nativeInviteCode)?.nativeInviteCode||null;
  
  if (debugLog) debugLog.discordRegexAttempts.push({ source: 'CHANNEL_ABOUT', textLength: bio.length, result: directBioInvite });

  addExternalUrls(bio, 'CHANNEL_ABOUT');

  if (directBioInvite) {
    step1Logs.push(`Direct Discord invite detected in Channel Bio: Invite Code "${directBioInvite}"`);
    addStep('BIO', 'Step 1 — Channel Bio & About Panel', 'FOUND', step1Logs, directBioInvite, 'CHANNEL_ABOUT');
    acquisitionOutcomes.push({requestedUrl:channelData.youtubeUrl||`youtube:channel:${channelData.channelId}`,surface:'YOUTUBE_ABOUT',required:true,outcome:'FOUND',retryable:false,detail:'Discord invite discovered in YouTube About content',observedAt:now});
    retainCandidates(bioCandidates);
  } else {
    if(acquiredAboutUrl)acquisitionOutcomes.push({requestedUrl:acquiredAboutUrl,surface:'YOUTUBE_ABOUT',required:true,outcome:'INSPECTED_NO_MATCH',retryable:false,detail:'YouTube About page acquired and inspected without a Discord invite',observedAt:now});
    step1Logs.push('No direct Discord invite found in channel bio.');
    addStep('BIO', 'Step 1 — Channel Bio & About Panel', 'NOT_FOUND', step1Logs);
  }

  // STEP 2 — Channel External Links
  // In the new pipeline, "Channel External Links" are checked for direct invites.
  // The actual crawling happens in step 5 & 6.
  const step2Logs: string[] = [];
  let foundInStep2 = false;
  if (links.length > 0) {
    step2Logs.push(`Scanning ${links.length} channel links.`);
    for (const link of links) {
      const linkCandidates=extractDiscordCandidates(link,'CHANNEL_EXTERNAL_LINKS',link),inv=linkCandidates.find(candidate=>candidate.nativeInviteCode)?.nativeInviteCode||null;
      if (debugLog) debugLog.discordRegexAttempts.push({ source: 'CHANNEL_LINKS', url: link, result: inv });
      if (inv) {
        step2Logs.push(`Direct Discord invite detected in channel links: ${link}`);
        addStep('EXTERNAL_LINKS', 'Step 2 — Channel External Links', 'FOUND', step2Logs, inv, 'CHANNEL_LINKS');
        acquisitionOutcomes.push({requestedUrl:link,surface:'CHANNEL_EXTERNAL_LINKS',required:true,outcome:'FOUND',retryable:false,detail:'Discord invite discovered in channel links',observedAt:now});
        const all=links.flatMap(item=>extractDiscordCandidates(item,'CHANNEL_EXTERNAL_LINKS',item)).filter(candidate=>candidate.nativeInviteCode);
        retainCandidates(all);break;
      }
    }
    step2Logs.push('No direct Discord invite found in channel links.');
    addStep('EXTERNAL_LINKS', 'Step 2 — Channel External Links', 'NOT_FOUND', step2Logs);
  } else {
    addStep('EXTERNAL_LINKS', 'Step 2 — Channel External Links', 'SKIPPED', ['No channel links found.']);
  }

  // STEP 3 — Latest 5 Video Descriptions
  const step3Logs: string[] = [];
  if (videoDescs.length > 0) {
    step3Logs.push(`Scanning ${videoDescs.length} recent video descriptions.`);
    for (let i = 0; i < Math.min(5, videoDescs.length); i++) {
      const d = videoDescs[i];
      const sourceName = `VIDEO_${i + 1}_DESCRIPTION`;
      addExternalUrls(d, sourceName);
      
      const descriptionCandidates=extractDiscordCandidates(d,'RECENT_VIDEO_DESCRIPTIONS',`youtube:channel:${channelData.channelId}:${sourceName}`),inv=descriptionCandidates.find(candidate=>candidate.nativeInviteCode)?.nativeInviteCode||null;
      if (debugLog) debugLog.discordRegexAttempts.push({ source: sourceName, textLength: d.length, result: inv });
      if (inv) {
        step3Logs.push(`Discord invite detected in ${sourceName}`);
        addStep('VIDEO_DESCRIPTIONS', 'Step 3 — Latest Video Descriptions', 'FOUND', step3Logs, inv, sourceName);
        acquisitionOutcomes.push({requestedUrl:`youtube:channel:${channelData.channelId}:${sourceName}`,surface:'RECENT_VIDEO_DESCRIPTIONS',required:true,outcome:'FOUND',retryable:false,detail:'Discord invite discovered in recent video description',observedAt:now});
        const all=videoDescs.slice(0,5).flatMap((text,index)=>extractDiscordCandidates(text,'RECENT_VIDEO_DESCRIPTIONS',`youtube:channel:${channelData.channelId}:VIDEO_${index+1}_DESCRIPTION`)).filter(candidate=>candidate.nativeInviteCode);
        retainCandidates(all);break;
      }
    }
    step3Logs.push('No direct Discord invite found in video descriptions.');
    addStep('VIDEO_DESCRIPTIONS', 'Step 3 — Latest Video Descriptions', 'NOT_FOUND', step3Logs);
  } else {
    addStep('VIDEO_DESCRIPTIONS', 'Step 3 — Latest Video Descriptions', 'SKIPPED', ['No video descriptions available.']);
  }
  for(const surface of acquiredRecentDescriptionSurfaces)acquisitionOutcomes.push({requestedUrl:surface,surface:'RECENT_VIDEO_DESCRIPTIONS',required:true,outcome:'INSPECTED_NO_MATCH',retryable:false,detail:'Recent video descriptions acquired and inspected without a Discord invite',observedAt:now});

  // Deduplicate and filter external URLs
  const uniqueUrls = new Map<string, { url: string; wrapperUrl?:string; kind:'WEBSITE'|'SOCIAL'; contextMatches: boolean; source: string }>();
  for (const item of collectedExternalUrls) {
    // Avoid re-processing the same URL, but keep contextMatches=true if any occurrence had it
    const existing = uniqueUrls.get(item.url);
    if (existing) {
      if (item.contextMatches) existing.contextMatches = true;
    } else {
      uniqueUrls.set(item.url, item);
    }
  }

  const allCollectedUrls = Array.from(uniqueUrls.values());

  let websiteUrls = allCollectedUrls.filter(u => u.kind==='WEBSITE');
  let socialBioUrls = allCollectedUrls.filter(u => u.kind==='SOCIAL');

  // Sort website URLs so contextMatches=true comes first
  websiteUrls.sort((a, b) => (a.contextMatches === b.contextMatches ? 0 : a.contextMatches ? -1 : 1));

  // STEP 4 — Linked Websites
  const step5Logs: string[] = [];
  if (websiteUrls.length > 0) {
    step5Logs.push(`Crawling ${websiteUrls.length} website URLs...`);
    for (const item of websiteUrls) {
      step5Logs.push(`[Crawling] ${item.url} (Context Match: ${item.contextMatches}, Source: ${item.source})`);
      
      const locName = item.url.includes('linktr.ee') ? 'LINKTREE' : 'CUSTOM_DOMAIN';

      const crawlRes = await crawlExternalLinks([item.url], [], debugLog,channelData.externalFetchImpl||fetch,'CREATOR_WEBSITES',false,item.wrapperUrl);
      acquisitionOutcomes.push(...crawlRes.observations);
      if (crawlRes.foundInvite) {
        step5Logs.push(`Discord invite found! ${crawlRes.details}`);
        addStep('CUSTOM_DOMAINS', 'Step 4 — Linked Websites', 'FOUND', step5Logs, crawlRes.foundInvite, locName);
        let candidates=extractDiscordCandidates(`${item.url}\n${crawlRes.details}`,'CREATOR_WEBSITES',item.url).filter(candidate=>candidate.nativeInviteCode);
        const alternative=extractDiscordCandidates(item.url,'CREATOR_WEBSITES',item.url).find(candidate=>candidate.locatorType==='ALTERNATIVE_REDIRECT'||candidate.locatorType==='DIRECTORY_PAGE');
        if(alternative&&candidates[0]?.nativeInviteCode){const {candidateId:_,...base}=alternative;candidates=[makeDiscordCandidate({...base,nativeInviteCode:candidates[0].nativeInviteCode,normalizedLocator:candidates[0].normalizedLocator,extractionConfidence:'RESOLVED'})];}
        retainCandidates(candidates);break;
      }
    }
    const websiteOutcomes=acquisitionOutcomes.filter(item=>item.surface==='CREATOR_WEBSITES');
    const failed=websiteOutcomes.some(item=>item.outcome==='ACQUISITION_FAILED'),inspected=websiteOutcomes.some(item=>item.outcome==='INSPECTED_NO_MATCH');
    step5Logs.push(failed?'Linked website acquisition was incomplete; absence of an invite is not confirmed.':'No Discord invite found in successfully inspected linked websites.');
    addStep('CUSTOM_DOMAINS', 'Step 4 — Linked Websites', failed?(inspected?'ERROR':'ERROR'):'NOT_FOUND', step5Logs);
  } else {
    addStep('CUSTOM_DOMAINS', 'Step 4 — Linked Websites', 'SKIPPED', ['No website URLs to crawl.']);
  }

  // STEP 5 — Linked Social Profile Bios
  const step6Logs: string[] = [];
  if (socialBioUrls.length > 0) {
    step6Logs.push(`Crawling ${socialBioUrls.length} social profile URLs...`);
    for (const item of socialBioUrls) {
      step6Logs.push(`[Crawling] ${item.url} (Source: ${item.source})`);
      
      let locName = 'SOCIAL_BIO';
      if (item.url.includes('twitter.com') || item.url.includes('x.com')) locName = 'X_BIO';
      if (item.url.includes('instagram.com')) locName = 'INSTAGRAM_BIO';
      if (item.url.includes('tiktok.com')) locName = 'TIKTOK_BIO';

      const crawlRes = await crawlExternalLinks([item.url], [], debugLog,channelData.externalFetchImpl||fetch,'SOCIAL_PROFILES',false,item.wrapperUrl);
      acquisitionOutcomes.push(...crawlRes.observations);
      if (crawlRes.foundInvite) {
        step6Logs.push(`Discord invite found! ${crawlRes.details}`);
        addStep('SOCIAL_BIO', 'Step 5 — Social Profile Bios', 'FOUND', step6Logs, crawlRes.foundInvite, locName);
        let candidates=extractDiscordCandidates(`${item.url}\n${crawlRes.details}`,'SOCIAL_PROFILES',item.url).filter(candidate=>candidate.nativeInviteCode);
        const alternative=extractDiscordCandidates(item.url,'SOCIAL_PROFILES',item.url).find(candidate=>candidate.locatorType==='ALTERNATIVE_REDIRECT'||candidate.locatorType==='DIRECTORY_PAGE');
        if(alternative&&candidates[0]?.nativeInviteCode){const {candidateId:_,...base}=alternative;candidates=[makeDiscordCandidate({...base,nativeInviteCode:candidates[0].nativeInviteCode,normalizedLocator:candidates[0].normalizedLocator,extractionConfidence:'RESOLVED'})];}
        retainCandidates(candidates);break;
      }
    }
    const failed=acquisitionOutcomes.some(item=>item.surface==='SOCIAL_PROFILES'&&item.outcome==='ACQUISITION_FAILED');
    step6Logs.push(failed?'Social profile acquisition was incomplete; absence of an invite is not confirmed.':'No Discord invite found in inspected social profile bios.');
    addStep('SOCIAL_BIO', 'Step 5 — Social Profile Bios', failed?'ERROR':'NOT_FOUND', step6Logs);
  } else {
    addStep('SOCIAL_BIO', 'Step 5 — Social Profile Bios', 'SKIPPED', ['No social profile URLs to crawl.']);
  }

  if (debugLog && !debugLog.failureStep) {
    debugLog.failureStep = 'ALL_EXHAUSTED';
  }

  // Required YouTube coverage controls whether absence can be confirmed. Optional
  // website/social failures remain observable and retryable without contaminating
  // successfully inspected required surfaces.
  const required=acquisitionOutcomes.filter(item=>item.required);
  const requiredSurfaces=[...new Set(required.map(item=>item.surface))];
  const failed=requiredSurfaces.some(surface=>{
    const outcomes=required.filter(item=>item.surface===surface);
    return outcomes.some(item=>item.outcome==='ACQUISITION_FAILED')&&!outcomes.some(item=>item.outcome==='INSPECTED_NO_MATCH'||item.outcome==='FOUND');
  });
  const inspected=required.some(item=>item.outcome==='INSPECTED_NO_MATCH');
  const acquisitionStatus:ExternalAcquisitionStatus=failed&&inspected?'PARTIALLY_INSPECTED':failed?'ACQUISITION_FAILED':'INSPECTED_NO_MATCH';
  return { foundInvite: discoveredCandidates[0]?.nativeInviteCode||null,foundLocation:discoveredCandidates[0]?.sourceUrl?.match(/VIDEO_\d+_DESCRIPTION/)?.[0]||discoveredCandidates[0]?.sourceSurface, steps, extractedThumbnailUrl, debugLog, observedAboutBio:bio, observedChannelLinks:links,acquisitionStatus:discoveredCandidates.length?'FOUND':acquisitionStatus,acquisitionOutcomes,discordCandidates:discoveredCandidates };
}
