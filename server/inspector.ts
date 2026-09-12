import * as cheerio from 'cheerio';
import { decodeEmbeddedMarkup, extractDynamicTargetValues, extractEmbeddedUrls, extractYouTubeVideoIds } from './crawlerExtraction';
import { InspectionStep } from '../src/types';
import { getChannelById } from './db';
import { fetchRecentVideoDescriptionsWithIds, type RecentVideoDescription } from './youtube';
import {candidateFromNativeInvite,extractDiscordCandidates,makeDiscordCandidate,mergeDiscordCandidates,type DiscordCandidate} from './discordCandidates';
import type { BrowserFallbackResult } from './browserCommunityFallback';
import {effectiveAcquisitionOutcomes,hasMessagingBridgeEvidence,isDiscordCommunityAcquisitionSurface,isDotlessHostnameUrl,isMessagingPreviewUrl,isAuxiliaryTriageCandidate,rankCommunitySurfaces,scoreCommunitySurface} from './communitySurfacePolicy';
import {clampRetryAtTimestamp, communityAcquisitionRetryDirective, retryAtFromUnknown, type CommunityRetryDirective} from './communityRetryPolicy';
import {renderedCrawlerTelemetry, staticCrawlerTelemetry, createDropCounter, type CrawlerTelemetry, type CeilingKind} from './crawlerTelemetry';
import {fetchUrlFailureHistory, skippedUrlsFromHistory, normalizeSkipUrl, type UrlFailureRow} from './crawlUrlSkipPolicy';
import { readBoundedResponseText } from './crawlResponseBounds';

export type SampledVideoInput =
  | string
  | { videoId?: string | null; description?: string | null }
  | null
  | undefined;

/** Normalize a mixed loader/scrape sample to trimmed, non-empty (id, text) pairs. */
export function normalizeSampledVideoDescriptions(
  input: SampledVideoInput[] | null | undefined
): RecentVideoDescription[] {
  const out: RecentVideoDescription[] = [];
  for (const entry of input || []) {
    if (typeof entry === 'string') {
      const description = entry.trim();
      if (description) out.push({ videoId: null, description });
    } else if (entry && typeof entry === 'object') {
      const description = String(entry.description || '').trim();
      if (!description) continue;
      out.push({ videoId: entry.videoId ? String(entry.videoId) : null, description });
    }
  }
  return out;
}

/**
 * Merge channel-sampled descriptions by video. Entries carrying the same
 * video ID represent one upload observed twice (API + keyless scrape with
 * different encoding, truncation, or appended links), so the first text wins
 * and the duplicate never votes. ID-less entries keep exact-text dedupe.
 * Distinct videos with identical text still count separately. Order-preserving.
 */
export function mergeSampledVideoDescriptions(
  current: RecentVideoDescription[],
  incoming: RecentVideoDescription[]
): RecentVideoDescription[] {
  const seenIds = new Set(
    current.filter(item => item.videoId).map(item => item.videoId as string)
  );
  const seenTexts = new Set(current.filter(item => !item.videoId).map(item => item.description));
  const merged = [...current];
  for (const item of incoming) {
    if (item.videoId) {
      if (seenIds.has(item.videoId)) continue;
      seenIds.add(item.videoId);
      merged.push(item);
    } else {
      if (seenTexts.has(item.description)) continue;
      seenTexts.add(item.description);
      merged.push(item);
    }
  }
  return merged;
}

export interface InspectionResult {
  debugLog?: any;
  foundInvite: string | null;
  foundLocation?: string;
  steps: InspectionStep[];
  extractedThumbnailUrl?: string;
  observedAboutBio: string;
  observedChannelLinks: string[];
  /**
   * Fresh channel-sampled video descriptions acquired during THIS inspection
   * (recent-uploads API fetch and/or channel /videos scrape, newest first,
   * capped at 10). Preloaded search-selected snippets are deliberately
   * EXCLUDED: only independently-sampled recent-channel output may feed the
   * aggregated-content-language country voter downstream.
   */
  observedVideoDescriptions?: string[];
  /**
   * True when observedVideoDescriptions holds at least one channel-sampled
   * description (authoritative provenance for the country voter). False or
   * absent means no fresh sample was acquired and the country voter must
   * abstain rather than evaluate stale/search-selected input.
   */
  observedVideoDescriptionsAuthoritative?: boolean;
  acquisitionStatus?: ExternalAcquisitionStatus;
  acquisitionOutcomes?: ExternalAcquisitionObservation[];
  retryDirective?: CommunityRetryDirective;
  discordCandidates?: DiscordCandidate[];
}
export type ExternalAcquisitionStatus='FOUND'|'INSPECTED_NO_MATCH'|'PARTIALLY_INSPECTED'|'ACQUISITION_FAILED';
export type AcquisitionSurface='YOUTUBE_ABOUT'|'RECENT_VIDEO_DESCRIPTIONS'|'CHANNEL_EXTERNAL_LINKS'|'CREATOR_WEBSITES'|'SOCIAL_PROFILES'|'DISCORD_VALIDATION';
export interface ExternalAcquisitionObservation {requestedUrl:string;finalUrl?:string;wrapperUrl?:string;surface:AcquisitionSurface;required:boolean;outcome:ExternalAcquisitionStatus;retryable:boolean;httpStatus?:number;failureClass?:string;retryAt?:number;detail:string;observedAt:string;telemetry?:CrawlerTelemetry;rootUrl?:string}

export interface NormalizedExternalUrl {url:string;wrapperUrl?:string;kind:'WEBSITE'|'SOCIAL'|'MESSAGING'}
const socialHosts=new Set(['twitter.com','www.twitter.com','x.com','www.x.com','instagram.com','www.instagram.com','tiktok.com','www.tiktok.com','facebook.com','www.facebook.com']);
const directDiscordHosts=new Set(['discord.gg','www.discord.gg','discord.com','www.discord.com','discordapp.com','www.discordapp.com','discord.app','www.discord.app']);
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
    if(directDiscordHosts.has(host))return null;
    parsed.hash='';
    for(const key of [...parsed.searchParams.keys()])if(/^utm_|^(fbclid|gclid|ref|feature)$/i.test(key))parsed.searchParams.delete(key);
    parsed.hostname=host;parsed.pathname=parsed.pathname.replace(/\/$/,'')||'/';
    // Messaging previews (Telegram/WhatsApp) are never ordinary websites: they
    // use the lightweight MESSAGING_PREVIEW path (static-only by default, render
    // only on bridge evidence). This is classification, not a blacklist — every
    // messaging URL is still attempted.
    const kind=isMessagingPreviewUrl(parsed.toString())?'MESSAGING':socialHosts.has(host)?'SOCIAL':'WEBSITE';
    return {url:parsed.toString(),wrapperUrl,kind};
  }catch{return null;}
}

export function extractDiscordInvite(text: string): string | null {
  return extractDiscordCandidates(text).find(candidate=>candidate.nativeInviteCode)?.nativeInviteCode||null;
}

export function extractExternalUrlsFromText(text: string): string[] {
  if (!text) return [];
  const clean = decodeEmbeddedMarkup(text);
  const matches = extractEmbeddedUrls(clean);
  const results: string[] = [];
  for (let m of matches) {
    m = m.replace(/[\.,\)\;\:\>\<"]+$/, '');
    const lowerM = m.toLowerCase();
    if (!lowerM.includes('youtube.com')&&!lowerM.includes('youtu.be')&&!lowerM.includes('google.com')&&!lowerM.includes('googleusercontent.com')&&!lowerM.includes('ggpht.com')&&!lowerM.includes('gstatic.com')&&!lowerM.includes('doubleclick.net')&&!lowerM.includes('googlesyndication.com')&&!lowerM.includes('schema.org')&&!lowerM.includes('w3.org')&&!lowerM.includes('googleapis.com')&&!lowerM.includes('googlevideo.com')&&!lowerM.includes('ytimg.com')&&!/\.(png|jpg|jpeg|gif|webp|svg|css|js|wasm|ico|woff|woff2|ttf|eot)(\?.*)?$/i.test(m)) {
      if (!results.includes(m)) results.push(m);
    }
  }
  return results;
}

async function fetchWithTimeout(url: string, depth = 0): Promise<{ html: string; finalUrl: string; truncated: boolean } | null> {
  if (depth > 2) return null;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {signal:controller.signal,headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36','Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8','Accept-Language':'en-US,en;q=0.5'},redirect:'follow'});
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('json') && !contentType.includes('plain')) return null;
    const bounded = await readBoundedResponseText(res);
    return { html: bounded.text, finalUrl: res.url, truncated: bounded.truncated };
  } catch { return null; }
  finally { clearTimeout(id); }
}

const COMMUNITY_PATH_HINTS = ['discord','community','join','chat','member','membership','vip','group','private','trading-room','trading-floor','room','links','resources','social','contact','about'];
const CROSS_DOMAIN_COMMUNITY_HOSTS = new Set(['linktr.ee','www.linktr.ee','beacons.ai','www.beacons.ai','bio.link','www.bio.link','solo.to','www.solo.to','campsite.bio','www.campsite.bio','lnk.bio','www.lnk.bio','skool.com','www.skool.com','whop.com','www.whop.com','circle.so','www.circle.so','patreon.com','www.patreon.com']);
export function communityNavigationScore(href:string,label:string):number {const haystack=`${href} ${label}`.toLowerCase();let score=0;for(const hint of COMMUNITY_PATH_HINTS)if(haystack.includes(hint))score+=hint==='discord'?100:hint==='community'||hint==='join'?50:10;return score;}
export function shouldFollowCommunityTarget(url:string,_label:string):boolean {try{return CROSS_DOMAIN_COMMUNITY_HOSTS.has(new URL(url).hostname.toLowerCase());}catch{return false;}}

async function fetchExternalPage(url:string,fetchImpl:typeof fetch):Promise<{page:{html:string;finalUrl:string;truncated:boolean}|null;observation?:Omit<ExternalAcquisitionObservation,'surface'|'required'|'observedAt'|'wrapperUrl'>}> {
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  try{
    const response=await fetchImpl(url,{signal:controller.signal,headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36','Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8','Accept-Language':'en-US,en;q=0.5'},redirect:'follow'});
    const contentType=response.headers.get('content-type')||'';
    if(!response.ok){const retryable=response.status===429||response.status>=500,retryAfter=response.headers.get('retry-after')||'',retryAfterSeconds=Number(retryAfter),retryAt=retryable?(Number.isFinite(retryAfterSeconds)?clampRetryAtTimestamp(Date.now()+Math.max(0,retryAfterSeconds*1000)):clampRetryAtTimestamp(Date.parse(retryAfter)||undefined)):undefined;return {page:null,observation:{requestedUrl:url,finalUrl:response.url||url,outcome:'ACQUISITION_FAILED',retryable,httpStatus:response.status,failureClass:response.status===429?'RATE_LIMIT':response.status>=500?'TRANSIENT_HTTP':'HTTP_ERROR',retryAt,detail:`HTTP ${response.status}`}};}
    if(!contentType.includes('text/html')&&!contentType.includes('json')&&!contentType.includes('plain'))return {page:null,observation:{requestedUrl:url,finalUrl:response.url||url,outcome:'ACQUISITION_FAILED',retryable:false,httpStatus:response.status,failureClass:'UNSUPPORTED_CONTENT_TYPE',detail:`Unsupported content type ${contentType||'unknown'}`}};
    const bounded=await readBoundedResponseText(response);
    return {page:{html:bounded.text,finalUrl:response.url||url,truncated:bounded.truncated}};
  }catch(error:any){const timeout=error?.name==='AbortError';return {page:null,observation:{requestedUrl:url,outcome:'ACQUISITION_FAILED',retryable:true,failureClass:timeout?'TIMEOUT':'NETWORK_FAILURE',detail:String(error?.message||error)}};}
  finally { clearTimeout(timer); }
}

export interface ExternalDiscordCrawlResult {foundInvite:string|null;foundLocation?:string;details:string;outcome:ExternalAcquisitionStatus;observations:ExternalAcquisitionObservation[];candidates:DiscordCandidate[]}

function preserveResolvedWrapperProvenance(wrapperCandidate:DiscordCandidate,nativeCandidates:DiscordCandidate[]):DiscordCandidate[]{
  return nativeCandidates.map(native=>{
    if(!native.nativeInviteCode)return native;
    const {candidateId:_,canonicalInviteId:__,ownershipStatus:___,ownershipConfidence:____,ownershipReasons:_____,...base}=wrapperCandidate;
    return makeDiscordCandidate({...base,nativeInviteCode:native.nativeInviteCode,normalizedLocator:`https://discord.gg/${native.nativeInviteCode}`,sourceUrl:native.sourceUrl||wrapperCandidate.sourceUrl,extractionConfidence:'RESOLVED',observations:[...(wrapperCandidate.observations||[]),...(native.observations||[])]});
  });
}

/** Bounded static acquisition that retains every Discord candidate observed
 * within the page budget. A first invite is evidence, not a stop condition. */
export async function crawlExternalLinks(links:string[],logDetails:string[]=[],debugLog?:any,fetchImpl:typeof fetch=fetch,surface:AcquisitionSurface='CREATOR_WEBSITES',required=false,wrapperUrl?:string):Promise<ExternalDiscordCrawlResult>{
  let scannedCount=0;const observations:ExternalAcquisitionObservation[]=[];const discovered:DiscordCandidate[]=[];
  for(const rawUrl of links){
    if(!rawUrl||typeof rawUrl!=='string')continue;let url=rawUrl.trim();if(!url.startsWith('http://')&&!url.startsWith('https://'))url=`https://${url}`;
    scannedCount++;logDetails.push(`[Link #${scannedCount}] Inspecting target: ${url}`);const beforeSeed=discovered.length;
    // Per-URL failure isolation: any unexpected throw for one candidate must
    // never terminate acquisition for the remaining candidates (recall-safe
    // continuation; PR #434 items 1-2).
    try{
    const seedLocators=extractDiscordCandidates(url,surface,url);const direct=seedLocators.filter(candidate=>candidate.nativeInviteCode);const wrapperCandidate=seedLocators.find(candidate=>candidate.locatorType==='ALTERNATIVE_REDIRECT'||candidate.locatorType==='DIRECTORY_PAGE');
    discovered.push(...direct);
    if(debugLog)debugLog.discordRegexAttempts.push({source:'crawlExternalLinks_direct',url,result:direct.map(c=>c.nativeInviteCode)});
    if(direct.length){observations.push({requestedUrl:url,finalUrl:url,wrapperUrl,surface,required,rootUrl:url,outcome:'FOUND',retryable:false,detail:`${direct.length} direct Discord candidate(s) in URL`,observedAt:new Date().toISOString(),telemetry:staticCrawlerTelemetry({redirectsFollowed:0,pagesInspected:0})});continue;}

    let pagesInspected=0,redirectsFollowed=0,seedCeiling:CeilingKind|undefined;
    // First ceiling wins: the first cap encountered is what first cut
    // coverage short (later caps are moot for the truncated remainder).
    // dropReasons counters retain every occurrence, so no information about
    // subsequent caps is lost — only the single kind label is first-wins.
    // Per-seed drop accounting (compact ints only): tells future
    // investigations exactly which enqueue rule discarded candidate URLs.
    const drops=createDropCounter();
    const acquired=await fetchExternalPage(url,fetchImpl),page=acquired.page;if(acquired.observation)observations.push({...acquired.observation,wrapperUrl,surface,required,rootUrl:url,observedAt:new Date().toISOString(),telemetry:staticCrawlerTelemetry({redirectsFollowed,pagesInspected})});
    // A truncated prefix is incomplete coverage, never a complete inspection:
    // force the partial path so a cut-off response can never resolve a
    // definitive clean negative for this seed.
    let truncatedResponse=page?.truncated===true;if(truncatedResponse){seedCeiling??='response-cap';drops.count('response-cap');}
    if(debugLog&&page)debugLog.redirectsFollowed.push({from:url,to:page.finalUrl});if(page&&page.finalUrl!==url)redirectsFollowed++;if(!page){logDetails.push(`Failed or timed out trying to reach external URL: ${url}`);continue;}

    const inspectPage=(current:{html:string;finalUrl:string},depth:number):Array<{url:string;score:number}>=>{
      pagesInspected++;logDetails.push(`Successfully loaded ${current.finalUrl} (${current.html.length} bytes, depth ${depth})`);
      discovered.push(...extractDiscordCandidates(`${current.finalUrl}\n${current.html}`,surface,current.finalUrl).filter(candidate=>candidate.nativeInviteCode));
      const $=cheerio.load(current.html),navigation:Array<{url:string;score:number}>=[];
      $('a[href]').each((_,el)=>{const href=($(el).attr('href')||'').trim(),label=$(el).text().trim();if(!href)return;const anchorCandidates=extractDiscordCandidates(`${href} ${label}`,surface,current.finalUrl).filter(candidate=>candidate.nativeInviteCode);if(anchorCandidates.length){for(const candidate of anchorCandidates){candidate.observations=(candidate.observations||[]).map(obs=>({...obs,sourceAnchorText:label,sourcePageDepth:depth}));discovered.push(candidate);}return;}try{const absolute=new URL(href,current.finalUrl),origin=new URL(current.finalUrl);absolute.hash='';if(!['http:','https:'].includes(absolute.protocol)){drops.countUnique('invalid-protocol',href);return;}const crossOrigin=absolute.origin!==origin.origin;if(crossOrigin&&!shouldFollowCommunityTarget(absolute.toString(),label)){drops.countUnique('cross-origin-disallowed',absolute.toString());return;}const score=communityNavigationScore(absolute.pathname+absolute.search,label)+(CROSS_DOMAIN_COMMUNITY_HOSTS.has(absolute.hostname.toLowerCase())?40:0);if(score<=0){drops.countUnique('score-zero',absolute.toString());return;}navigation.push({url:absolute.toString(),score});}catch{drops.countUnique('invalid-protocol',href);}});
      for(const rawTarget of extractDynamicTargetValues(current.html)){const target=rawTarget.trim();const targetCandidates=extractDiscordCandidates(target,surface,current.finalUrl).filter(candidate=>candidate.nativeInviteCode);if(targetCandidates.length){discovered.push(...targetCandidates);continue;}try{const absolute=new URL(target,current.finalUrl),origin=new URL(current.finalUrl);absolute.hash='';if(!['http:','https:'].includes(absolute.protocol)){drops.countUnique('invalid-protocol',target);continue;}const crossOriginTarget=absolute.origin!==origin.origin;if(crossOriginTarget&&!shouldFollowCommunityTarget(absolute.toString(),target)){drops.countUnique('cross-origin-disallowed',absolute.toString());continue;}const score=communityNavigationScore(absolute.pathname+absolute.search,target)+(CROSS_DOMAIN_COMMUNITY_HOSTS.has(absolute.hostname.toLowerCase())?40:0);if(score<=0){drops.countUnique('score-zero',absolute.toString());continue;}navigation.push({url:absolute.toString(),score});}catch{drops.countUnique('invalid-protocol',target);}}navigation.sort((a,b)=>b.score-a.score);return navigation;
    };

    const firstNavigation=inspectPage(page,0);const visited=new Set<string>([page.finalUrl,url]);// Deduplicate eligible navigation targets (keeping the best score) BEFORE
    // the queue bound: duplicate URLs must never consume budget while unique
    // eligible targets are dropped. Truncation of eligible uniques is itself
    // incomplete coverage.
    const dedupedNavigation=(()=>{const best=new Map<string,{url:string;score:number}>();for(const item of firstNavigation){const prior=best.get(item.url);if(!prior||item.score>prior.score)best.set(item.url,item);}return [...best.values()];})();const duplicateDropped=Math.max(0,firstNavigation.length-dedupedNavigation.length);if(duplicateDropped>0)drops.count('duplicate',duplicateDropped);if(dedupedNavigation.length>12)seedCeiling??='queue-cap';const droppedByCap=Math.max(0,dedupedNavigation.length-12);if(droppedByCap>0)drops.count('queue-cap',droppedByCap);const queue=dedupedNavigation.slice(0,12).map(item=>({...item,depth:1}));let explored=0;
    while(queue.length&&explored<12){queue.sort((a,b)=>b.score-a.score);const next=queue.shift()!;if(next.depth>2){seedCeiling??='depth-limit';drops.count('depth-limit');continue;}if(visited.has(next.url)){drops.count('already-visited');continue;}visited.add(next.url);explored++;logDetails.push(`Prioritized website crawl depth ${next.depth}: ${next.url}`);const subAcquired=await fetchExternalPage(next.url,fetchImpl),subPage=subAcquired.page;if(subAcquired.observation)observations.push({...subAcquired.observation,wrapperUrl,surface,required,rootUrl:url,observedAt:new Date().toISOString(),telemetry:staticCrawlerTelemetry({redirectsFollowed,pagesInspected,ceiling:subPage?.truncated?'response-cap':undefined})});if(!subPage)continue;if(subPage.truncated){truncatedResponse=true;seedCeiling??='response-cap';drops.count('response-cap');}if(debugLog)debugLog.redirectsFollowed.push({from:next.url,to:subPage.finalUrl});if(subPage.finalUrl!==next.url)redirectsFollowed++;const children=inspectPage(subPage,next.depth);if(next.depth>=2){const unvisitedChildren=children.filter(child=>!visited.has(child.url));if(unvisitedChildren.length>0){seedCeiling??='depth-limit';drops.count('depth-limit',unvisitedChildren.length);}}else for(const child of children)if(!visited.has(child.url))queue.push({...child,depth:next.depth+1});}
    if(queue.some(item=>!visited.has(item.url)))seedCeiling??='exploration-limit';const leftoverUnvisited=queue.filter(item=>!visited.has(item.url)).length;if(leftoverUnvisited>0)drops.count('exploration-limit',leftoverUnvisited);
    if(wrapperCandidate){const nativeForSeed=discovered.slice(beforeSeed).filter(candidate=>candidate.nativeInviteCode);if(nativeForSeed.length){discovered.splice(beforeSeed,discovered.length-beforeSeed,...preserveResolvedWrapperProvenance(wrapperCandidate,nativeForSeed));}}
    const foundForSeed=discovered.length>beforeSeed;const seedOutcome:ExternalAcquisitionStatus=foundForSeed?'FOUND':seedCeiling?'PARTIALLY_INSPECTED':'INSPECTED_NO_MATCH';observations.push({requestedUrl:url,finalUrl:page.finalUrl,wrapperUrl,surface,required,rootUrl:url,outcome:seedOutcome,retryable:false,httpStatus:200,detail:foundForSeed?`Discord candidate(s) retained while inspecting root plus ${explored} prioritized page(s)`:seedCeiling?`Root plus ${explored} prioritized page(s) inspected without a Discord invite; crawl budget exhausted before full coverage${truncatedResponse?'; response truncated at the bounded-response cap before full coverage':''}`:`Root page plus ${explored} prioritized same-origin community/navigation page(s) inspected without a Discord invite`,observedAt:new Date().toISOString(),telemetry:staticCrawlerTelemetry({redirectsFollowed,pagesInspected,ceiling:seedCeiling,dropReasons:drops.snapshot()})});
    }catch(error:any){logDetails.push(`Isolated acquisition error for ${String(rawUrl)}: ${error instanceof Error?error.message:String(error)}; continuing to next candidate.`);observations.push({requestedUrl:String(rawUrl||'unknown'),wrapperUrl,surface,required,rootUrl:String(rawUrl||'unknown'),outcome:'ACQUISITION_FAILED',retryable:true,failureClass:'ISOLATED_ACQUISITION_ERROR',detail:`Per-URL failure isolated; remaining candidates continue: ${error instanceof Error?error.message:String(error)}`,observedAt:new Date().toISOString(),telemetry:staticCrawlerTelemetry({redirectsFollowed:0,pagesInspected:0})});continue;}
  }
  const candidates=mergeDiscordCandidates(discovered);const failed=observations.filter(item=>item.outcome==='ACQUISITION_FAILED').length,inspected=observations.filter(item=>item.outcome==='INSPECTED_NO_MATCH').length,partial=observations.filter(item=>item.outcome==='PARTIALLY_INSPECTED').length,found=observations.some(item=>item.outcome==='FOUND');const outcome:ExternalAcquisitionStatus=found?'FOUND':(failed&&inspected)||partial>0?'PARTIALLY_INSPECTED':failed?'ACQUISITION_FAILED':'INSPECTED_NO_MATCH';
  logDetails.push(`Crawled ${scannedCount} external link(s); retained ${candidates.length} distinct Discord candidate(s).`);
  return {foundInvite:candidates[0]?.nativeInviteCode||null,foundLocation:candidates[0]?.sourceUrl,details:logDetails.join('\n'),outcome,observations,candidates};
}

/**
 * Lightweight MESSAGING_PREVIEW acquisition (PR #434 items 3-4). Telegram /
 * WhatsApp previews are statically fetched exactly once (no child crawl, no
 * default Playwright): Discord invites in the server-rendered preview are
 * captured statically, and only static bridge evidence (`discord` mention
 * without an extractable invite, suggesting JS-hidden content) justifies
 * escalation. This is classification, never a blacklist — every messaging URL
 * is attempted and legitimate discovery paths are preserved. A *failed*
 * preview acquisition is recorded `required:true` so it contributes to
 * incomplete community acquisition (and COMMUNITY retry classification) rather
 * than collapsing into a clean no-match; successful static previews stay
 * `required:false` static-first.
 */
export async function crawlMessagingPreview(seedUrl:string,logDetails:string[]=[],debugLog?:any,fetchImpl:typeof fetch=fetch,surface:AcquisitionSurface='CREATOR_WEBSITES',wrapperUrl?:string):Promise<ExternalDiscordCrawlResult & {bridgeEvidence:boolean;previewHtmlLength:number;truncated:boolean}>{
  const observedAt=new Date().toISOString();
  const seedLocators=extractDiscordCandidates(seedUrl,surface,seedUrl);
  const direct=seedLocators.filter(candidate=>candidate.nativeInviteCode);
  if(direct.length){
    if(debugLog)debugLog.discordRegexAttempts.push({source:'crawlMessagingPreview_direct',url:seedUrl,result:direct.map(c=>c.nativeInviteCode)});
    return {foundInvite:direct[0].nativeInviteCode||null,foundLocation:seedUrl,details:`[Messaging preview] ${direct.length} direct Discord candidate(s) in URL: ${seedUrl}`,outcome:'FOUND',observations:[{requestedUrl:seedUrl,finalUrl:seedUrl,wrapperUrl,surface,required:false,outcome:'FOUND',retryable:false,detail:`${direct.length} direct Discord candidate(s) in messaging URL`,observedAt,telemetry:staticCrawlerTelemetry({redirectsFollowed:0,pagesInspected:0})}],candidates:mergeDiscordCandidates(direct),bridgeEvidence:false,previewHtmlLength:0,truncated:false};
  }
  let acquired:Awaited<ReturnType<typeof fetchExternalPage>>;
  try{
    acquired=await fetchExternalPage(seedUrl,fetchImpl);
  }catch(error:any){
    return {foundInvite:null,details:`[Messaging preview] Isolated fetch error for ${seedUrl}; continuing.`,outcome:'ACQUISITION_FAILED',observations:[{requestedUrl:seedUrl,wrapperUrl,surface,required:true,outcome:'ACQUISITION_FAILED',retryable:true,failureClass:'ISOLATED_ACQUISITION_ERROR',detail:`Messaging preview fetch isolated: ${error instanceof Error?error.message:String(error)}`,observedAt,telemetry:staticCrawlerTelemetry({redirectsFollowed:0,pagesInspected:0})}],candidates:[],bridgeEvidence:false,previewHtmlLength:0,truncated:false};
  }
  if(acquired.observation){
    logDetails.push(`[Messaging preview] Static preview unavailable for ${seedUrl}: ${acquired.observation.detail}`);
    return {foundInvite:null,details:logDetails.join('\n'),outcome:'ACQUISITION_FAILED',observations:[{...acquired.observation,wrapperUrl,surface,required:true,observedAt,telemetry:staticCrawlerTelemetry({redirectsFollowed:0,pagesInspected:0})}],candidates:[],bridgeEvidence:false,previewHtmlLength:0,truncated:false};
  }
  const page=acquired.page!;
  if(debugLog)debugLog.redirectsFollowed.push({from:seedUrl,to:page.finalUrl});
  let found:DiscordCandidate[]=[];
  try{
    found=extractDiscordCandidates(`${page.finalUrl}\n${page.html}`,surface,page.finalUrl).filter(candidate=>candidate.nativeInviteCode);
  }catch(error:any){
    logDetails.push(`[Messaging preview] Isolated parse error for ${seedUrl}; continuing.`);
    return {foundInvite:null,details:logDetails.join('\n'),outcome:'ACQUISITION_FAILED',observations:[{requestedUrl:seedUrl,finalUrl:page.finalUrl,wrapperUrl,surface,required:true,outcome:'ACQUISITION_FAILED',retryable:true,failureClass:'ISOLATED_ACQUISITION_ERROR',detail:`Messaging preview parse isolated: ${error instanceof Error?error.message:String(error)}`,observedAt,telemetry:staticCrawlerTelemetry({redirectsFollowed:0,pagesInspected:1})}],candidates:[],bridgeEvidence:false,previewHtmlLength:page.html.length,truncated:page.truncated===true};
  }
  if(debugLog)debugLog.discordRegexAttempts.push({source:'crawlMessagingPreview_html',url:page.finalUrl,result:found.map(c=>c.nativeInviteCode)});
  if(found.length){
    const candidates=mergeDiscordCandidates(found);
    return {foundInvite:candidates[0]?.nativeInviteCode||null,foundLocation:candidates[0]?.sourceUrl,details:`[Messaging preview] Retained ${candidates.length} Discord candidate(s) statically from ${page.finalUrl} (${page.html.length} bytes, 0 Playwright launches).`,outcome:'FOUND',observations:[{requestedUrl:seedUrl,finalUrl:page.finalUrl,wrapperUrl,surface,required:false,outcome:'FOUND',retryable:false,httpStatus:200,detail:`${candidates.length} Discord candidate(s) statically retained from messaging preview`,observedAt,telemetry:staticCrawlerTelemetry({redirectsFollowed:page.finalUrl!==seedUrl?1:0,pagesInspected:1,ceiling:page.truncated===true?'response-cap':undefined})}],candidates,bridgeEvidence:false,previewHtmlLength:page.html.length,truncated:page.truncated===true};
  }
  const bridgeEvidence=hasMessagingBridgeEvidence(page.html);
  const truncated=page.truncated===true;
  logDetails.push(`[Messaging preview] Static preview of ${page.finalUrl} (${page.html.length} bytes) contains no Discord invite${truncated?'; response truncated at the bounded-response cap before full coverage':''}${bridgeEvidence?'; bridge evidence present, rendered escalation justified':'; no bridge evidence, 0 Playwright launches'}.`);
  // A truncated prefix is incomplete coverage: it stays retry-owned and
  // partial so it can never resolve a definitive clean negative, even when
  // the observed prefix holds no bridge evidence.
  if(truncated){
    return {foundInvite:null,details:logDetails.join('\n'),outcome:'PARTIALLY_INSPECTED',observations:[{requestedUrl:seedUrl,finalUrl:page.finalUrl,wrapperUrl,surface,required:true,outcome:'PARTIALLY_INSPECTED',retryable:true,httpStatus:200,failureClass:'RESPONSE_TRUNCATED',detail:`Messaging preview truncated at the bounded-response cap before full coverage (${page.html.length} bytes observed)`,observedAt,telemetry:staticCrawlerTelemetry({redirectsFollowed:page.finalUrl!==seedUrl?1:0,pagesInspected:1,ceiling:'response-cap'})}],candidates:[],bridgeEvidence,previewHtmlLength:page.html.length,truncated:true};
  }
  return {foundInvite:null,details:logDetails.join('\n'),outcome:'INSPECTED_NO_MATCH',observations:[{requestedUrl:seedUrl,finalUrl:page.finalUrl,wrapperUrl,surface,required:false,outcome:'INSPECTED_NO_MATCH',retryable:false,httpStatus:200,detail:bridgeEvidence?'Messaging preview statically inspected without an extractable invite; bridge evidence present':`Messaging preview statically inspected without a Discord invite (${page.html.length} bytes, 0 Playwright launches)`,observedAt,telemetry:staticCrawlerTelemetry({redirectsFollowed:page.finalUrl!==seedUrl?1:0,pagesInspected:1})}],candidates:[],bridgeEvidence,previewHtmlLength:page.html.length,truncated:false};
}

async function crawlSocialBios(socialUrls:string[],logDetails:string[]=[],debugLog?:any):Promise<ExternalDiscordCrawlResult>{return crawlExternalLinks(socialUrls,logDetails,debugLog,fetch,'SOCIAL_PROFILES');}

export async function scrapeRecentVideoDescriptions(youtubeUrl:string):Promise<string[]>{return (await scrapeRecentVideoDescriptionsWithCoverage(youtubeUrl)).descriptions;}
async function scrapeRecentVideoDescriptionsWithCoverage(youtubeUrl:string):Promise<{descriptions:string[];items:RecentVideoDescription[];attempted:number;acquired:number}>{
  if(!youtubeUrl||!youtubeUrl.startsWith('http'))return {descriptions:[],items:[],attempted:0,acquired:0};const videosPageUrl=youtubeUrl.endsWith('/videos')?youtubeUrl:`${youtubeUrl.replace(/\/+$/,'')}/videos`;const page=await fetchWithTimeout(videosPageUrl,0);if(!page)throw new Error('Recent-video page acquisition failed');const html=page.html;const videoIds=extractYouTubeVideoIds(html,10);if(videoIds.length===0)throw new Error('Recent-video page schema was not recognized; absence is not confirmed');const descriptions:string[]=[];const items:RecentVideoDescription[]=[];let acquired=0;for(const vId of videoIds.slice(0,10)){const watchUrl=`https://www.youtube.com/watch?v=${vId}`,vPage=await fetchWithTimeout(watchUrl,0);if(vPage){acquired++;const metaDesc=vPage.html.match(/<meta\s+name="description"\s+content="([^"]+)"/i)||vPage.html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i);let desc=metaDesc?metaDesc[1]:'';const cleanVHtml=decodeEmbeddedMarkup(vPage.html);const extInVid=extractExternalUrlsFromText(cleanVHtml),invs=extractDiscordCandidates(cleanVHtml,'RECENT_VIDEO_DESCRIPTIONS',watchUrl).filter(candidate=>candidate.nativeInviteCode);for(const inv of invs)desc+=` ${inv.normalizedLocator}`;if(extInVid.length>0)desc+=` ${extInVid.join(' ')}`;if(desc.trim()){descriptions.push(desc.trim());items.push({videoId:vId,description:desc.trim()});}}}if(videoIds.length>0&&acquired===0)throw new Error('Recent-video descriptions could not be acquired');return {descriptions,items,attempted:videoIds.length,acquired};
}

async function fetchLiveYouTubeChannelData(youtubeUrl:string,enableDebug?:boolean):Promise<{rawHtml?:string;fetchLog?:string;bio?:string;channelLinks?:string[];videoDescriptions?:string[];thumbnailUrl?:string;truncated?:boolean;}|null>{
  if(!youtubeUrl||!youtubeUrl.startsWith('http'))return null;const page=await fetchWithTimeout(youtubeUrl,0);if(!page)return null;const html=page.html,cleanHtml=decodeEmbeddedMarkup(html);let thumbnailUrl:string|undefined,bio:string|undefined,explicitLinks:string[]=[];const match=html.match(/ytInitialData\s*=\s*({.*?});<\/script>/);if(match){try{const ytData=JSON.parse(match[1]);if(ytData.metadata?.channelMetadataRenderer?.description)bio=ytData.metadata.channelMetadataRenderer.description;if(ytData.metadata?.channelMetadataRenderer?.avatar?.thumbnails?.[0]?.url)thumbnailUrl=ytData.metadata.channelMetadataRenderer.avatar.thumbnails[0].url;function extractLinks(obj:any){if(typeof obj!=='object'||obj===null)return;if(obj.channelExternalLinkViewModel?.link?.content)explicitLinks.push(obj.channelExternalLinkViewModel.link.content);if(obj.urlEndpoint?.url){const url=obj.urlEndpoint.url;if(typeof url==='string'&&url.startsWith('http')&&!url.includes('youtube.com/watch')&&!url.includes('youtube.com/channel'))explicitLinks.push(url);}for(const key in obj)extractLinks(obj[key]);}extractLinks(ytData);}catch(e){console.warn('Failed to parse ytInitialData',e);}}if(!thumbnailUrl){const ogImg=html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i)||html.match(/<link\s+rel="image_src"\s+href="([^"]+)"/i);if(ogImg&&ogImg[1])thumbnailUrl=ogImg[1];}if(!bio){const ogDesc=html.match(/<meta\s+name="description"\s+content="([^"]+)"/i)||html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i);if(ogDesc&&ogDesc[1])bio=ogDesc[1];}const extractedUrls=Array.from(new Set([...explicitLinks,...extractExternalUrlsFromText(cleanHtml)]));if(page.truncated&&!bio&&extractedUrls.length===0)return null;return {bio,channelLinks:extractedUrls,thumbnailUrl,truncated:page.truncated,rawHtml:enableDebug?cleanHtml:undefined,fetchLog:enableDebug?`Fetched ${page.finalUrl} (${page.html.length} bytes)`:undefined};
}

function normalizedRenderedCandidates(rendered:BrowserFallbackResult,surface:AcquisitionSurface,seedUrl:string):DiscordCandidate[]{
  const available=(rendered.candidates||[]).filter(candidate=>candidate.nativeInviteCode);
  const sourceCandidates=available.length?available:rendered.foundInvite?[candidateFromNativeInvite({nativeInviteCode:rendered.foundInvite,sourceSurface:surface,sourceUrl:rendered.foundLocation||seedUrl,rawLocator:`https://discord.gg/${rendered.foundInvite}`,extractionConfidence:'RESOLVED'})].filter((candidate):candidate is DiscordCandidate=>Boolean(candidate)):[];
  if(surface!=='SOCIAL_PROFILES')return sourceCandidates;
  return sourceCandidates.map(candidate=>candidateFromNativeInvite({nativeInviteCode:candidate.nativeInviteCode!,sourceSurface:'SOCIAL_PROFILES',sourceUrl:candidate.sourceUrl||rendered.foundLocation||seedUrl,rawLocator:candidate.rawLocator,extractionConfidence:candidate.extractionConfidence})).filter((candidate):candidate is DiscordCandidate=>Boolean(candidate));
}

/**
 * Rendered outcome classification (truthful, recall-safe):
 * - FOUND when candidates were retained, regardless of completeness.
 * - INSPECTED_NO_MATCH only when complete AND processed (real evidence).
 * - PARTIALLY_INSPECTED when real pages were inspected but coverage is
 *   incomplete (e.g. budget expired mid-crawl): useful partial evidence is
 *   preserved as partial — never collapsed into "unavailable".
 * - ACQUISITION_FAILED only when zero usable page evidence exists.
 * Budget expiration, zero-page results, and partial coverage keep distinct
 * failure classes; retryability always follows the fallback result.
 */
function renderedAcquisitionOutcome(rendered:BrowserFallbackResult,renderedProcessed:boolean,renderedCandidates:DiscordCandidate[]):{outcome:ExternalAcquisitionStatus;failureClass?:string}{
  if(renderedCandidates.length)return{outcome:'FOUND'};
  if(rendered.complete&&renderedProcessed)return{outcome:'INSPECTED_NO_MATCH'};
  // A timeout is a total-timeout ceiling, not proof of page-budget pressure:
  // keep RENDERED_BUDGET_EXPIRED only when page-budget drops evidence it,
  // otherwise attribute the timeout truthfully so it never reads as budget.
  const pageBudgetCut=(rendered.dropReasons?.['page-budget']||0)>0;
  const timeoutClass=rendered.timedOut?(pageBudgetCut?'RENDERED_BUDGET_EXPIRED':'RENDERED_TIMEOUT'):undefined;
  if(rendered.inspectedPages>0)return{outcome:'PARTIALLY_INSPECTED',failureClass:timeoutClass||'RENDERED_PARTIAL_COVERAGE'};
  return{outcome:'ACQUISITION_FAILED',failureClass:timeoutClass||rendered.failureClass||'NO_PAGE_PROCESSED'};
}

/**
 * Per-item static isolation wrapper (PR #434 item 2). `crawlExternalLinks`
 * already isolates per-seed failures internally; this additionally guarantees a
 * single item can never throw out of the Step 4/5 loops and prevent subsequent
 * candidates from being attempted.
 */
async function safeCrawlStatic(seedUrl:string,debugLog:any,fetchImpl:typeof fetch,surface:AcquisitionSurface,wrapperUrl?:string):Promise<{crawlRes:ExternalDiscordCrawlResult}>{
  try{
    return {crawlRes:await crawlExternalLinks([seedUrl],[],debugLog,fetchImpl,surface,false,wrapperUrl)};
  }catch(error:any){
    const detail=`Static acquisition isolated for ${seedUrl}; remaining candidates continue.`;
    return {crawlRes:{foundInvite:null,details:detail,outcome:'ACQUISITION_FAILED',observations:[{requestedUrl:seedUrl,wrapperUrl,surface,required:false,outcome:'ACQUISITION_FAILED',retryable:true,failureClass:'ISOLATED_ACQUISITION_ERROR',detail:`${detail} ${error instanceof Error?error.message:String(error)}`,observedAt:new Date().toISOString(),telemetry:staticCrawlerTelemetry({redirectsFollowed:0,pagesInspected:0})}],candidates:[]}};
  }
}

/**
 * Rendered fallback that can never throw into the candidate loop (PR #434 item
 * 2). The production implementation already catches internally; this covers
 * injected fallbacks. Callers always receive a result object and continue.
 */
function isolatedRenderedFallback(seedUrl:string,error:any):BrowserFallbackResult{
  return {foundInvite:null,foundLocation:seedUrl,candidates:[],inspectedPages:0,scrolls:0,clicks:0,complete:false,retryable:true,timedOut:false,telemetry:undefined,detail:`Rendered acquisition isolated after unexpected error; remaining candidates continue: ${error instanceof Error?error.message:String(error)}`};
}

/**
 * Defense-in-depth for the rendered completion invariant: an
 * `INSPECTED_NO_MATCH` requires actual inspection evidence (processed pages,
 * admitted requests, or followed redirects). A zero-evidence "clean" result —
 * e.g. a fallback resolving `complete:true` without processing anything — must
 * never count as a successful inspection.
 */
function hasProcessedAcquisitionEvidence(item:{telemetry?:CrawlerTelemetry}):boolean{
  const t=item.telemetry;
  return !!t&&((t.pagesInspected||0)>0||(t.requestsStarted||0)>0||(t.redirectsFollowed||0)>0);
}

export interface LinkedWebsiteAcquisitionSummary {
  uniqueRootUrls: number;
  staticRan: number;
  staticSucceeded: number;
  staticFailed: number;
  renderedRan: number;
  renderedSucceeded: number;
  renderedFailed: number;
  pagesProcessed: number;
  retryableFailures: number;
}

function normalizeSummaryUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    return `${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/$/, '') || '/'}`;
  } catch {
    return raw.trim().toLowerCase().replace(/\/$/, '');
  }
}

/**
 * Meaningful-website boundary for Step 4 accounting and retry ownership.
 * Dotless single-label hosts (e.g. `https://g/`) are statically attempted for
 * recall safety and kept in the raw audit trail, but they are meaningless as
 * acquisition evidence: they never count toward unique-website totals, never
 * decide the effective Step 4 outcome, and never own retry work. This reuses
 * the existing `isDotlessHostnameUrl` semantic — no second validation system.
 */
export function isMeaningfulWebsiteObservation(item: { rootUrl?: string; requestedUrl: string }): boolean {
  return !isDotlessHostnameUrl(item.rootUrl || item.requestedUrl);
}

/**
 * Display-only Step 4 accounting. Observation totals (static + rendered rows)
 * must never be compared against root-URL totals: one URL routinely produces
 * several observations across inspection phases. This splitter reports each
 * population separately — unique URLs, static observations, rendered
 * observations, processed pages, and retryable failures — without changing
 * any acquisition outcome, status, or retry behavior.
 */
export function summarizeLinkedWebsiteAcquisition(observations: ExternalAcquisitionObservation[]): LinkedWebsiteAcquisitionSummary {
  const website = observations.filter(item => item.surface === 'CREATOR_WEBSITES' && isMeaningfulWebsiteObservation(item));
  // Root grouping: child-fetch observations carry the seed crawl's rootUrl so
  // subpage failures never inflate the unique-website count, and cumulative
  // per-crawl page counters collapse to one maximum per root crawl instead of
  // summing the same pages many times over. Rows predating rootUrl fall back
  // to their own requested URL.
  const rootKey = (item: ExternalAcquisitionObservation): string =>
    normalizeSummaryUrl(item.rootUrl || item.requestedUrl);
  const uniqueRootUrls = new Set(website.map(rootKey)).size;
  // Phase attribution follows the telemetry mode recorded at observation
  // time — never the retry-ownership `required` flag. Static messaging
  // previews deliberately use required:true for retry ownership even though
  // no browser fallback ran; rows without telemetry would be misread by that
  // flag, so every CREATOR_WEBSITES producer must attach explicit telemetry
  // (verified: all producers do as of the messaging-isolation fix; the
  // flag-based fallback below survives only as a legacy safety net for
  // telemetry-less rows from older persisted trails).
  const phaseOf = (item: ExternalAcquisitionObservation): 'static' | 'rendered' => {
    if (item.telemetry?.mode === 'RENDERED') return 'rendered';
    if (item.telemetry?.mode === 'STATIC') return 'static';
    return item.required ? 'rendered' : 'static';
  };
  const split = (phase: 'static' | 'rendered') => website.filter(item => phaseOf(item) === phase);
  const succeeded = (items: ExternalAcquisitionObservation[]) =>
    items.filter(item => item.outcome === 'FOUND' || (item.outcome === 'INSPECTED_NO_MATCH' && hasProcessedAcquisitionEvidence(item))).length;
  const failed = (items: ExternalAcquisitionObservation[]) =>
    items.filter(item => item.outcome === 'ACQUISITION_FAILED').length;
  const statics = split('static');
  const rendereds = split('rendered');
  // Telemetry counters are cumulative snapshots per crawl: each observation
  // carries the running total at its own point in time. Summing them would
  // count the same pages many times over, so take the maximum per unique URL.
  // Telemetry counters are cumulative snapshots within one crawl phase but
  // independent across phases: static sub-observations share one crawl's
  // running total (take the maximum per root), while a rendered rerun of the
  // same root inspects pages anew (counted separately). Keying by phase+root
  // avoids both multiplying shared counters and dropping a whole phase.
  const pagesByPhaseRoot = new Map<string, number>();
  for (const item of website) {
    const key = `${phaseOf(item)}:${rootKey(item)}`;
    pagesByPhaseRoot.set(key, Math.max(pagesByPhaseRoot.get(key) || 0, Number(item.telemetry?.pagesInspected) || 0));
  }
  return {
    uniqueRootUrls,
    staticRan: statics.length,
    staticSucceeded: succeeded(statics),
    staticFailed: failed(statics),
    renderedRan: rendereds.length,
    renderedSucceeded: succeeded(rendereds),
    renderedFailed: failed(rendereds),
    pagesProcessed: [...pagesByPhaseRoot.values()].reduce((total, pages) => total + pages, 0),
    retryableFailures: website.filter(item => item.outcome === 'ACQUISITION_FAILED' && item.retryable).length,
  };
}

export function formatLinkedWebsiteAcquisitionSummary(summary: LinkedWebsiteAcquisitionSummary): string {
  const parts = [
    `${summary.uniqueRootUrls} unique website URL(s)`,
    `static: ${summary.staticRan} attempted, ${summary.staticSucceeded} inspected, ${summary.staticFailed} failed`,
    `rendered fallback: ${summary.renderedRan} attempted, ${summary.renderedSucceeded} inspected, ${summary.renderedFailed} failed`,
    `${summary.pagesProcessed} page(s) processed`,
    `${summary.retryableFailures} retryable failure(s)`,
  ];
  return `Linked website acquisition: ${parts.join('; ')}.`;
}

export async function runChannelInspection(channelData:{enableDebug?:boolean;channelId:string;channelName?:string;channelBio:string;channelLinks?:string[];pinnedComment?:string;videoDescriptions?:string[];socialLinks?:string[];youtubeUrl?:string;forceLiveFetch?:boolean;liveChannelDataLoader?:typeof fetchLiveYouTubeChannelData;recentVideoDescriptionsLoader?:(channelId:string)=>Promise<Array<string|{videoId?:string|null;description?:string|null}>>;externalFetchImpl?:typeof fetch;creatorLikelyTrading?:boolean;renderedFallback?:(seedUrl:string)=>Promise<BrowserFallbackResult>;urlFailureHistoryLoader?:(channelId:string)=>Promise<UrlFailureRow[]>;}):Promise<InspectionResult>{
  const steps:InspectionStep[]=[];const now=new Date().toISOString();let extractedThumbnailUrl:string|undefined;const acquisitionOutcomes:ExternalAcquisitionObservation[]=[];let acquiredAboutUrl:string|undefined;const acquiredRecentDescriptionSurfaces:string[]=[];let debugLog:any=channelData.enableDebug?{rawAboutPageHtml:null,fetchLog:null,extractedUrls:[],redirectsFollowed:[],discordRegexAttempts:[],failureStep:null}:undefined;let bio=channelData.channelBio||'',links=channelData.channelLinks||[],videoDescs=channelData.videoDescriptions||[];let creatorLikelyTrading=channelData.creatorLikelyTrading,creatorName=channelData.channelName||'';
  if((creatorLikelyTrading===undefined||!creatorName)&&channelData.channelId){try{const stored=await getChannelById(channelData.channelId);if(creatorLikelyTrading===undefined)creatorLikelyTrading=stored?.trading_status==='TRADING_CONFIRMED';if(!creatorName)creatorName=stored?.channel_name||'';}catch{if(creatorLikelyTrading===undefined)creatorLikelyTrading=false;}}creatorLikelyTrading=creatorLikelyTrading===true;
  // Channel-sampled descriptions acquired during THIS inspection, kept
  // separate from preloaded search-selected snippets. Only this collection
  // carries authoritative provenance for the aggregated-language country
  // voter (see observedVideoDescriptions): preloaded discovery input must
  // never become the language sample merely because it was passed in.
  // Tracked as (videoId, text) pairs: API and keyless scrape sample the same
  // newest uploads, so merging by video ID keeps one upload from voting twice
  // when its two observed texts differ in encoding or appended links.
  let channelSampled: RecentVideoDescription[] = [];
  const channelSampledDescs = (): string[] => channelSampled.map(item => item.description);
  const trackChannelSampled = (input: SampledVideoInput[] | null | undefined): void => {
    channelSampled = mergeSampledVideoDescriptions(channelSampled, normalizeSampledVideoDescriptions(input));
  };
  if(channelData.youtubeUrl||channelData.channelId){const shouldRefreshAbout=Boolean(channelData.youtubeUrl&&(channelData.forceLiveFetch||creatorLikelyTrading||links.length===0||bio.length<20));if(shouldRefreshAbout&&channelData.youtubeUrl){try{const liveData=await (channelData.liveChannelDataLoader||fetchLiveYouTubeChannelData)(channelData.youtubeUrl,channelData.enableDebug);if(liveData){acquiredAboutUrl=channelData.youtubeUrl;if(liveData.bio)bio=`${bio} ${liveData.bio}`.trim();if(liveData.channelLinks?.length)links=Array.from(new Set([...links,...liveData.channelLinks]));if(liveData.thumbnailUrl)extractedThumbnailUrl=liveData.thumbnailUrl;if(debugLog){debugLog.rawAboutPageHtml=liveData.rawHtml;debugLog.fetchLog=liveData.fetchLog;}}else acquisitionOutcomes.push({requestedUrl:channelData.youtubeUrl,surface:'YOUTUBE_ABOUT',required:true,outcome:'ACQUISITION_FAILED',retryable:true,failureClass:'YOUTUBE_ABOUT_ACQUISITION_FAILED',retryAt:undefined,detail:'YouTube About page could not be acquired',observedAt:now});}catch(e){acquisitionOutcomes.push({requestedUrl:channelData.youtubeUrl,surface:'YOUTUBE_ABOUT',required:true,outcome:'ACQUISITION_FAILED',retryable:true,failureClass:'YOUTUBE_ABOUT_ACQUISITION_FAILED',retryAt:retryAtFromUnknown(e),detail:e instanceof Error?e.message:String(e),observedAt:now});}}
    const preloaded=[...videoDescs];let authoritative=false;if(channelData.channelId&&(creatorLikelyTrading||channelData.forceLiveFetch)){try{const apiDescs=await (channelData.recentVideoDescriptionsLoader||fetchRecentVideoDescriptionsWithIds)(channelData.channelId);acquiredRecentDescriptionSurfaces.push(`youtube-api:channel:${channelData.channelId}:recent-video-descriptions`);authoritative=true;trackChannelSampled(apiDescs);const apiTexts=normalizeSampledVideoDescriptions(apiDescs).map(item=>item.description);if(apiTexts.length)videoDescs=Array.from(new Set([...apiTexts,...preloaded]));}catch(e){acquisitionOutcomes.push({requestedUrl:`youtube-api:channel:${channelData.channelId}:recent-video-descriptions`,surface:'RECENT_VIDEO_DESCRIPTIONS',required:true,outcome:'ACQUISITION_FAILED',retryable:true,failureClass:'RECENT_VIDEO_DESCRIPTION_API_FAILED',retryAt:retryAtFromUnknown(e),detail:e instanceof Error?e.message:String(e),observedAt:now});}}else if(videoDescs.length<5&&channelData.channelId){try{const apiDescs=await (channelData.recentVideoDescriptionsLoader||fetchRecentVideoDescriptionsWithIds)(channelData.channelId);acquiredRecentDescriptionSurfaces.push(`youtube-api:channel:${channelData.channelId}:recent-video-descriptions`);authoritative=true;trackChannelSampled(apiDescs);const apiTexts=normalizeSampledVideoDescriptions(apiDescs).map(item=>item.description);if(apiTexts.length)videoDescs=Array.from(new Set([...apiTexts,...videoDescs]));}catch(e){acquisitionOutcomes.push({requestedUrl:`youtube-api:channel:${channelData.channelId}:recent-video-descriptions`,surface:'RECENT_VIDEO_DESCRIPTIONS',required:true,outcome:'ACQUISITION_FAILED',retryable:true,failureClass:'RECENT_VIDEO_DESCRIPTION_API_FAILED',retryAt:retryAtFromUnknown(e),detail:e instanceof Error?e.message:String(e),observedAt:now});}}
  // Channel-sample continuation: the aggregated-language voter needs ≥8
  // usable authoritative descriptions, so keep sampling (keyless scrape tops
  // up a short API sample) until the channel-sampled collection — not the
  // merged preloaded-inclusive list — reaches that minimum. Counts are
  // distinct videos (API/scrape overlap merges by video ID), never duplicate
  // observations. API and scrape each supply up to 10;
  // observedVideoDescriptions stays capped at 10.
    if(channelSampled.length<8&&channelData.youtubeUrl){
    // InnerTube-first: keyless structured metadata over the shared session
    // (pacing, cooldown, deadlines identical to retrieval pages) — no
    // browser, no Data API quota. Static scrape still runs below whenever the
    // merged channel sample remains below the 8-description voter minimum.
    if(channelData.channelId){try{
      const {fetchChannelVideoDescriptionsViaInnertube}=await import('./youtubeInnertubeProvider');
      const fetched=await fetchChannelVideoDescriptionsViaInnertube(channelData.channelId,{maxVideos:10});
      if(fetched.items.length){
      acquiredRecentDescriptionSurfaces.push(`innertube:channel:${channelData.channelId}:recent-video-descriptions`);
        if(fetched.items.length<fetched.videosAttempted)acquisitionOutcomes.push({requestedUrl:`innertube:channel:${channelData.channelId}:recent-video-descriptions`,surface:'RECENT_VIDEO_DESCRIPTIONS',required:true,outcome:'ACQUISITION_FAILED',retryable:true,failureClass:'INNERTUBE_DESCRIPTION_PARTIAL',detail:`Acquired ${fetched.items.length} of ${fetched.videosAttempted} sampled recent-video descriptions`,observedAt:now});
        trackChannelSampled(fetched.items);
        const innertubeTexts=normalizeSampledVideoDescriptions(fetched.items).map(item=>item.description);
        if(innertubeTexts.length)videoDescs=Array.from(new Set([...(authoritative?[]:innertubeTexts),...videoDescs,...(authoritative?innertubeTexts:[])]));
      }
    }catch(e){
      // Permanent input defects (missing channel id, session without channel
      // methods) must not schedule futile retries; every other failure keeps
      // the retryable default so transient outages still recover.
      const retryable=(e as {retryable?: unknown})?.retryable!==false;
      acquisitionOutcomes.push({requestedUrl:`innertube:channel:${channelData.channelId}:recent-video-descriptions`,surface:'RECENT_VIDEO_DESCRIPTIONS',required:true,outcome:'ACQUISITION_FAILED',retryable,failureClass:'INNERTUBE_DESCRIPTION_FAILED',retryAt:retryable?retryAtFromUnknown(e):undefined,detail:e instanceof Error?e.message:String(e),observedAt:now});}}
    if(channelSampled.length<8){try{const scraped=await scrapeRecentVideoDescriptionsWithCoverage(channelData.youtubeUrl);acquiredRecentDescriptionSurfaces.push(`${channelData.youtubeUrl.replace(/\/+$/,'')}/videos`);if(scraped.acquired<scraped.attempted)acquisitionOutcomes.push({requestedUrl:`${channelData.youtubeUrl.replace(/\/+$/,'')}/videos`,surface:'RECENT_VIDEO_DESCRIPTIONS',required:true,outcome:'ACQUISITION_FAILED',retryable:true,failureClass:'RECENT_VIDEO_DESCRIPTION_PARTIAL',detail:`Acquired ${scraped.acquired} of ${scraped.attempted} sampled recent-video descriptions`,observedAt:now});trackChannelSampled(scraped.items);if(scraped.descriptions.length)videoDescs=Array.from(new Set([...(authoritative?[]:scraped.descriptions),...videoDescs,...(authoritative?scraped.descriptions:[])]));}catch(e){acquisitionOutcomes.push({requestedUrl:`${channelData.youtubeUrl.replace(/\/+$/,'')}/videos`,surface:'RECENT_VIDEO_DESCRIPTIONS',required:true,outcome:'ACQUISITION_FAILED',retryable:true,failureClass:'RECENT_VIDEO_DESCRIPTION_SCRAPE_FAILED',detail:e instanceof Error?e.message:String(e),observedAt:now});}}
    }
  }

  function addStep(stepName:InspectionStep['step'],title:string,status:InspectionStep['status'],detailsArr:string[],foundInvite:string|null=null,inviteLocation:string|undefined=undefined,foundInvites:string[]=[]){steps.push({step:stepName,title,status,details:detailsArr.join('\n'),detectedInvite:foundInvite||undefined,detectedInvites:foundInvites.length?foundInvites:foundInvite?[foundInvite]:undefined,inviteLocation,timestamp:now});if(debugLog&&status==='NOT_FOUND'&&!debugLog.failureStep)debugLog.failureStep=stepName;}
  let collectedExternalUrls:{url:string;wrapperUrl?:string;kind:'WEBSITE'|'SOCIAL'|'MESSAGING';contextMatches:boolean;source:string}[]=[];const checkContext=(text:string,url:string):boolean=>{const contextKeywords=['discord','community','join','trading floor','members','server'],lowerText=text.toLowerCase(),urlIndex=lowerText.indexOf(url.toLowerCase());if(urlIndex===-1)return false;const window=lowerText.substring(Math.max(0,urlIndex-100),Math.min(lowerText.length,urlIndex+url.length+100));return contextKeywords.some(kw=>window.includes(kw));};const addExternalUrls=(text:string,source:string)=>{const urls=extractExternalUrlsFromText(text);if(debugLog)debugLog.extractedUrls.push(...urls);for(const url of urls){const normalized=normalizeExternalUrl(url);if(normalized)collectedExternalUrls.push({...normalized,contextMatches:checkContext(text,url),source});}};
  for(const link of links)if(link&&typeof link==='string'){if(debugLog)debugLog.extractedUrls.push(link);const normalized=normalizeExternalUrl(link);if(normalized)collectedExternalUrls.push({...normalized,contextMatches:false,source:'CHANNEL_LINKS'});}for(const link of channelData.socialLinks||[])if(link&&typeof link==='string'){if(debugLog)debugLog.extractedUrls.push(link);const normalized=normalizeExternalUrl(link);if(normalized)collectedExternalUrls.push({...normalized,contextMatches:false,source:'SOCIAL_LINKS'});}
  const discoveredCandidates:DiscordCandidate[]=[];const retainCandidates=(items:DiscordCandidate[])=>{discoveredCandidates.push(...items.filter(item=>item.nativeInviteCode));};

  const step1Logs:string[]=[];step1Logs.push(`Inspecting channel bio text (${bio.length} characters) and embedded links.`);const bioCandidates=extractDiscordCandidates(bio,'YOUTUBE_ABOUT',channelData.youtubeUrl).filter(c=>c.nativeInviteCode),directBioInvite=bioCandidates[0]?.nativeInviteCode||null;if(debugLog)debugLog.discordRegexAttempts.push({source:'CHANNEL_ABOUT',textLength:bio.length,result:bioCandidates.map(c=>c.nativeInviteCode)});addExternalUrls(bio,'CHANNEL_ABOUT');retainCandidates(bioCandidates);if(directBioInvite){step1Logs.push(`${bioCandidates.length} direct Discord candidate(s) detected in Channel Bio.`);addStep('BIO','Step 1 — Channel Bio & About Panel','FOUND',step1Logs,directBioInvite,'CHANNEL_ABOUT');acquisitionOutcomes.push({requestedUrl:channelData.youtubeUrl||`youtube:channel:${channelData.channelId}`,surface:'YOUTUBE_ABOUT',required:true,outcome:'FOUND',retryable:false,detail:`${bioCandidates.length} Discord candidate(s) discovered in YouTube About content`,observedAt:now});}else{if(acquiredAboutUrl)acquisitionOutcomes.push({requestedUrl:acquiredAboutUrl,surface:'YOUTUBE_ABOUT',required:true,outcome:'INSPECTED_NO_MATCH',retryable:false,detail:'YouTube About page acquired and inspected without a Discord invite',observedAt:now});step1Logs.push('No direct Discord invite found in channel bio.');addStep('BIO','Step 1 — Channel Bio & About Panel','NOT_FOUND',step1Logs);}

  const step2Logs:string[]=[];const rawLinkCandidates=links.flatMap(link=>extractDiscordCandidates(link,'CHANNEL_EXTERNAL_LINKS',link)).filter(c=>c.nativeInviteCode);const linkCandidates=mergeDiscordCandidates(rawLinkCandidates,{creatorName});retainCandidates(linkCandidates);if(links.length){step2Logs.push(`Scanning ${links.length} channel links.`);if(linkCandidates.length){const inviteCodes=linkCandidates.map(candidate=>candidate.nativeInviteCode!).filter(Boolean);step2Logs.push(`${linkCandidates.length} distinct direct Discord candidate(s) retained from channel links.`);step2Logs.push(`Retained invite code${inviteCodes.length===1?'':'s'}: ${inviteCodes.join(', ')}`);for(const candidate of linkCandidates)acquisitionOutcomes.push({requestedUrl:candidate.sourceUrl||candidate.rawLocator,surface:'CHANNEL_EXTERNAL_LINKS',required:true,outcome:'FOUND',retryable:false,detail:'Discord invite discovered in channel links',observedAt:now});addStep('EXTERNAL_LINKS','Step 2 — Channel External Links','FOUND',step2Logs,linkCandidates[0].nativeInviteCode||null,'CHANNEL_LINKS',inviteCodes);}else{step2Logs.push('No direct Discord invite found in channel links.');addStep('EXTERNAL_LINKS','Step 2 — Channel External Links','NOT_FOUND',step2Logs);}}else addStep('EXTERNAL_LINKS','Step 2 — Channel External Links','SKIPPED',['No channel links found.']);

  const descriptionsToInspect=videoDescs.slice(0,5),step3Logs:string[]=[];const videoCandidates:DiscordCandidate[]=[];if(descriptionsToInspect.length){step3Logs.push(`Scanning ${descriptionsToInspect.length} recent video descriptions${videoDescs.length>descriptionsToInspect.length?` (${videoDescs.length} available; newest authoritative descriptions are prioritized).`:'.'}`);for(let i=0;i<descriptionsToInspect.length;i++){const d=descriptionsToInspect[i],sourceName=`VIDEO_${i+1}_DESCRIPTION`;addExternalUrls(d,sourceName);const candidates=extractDiscordCandidates(d,'RECENT_VIDEO_DESCRIPTIONS',`youtube:channel:${channelData.channelId}:${sourceName}`).filter(c=>c.nativeInviteCode);videoCandidates.push(...candidates);if(debugLog)debugLog.discordRegexAttempts.push({source:sourceName,textLength:d.length,result:candidates.map(c=>c.nativeInviteCode)});if(candidates.length)acquisitionOutcomes.push({requestedUrl:`youtube:channel:${channelData.channelId}:${sourceName}`,surface:'RECENT_VIDEO_DESCRIPTIONS',required:true,outcome:'FOUND',retryable:false,detail:`${candidates.length} Discord candidate(s) discovered in recent video description`,observedAt:now});}retainCandidates(videoCandidates);if(videoCandidates.length){step3Logs.push(`${videoCandidates.length} Discord candidate observation(s) retained across the inspected descriptions.`);addStep('VIDEO_DESCRIPTIONS','Step 3 — Latest Video Descriptions','FOUND',step3Logs,videoCandidates[0].nativeInviteCode||null,'RECENT_VIDEO_DESCRIPTIONS');}else{step3Logs.push('No direct Discord invite found in the descriptions actually inspected.');addStep('VIDEO_DESCRIPTIONS','Step 3 — Latest Video Descriptions','NOT_FOUND',step3Logs);}}else addStep('VIDEO_DESCRIPTIONS','Step 3 — Latest Video Descriptions','SKIPPED',['No video descriptions available.']);for(const surface of acquiredRecentDescriptionSurfaces)if(!videoCandidates.length)acquisitionOutcomes.push({requestedUrl:surface,surface:'RECENT_VIDEO_DESCRIPTIONS',required:true,outcome:'INSPECTED_NO_MATCH',retryable:false,detail:`Recent video descriptions acquired; ${descriptionsToInspect.length} description(s) inspected without a Discord invite`,observedAt:now});

  // Recall-safe acquisition (PR #434 items 1-3): ranking reorders but never
  // discards — the complete deduplicated candidate list is attempted in rank
  // order within the existing per-URL budgets. There is intentionally no
  // per-channel URL cap (no "≤4" slice): a channel with many legitimate URLs
  // must not silently lose lower-ranked FOUND paths.
  const uniqueUrls=new Map<string,{url:string;wrapperUrl?:string;kind:'WEBSITE'|'SOCIAL'|'MESSAGING';contextMatches:boolean;source:string}>();for(const item of collectedExternalUrls){const existing=uniqueUrls.get(item.url);if(existing){if(item.contextMatches)existing.contextMatches=true;}else uniqueUrls.set(item.url,item);}const allCollectedUrls=Array.from(uniqueUrls.values()),websiteUrls=rankCommunitySurfaces(allCollectedUrls.filter(u=>u.kind==='WEBSITE')),socialBioUrls=rankCommunitySurfaces(allCollectedUrls.filter(u=>u.kind==='SOCIAL')),messagingUrls=rankCommunitySurfaces(allCollectedUrls.filter(u=>u.kind==='MESSAGING'));
  // Repeat-failure skip set: URLs with 5+ consecutive identical deterministic
  // failures are skipped (fail-open to empty on any history error so a
  // telemetry outage can never block crawling).
  let skippedRepeatUrls=new Set<string>();
  if(channelData.channelId&&(websiteUrls.length||socialBioUrls.length)){try{
    const historyRows=channelData.urlFailureHistoryLoader
      ?await channelData.urlFailureHistoryLoader(channelData.channelId)
      :await fetchUrlFailureHistory(channelData.channelId);
    skippedRepeatUrls=skippedUrlsFromHistory(historyRows);
  }catch{skippedRepeatUrls=new Set<string>();}}
  let repeatSkippedCount=0;
  const repeatSkipLine=(url:string):string|null=>{
    const key=normalizeSkipUrl(url);
    if(!key||!skippedRepeatUrls.has(key))return null;
    repeatSkippedCount++;
    return `Skipping repeatedly-failing URL under the repeat-failure cap (5 consecutive identical failures): ${url}; remaining surfaces continue normally.`;
  };

  const step5Logs:string[]=[];const websiteCandidates:DiscordCandidate[]=[];
  // Messaging previews are attempted first via the lightweight static path so a
  // cheap FOUND can never be starved by expensive website crawls, and messaging
  // candidates join websiteCandidates before the Step 4 aggregate below.
  if(messagingUrls.length){step5Logs.push(`Inspecting ${messagingUrls.length} messaging preview URL(s) via lightweight static inspection (0 default Playwright launches; render only on bridge evidence).`);for(const item of messagingUrls){step5Logs.push(`[Messaging preview] ${item.url} (Source: ${item.source})`);let preview:Awaited<ReturnType<typeof crawlMessagingPreview>>|null=null;try{preview=await crawlMessagingPreview(item.url,[],debugLog,channelData.externalFetchImpl||fetch,'CREATOR_WEBSITES',item.wrapperUrl);}catch(error:any){acquisitionOutcomes.push({requestedUrl:item.url,wrapperUrl:item.wrapperUrl,surface:'CREATOR_WEBSITES',required:true,outcome:'ACQUISITION_FAILED',retryable:true,failureClass:'ISOLATED_ACQUISITION_ERROR',detail:`Messaging preview isolated after unexpected error; remaining candidates continue: ${error instanceof Error?error.message:String(error)}`,observedAt:now,telemetry:staticCrawlerTelemetry({redirectsFollowed:0,pagesInspected:0})});continue;}acquisitionOutcomes.push(...preview.observations);websiteCandidates.push(...preview.candidates);if(preview.outcome==='FOUND'){step5Logs.push(`Messaging preview retained Discord candidate(s) statically; no escalation needed.`);continue;}    // Bridge evidence alone justifies escalation: creator classification must
    // never silently suppress a legitimate messaging discovery path. A
    // truncated preview escalates the same way: the unobserved remainder may
    // hold the invite, so a cut-off prefix without bridge evidence still keeps
    // its rendered-fallback eligibility instead of resolving clean.
    if(preview.outcome==='ACQUISITION_FAILED'||(!preview.bridgeEvidence&&!preview.truncated))continue;const {crawlRenderedCommunitySurface:renderMessagingSurface,wasRenderedResultProcessed}=await import('./browserCommunityFallback');const rendered=await (channelData.renderedFallback||renderMessagingSurface)(item.url).catch((error:any)=>isolatedRenderedFallback(item.url,error));const renderedProcessed=wasRenderedResultProcessed(rendered);const renderedCandidates=normalizedRenderedCandidates(rendered,'CREATOR_WEBSITES',item.url);websiteCandidates.push(...renderedCandidates);const renderedResult=renderedAcquisitionOutcome(rendered,renderedProcessed,renderedCandidates),renderedOutcome:ExternalAcquisitionStatus=renderedResult.outcome;acquisitionOutcomes.push({requestedUrl:item.url,finalUrl:rendered.foundLocation,wrapperUrl:item.wrapperUrl,surface:'CREATOR_WEBSITES',required:true,outcome:renderedOutcome,retryable:rendered.retryable||!renderedProcessed,failureClass:renderedResult.failureClass,detail:rendered.detail,observedAt:now,telemetry:renderedCrawlerTelemetry({inspectedPages:rendered.inspectedPages,clicks:rendered.clicks,complete:rendered.complete,timedOut:rendered.timedOut,telemetry:rendered.telemetry,scrollsUsed:rendered.scrolls||0,dropReasons:rendered.dropReasons})});step5Logs.push(renderedCandidates.length?`Messaging rendered fallback retained ${renderedCandidates.length} candidate(s).`:rendered.detail);}}
  if(websiteUrls.length||messagingUrls.length){step5Logs.push(`Crawling ${websiteUrls.length} website URLs${messagingUrls.length?` (plus ${messagingUrls.length} messaging preview(s) inspected above)`:''}; discovery continues after a first invite.`);for(const item of websiteUrls){const repeatSkipWeb=repeatSkipLine(item.url);if(repeatSkipWeb){step5Logs.push(repeatSkipWeb);continue;}step5Logs.push(`[Crawling] ${item.url} (Priority Score: ${scoreCommunitySurface(item)}, Context Match: ${item.contextMatches}, Source: ${item.source})`);const crawlRes=(await safeCrawlStatic(item.url,debugLog,channelData.externalFetchImpl||fetch,'CREATOR_WEBSITES',item.wrapperUrl)).crawlRes;acquisitionOutcomes.push(...crawlRes.observations);websiteCandidates.push(...crawlRes.candidates);const staticMerged=mergeDiscordCandidates(crawlRes.candidates,{creatorName});const hasCreatorOwned=staticMerged.some(c=>c.ownershipStatus==='CREATOR_OWNED');// Eligibility doctrine: every discovered website URL — including auxiliary,
// broker/affiliate-pattern, promotional, and dotless single-label hosts —
// remains eligible for the normal acquisition path below. Static inspection
// only orders attempts and provides cheap evidence; it never decides whether
// a site is worth crawling. The dotless label marks exact single-label hosts
// only (no dot, hence no public DNS/TLD — e.g. `https://g/` from truncated
// text; never broadened to dotted hosts, IP literals, or malformed strings,
// which fail open to the normal path). Forensic replay (PR #434 §7A) showed
// zero historical FOUND observations for dotless seeds, but quarantine here
// means "labeled malformed/non-public and attempted statically first" — never
// "not allowed to be rendered". Any syntactically legitimate public website,
// including a creator URL containing `/referral/`, keeps full rendered
// eligibility under the existing policy. Dotless single-label hosts (e.g.
// `https://g/`) are statically attempted for recall safety but never escalate
// to the rendered fallback and never own retry work: no browser run can turn
// a meaningless input into evidence, so rendered escalation here would only
// manufacture garbage retry jobs.
    if(isDotlessHostnameUrl(item.url)){step5Logs.push(`Dotless single-label host note (malformed/non-public; attempted statically, no rendered escalation for malformed input): ${item.url}`);}else if(isAuxiliaryTriageCandidate(item)){step5Logs.push(`Auxiliary triage (static-first, still fully eligible for deeper acquisition): ${item.url}`);}if(creatorLikelyTrading&&!isDotlessHostnameUrl(item.url)&&(crawlRes.outcome!=='FOUND'||!hasCreatorOwned)){const {crawlRenderedCommunitySurface,shouldEscalateToRenderedFallback,wasRenderedResultProcessed}=await import('./browserCommunityFallback');const shouldRendered=crawlRes.outcome==='FOUND'?!hasCreatorOwned:shouldEscalateToRenderedFallback({staticOutcome:crawlRes.outcome,creatorLikelyTrading:true,surface:'CREATOR_WEBSITES'});if(shouldRendered){const rendered=await (channelData.renderedFallback||crawlRenderedCommunitySurface)(item.url).catch((error:any)=>isolatedRenderedFallback(item.url,error)),renderedProcessed=wasRenderedResultProcessed(rendered),renderedCandidates=normalizedRenderedCandidates(rendered,'CREATOR_WEBSITES',item.url);websiteCandidates.push(...renderedCandidates);const renderedResult=renderedAcquisitionOutcome(rendered,renderedProcessed,renderedCandidates),renderedOutcome:ExternalAcquisitionStatus=renderedResult.outcome;acquisitionOutcomes.push({requestedUrl:item.url,finalUrl:rendered.foundLocation,wrapperUrl:item.wrapperUrl,surface:'CREATOR_WEBSITES',required:true,outcome:renderedOutcome,retryable:rendered.retryable||!renderedProcessed,failureClass:renderedResult.failureClass,detail:rendered.detail,observedAt:now,telemetry:renderedCrawlerTelemetry({inspectedPages:rendered.inspectedPages,clicks:rendered.clicks,complete:rendered.complete,timedOut:rendered.timedOut,telemetry:rendered.telemetry,scrollsUsed:rendered.scrolls||0,dropReasons:rendered.dropReasons})});step5Logs.push(renderedCandidates.length?`Rendered fallback retained ${renderedCandidates.length} candidate(s).`:rendered.detail);}}}if(repeatSkippedCount>0)step5Logs.push(`Skipped ${repeatSkippedCount} repeatedly-failing website URL(s) under the repeat-failure cap; remaining surfaces inspected normally.`);retainCandidates(websiteCandidates);const mergedWebsite=mergeDiscordCandidates(websiteCandidates,{creatorName}),websiteOutcomes=effectiveAcquisitionOutcomes(acquisitionOutcomes.filter(item=>item.surface==='CREATOR_WEBSITES'&&isMeaningfulWebsiteObservation(item)));if(mergedWebsite.length){const inviteCodes=mergedWebsite.map(candidate=>candidate.nativeInviteCode!).filter(Boolean);step5Logs.push(`Linked website acquisition retained ${mergedWebsite.length} distinct Discord candidate(s).`);step5Logs.push(`Retained invite code${inviteCodes.length===1?'':'s'}: ${inviteCodes.join(', ')}`);step5Logs.push(formatLinkedWebsiteAcquisitionSummary(summarizeLinkedWebsiteAcquisition(acquisitionOutcomes)));addStep('CUSTOM_DOMAINS','Step 4 — Linked Websites','FOUND',step5Logs,mergedWebsite[0].nativeInviteCode||null,'CUSTOM_DOMAIN',inviteCodes);}else{const failedCount=websiteOutcomes.filter(item=>item.outcome==='ACQUISITION_FAILED').length,inspectedCount=websiteOutcomes.filter(item=>item.outcome==='INSPECTED_NO_MATCH'&&hasProcessedAcquisitionEvidence(item)).length,partialCount=websiteOutcomes.filter(item=>item.outcome==='PARTIALLY_INSPECTED').length,unevidencedCount=websiteOutcomes.filter(item=>item.outcome==='INSPECTED_NO_MATCH'&&!hasProcessedAcquisitionEvidence(item)).length,failed=failedCount>0,inspected=inspectedCount>0,partial=partialCount>0||unevidencedCount>0;const acquisitionSummary=summarizeLinkedWebsiteAcquisition(acquisitionOutcomes);step5Logs.push(formatLinkedWebsiteAcquisitionSummary(acquisitionSummary));step5Logs.push(failed&&inspected?`Effective outcome across unique URLs: ${inspectedCount} inspected successfully; ${failedCount} unavailable after fallback.`:failed?`Effective outcome across unique URLs: ${failedCount} unavailable after fallback; absence is not confirmed.`:(failed||inspected)&&partial?`${partialCount} linked website surface(s) were only partially inspected (crawl budget exhausted before full coverage); absence is not confirmed.`:partialCount>0?`${partialCount} linked website surface(s) were only partially inspected (crawl budget exhausted before full coverage); absence is not confirmed.`:unevidencedCount>0?`${unevidencedCount} linked website surface(s) produced no inspection evidence (zero pages/requests processed); absence is not confirmed.`:'No Discord invite found in successfully inspected linked websites.');addStep('CUSTOM_DOMAINS','Step 4 — Linked Websites',failed?(inspected||partial?'PARTIAL':'ERROR'):partial?'PARTIAL':'NOT_FOUND',step5Logs);}}else addStep('CUSTOM_DOMAINS','Step 4 — Linked Websites','SKIPPED',['No website or messaging URLs to crawl.']);

  const step6Logs:string[]=[];const socialCandidates:DiscordCandidate[]=[];
  const repeatSkippedWebsites=repeatSkippedCount;if(socialBioUrls.length){step6Logs.push(`Crawling ${socialBioUrls.length} social profile URLs; discovery continues after a first invite.`);for(const item of socialBioUrls){const repeatSkipSoc=repeatSkipLine(item.url);if(repeatSkipSoc){step6Logs.push(repeatSkipSoc);continue;}step6Logs.push(`[Crawling] ${item.url} (Priority Score: ${scoreCommunitySurface(item)}, Source: ${item.source})`);const crawlRes=(await safeCrawlStatic(item.url,debugLog,channelData.externalFetchImpl||fetch,'SOCIAL_PROFILES',item.wrapperUrl)).crawlRes;acquisitionOutcomes.push(...crawlRes.observations);socialCandidates.push(...crawlRes.candidates);const staticMerged=mergeDiscordCandidates(crawlRes.candidates,{creatorName}),hasCreatorOwned=staticMerged.some(c=>c.ownershipStatus==='CREATOR_OWNED');if(creatorLikelyTrading&&(crawlRes.outcome!=='FOUND'||!hasCreatorOwned)){const {crawlRenderedCommunitySurface,shouldEscalateToRenderedFallback,wasRenderedResultProcessed}=await import('./browserCommunityFallback');const shouldRendered=crawlRes.outcome==='FOUND'?!hasCreatorOwned:shouldEscalateToRenderedFallback({staticOutcome:crawlRes.outcome,creatorLikelyTrading:true,surface:'SOCIAL_PROFILES'});if(shouldRendered){const rendered=await (channelData.renderedFallback||crawlRenderedCommunitySurface)(item.url).catch((error:any)=>isolatedRenderedFallback(item.url,error)),renderedProcessed=wasRenderedResultProcessed(rendered),renderedCandidates=normalizedRenderedCandidates(rendered,'SOCIAL_PROFILES',item.url);socialCandidates.push(...renderedCandidates);const renderedResult=renderedAcquisitionOutcome(rendered,renderedProcessed,renderedCandidates),renderedOutcome:ExternalAcquisitionStatus=renderedResult.outcome;acquisitionOutcomes.push({requestedUrl:item.url,finalUrl:rendered.foundLocation,wrapperUrl:item.wrapperUrl,surface:'SOCIAL_PROFILES',required:true,outcome:renderedOutcome,retryable:rendered.retryable||!renderedProcessed,failureClass:renderedResult.failureClass,detail:rendered.detail,observedAt:now,telemetry:renderedCrawlerTelemetry({inspectedPages:rendered.inspectedPages,clicks:rendered.clicks,complete:rendered.complete,timedOut:rendered.timedOut,telemetry:rendered.telemetry,scrollsUsed:rendered.scrolls||0,dropReasons:rendered.dropReasons})});}}}if(repeatSkippedCount>repeatSkippedWebsites)step6Logs.push(`Skipped ${repeatSkippedCount-repeatSkippedWebsites} repeatedly-failing social URL(s) under the repeat-failure cap; remaining surfaces inspected normally.`);retainCandidates(socialCandidates);const mergedSocial=mergeDiscordCandidates(socialCandidates,{creatorName}),socialOutcomes=effectiveAcquisitionOutcomes(acquisitionOutcomes.filter(item=>item.surface==='SOCIAL_PROFILES'));if(mergedSocial.length){const inviteCodes=mergedSocial.map(candidate=>candidate.nativeInviteCode!).filter(Boolean);step6Logs.push(`Social acquisition retained ${mergedSocial.length} distinct Discord candidate(s).`);step6Logs.push(`Retained invite code${inviteCodes.length===1?'':'s'}: ${inviteCodes.join(', ')}`);addStep('SOCIAL_BIO','Step 5 — Social Profile Bios','FOUND',step6Logs,mergedSocial[0].nativeInviteCode||null,'SOCIAL_BIO',inviteCodes);}else{const failedCount=socialOutcomes.filter(item=>item.outcome==='ACQUISITION_FAILED').length,inspectedCount=socialOutcomes.filter(item=>item.outcome==='INSPECTED_NO_MATCH'&&hasProcessedAcquisitionEvidence(item)).length,partialCount=socialOutcomes.filter(item=>item.outcome==='PARTIALLY_INSPECTED').length,unevidencedCount=socialOutcomes.filter(item=>item.outcome==='INSPECTED_NO_MATCH'&&!hasProcessedAcquisitionEvidence(item)).length,failed=failedCount>0,inspected=inspectedCount>0,partial=partialCount>0||unevidencedCount>0;step6Logs.push(failed&&inspected?`${inspectedCount} social profile surface(s) were inspected; ${failedCount} remained unavailable after rendered fallback.`:failed?'Social profile acquisition remained incomplete after rendered fallback; absence is not confirmed.':partialCount>0?'Social profile acquisition was only partially inspected (crawl budget exhausted before full coverage); absence is not confirmed.':unevidencedCount>0?'Social profile acquisition produced no inspection evidence (zero pages/requests processed); absence is not confirmed.':'No Discord invite found in inspected social profile bios.');addStep('SOCIAL_BIO','Step 5 — Social Profile Bios',failed?(inspected||partial?'PARTIAL':'ERROR'):partial?'PARTIAL':'NOT_FOUND',step6Logs);}}else addStep('SOCIAL_BIO','Step 5 — Social Profile Bios','SKIPPED',['No social profile URLs to crawl.']);

  if(debugLog&&!debugLog.failureStep)debugLog.failureStep='ALL_EXHAUSTED';const mergedCandidates=mergeDiscordCandidates(discoveredCandidates,{creatorName});const required=effectiveAcquisitionOutcomes(acquisitionOutcomes.filter(item=>item.required)),communityRequired=required.filter(item=>isDiscordCommunityAcquisitionSurface(item.surface)&&isMeaningfulWebsiteObservation(item as {rootUrl?:string;requestedUrl:string})),failed=communityRequired.some(item=>item.outcome==='ACQUISITION_FAILED'),inspected=communityRequired.some(item=>item.outcome==='INSPECTED_NO_MATCH'&&hasProcessedAcquisitionEvidence(item)),partialCoverage=effectiveAcquisitionOutcomes(acquisitionOutcomes.filter(item=>isDiscordCommunityAcquisitionSurface(item.surface)&&isMeaningfulWebsiteObservation(item as {rootUrl?:string;requestedUrl:string}))).some(item=>item.outcome==='PARTIALLY_INSPECTED'||(item.outcome==='INSPECTED_NO_MATCH'&&!hasProcessedAcquisitionEvidence(item))),
  // Garbage inputs are fully invisible to outcome accounting: only genuine
  // (meaningful-root) observations decide failed/inspected/partial above, so
  // a malformed-only input set with all-genuine-clean surfaces resolves to
  // the definitive negative instead of manufacturing UNCERTAIN work. The
  // dotless note remains in the step logs for audit; no retry is ever owned
  // (communityRequired is empty, so no directive is built).
  acquisitionStatus:ExternalAcquisitionStatus=failed&&inspected||partialCoverage?'PARTIALLY_INSPECTED':failed?'ACQUISITION_FAILED':'INSPECTED_NO_MATCH';return {foundInvite:mergedCandidates[0]?.nativeInviteCode||null,foundLocation:mergedCandidates[0]?.sourceUrl?.match(/VIDEO_\d+_DESCRIPTION/)?.[0]||mergedCandidates[0]?.sourceSurface,steps,extractedThumbnailUrl,debugLog,observedAboutBio:bio,observedChannelLinks:links,observedVideoDescriptions:channelSampledDescs().slice(0,10),observedVideoDescriptionsAuthoritative:channelSampled.length>0,acquisitionStatus:mergedCandidates.length?'FOUND':acquisitionStatus,acquisitionOutcomes,retryDirective:communityAcquisitionRetryDirective(communityRequired),discordCandidates:mergedCandidates};
}
