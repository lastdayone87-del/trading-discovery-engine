import * as cheerio from 'cheerio';
import { decodeEmbeddedMarkup, detachPageSlice, extractDynamicTargetValues, extractEmbeddedUrls, extractYouTubeVideoIds } from './crawlerExtraction';
import { InspectionStep } from '../src/types';
import type { CommunityIntentEvidence } from '../src/types';
import { extractCommunityIntentEvidence } from './communityIntent';
import { getChannelById, getSiteInspections, upsertSiteInspection, recordCreatorSiteLinks, getSiteProfiles, recordPageCoverage, upsertFrontierQueueItem, countFrontierQueue, accumulateRouteStats, upsertSiteProfile, recordDiscoveryRecoveryAudit, type SiteInspectionRow } from './db';
import { routePatternFor, shouldAccumulateRouteObservation, evaluateDomainWeightShadow, isDomainWeightExperimentConsumptionEnabled, type DomainWeightShadowEvaluation } from './domainLearner';
import { decideFrontierStep, scoreFrontierCandidate, classifyBlockedAcquisition, isFrontierEnabled, MAX_FRONTIER_PAGES_PER_SITE, MAX_FRONTIER_QUEUE_PER_SITE, FRONTIER_POLICY_VERSION, type FrontierCrawlOptions } from './frontierManager';
import { canonicalSiteIdentity, isSiteInspectionReusable, buildBorrowedSiteInspection, hasSameOwnerPendingCandidates, siteInspectionCoversRequest, isSufficientRenderedCoverage, rootCoverageTerminal, mergeRedirectBinding, redirectBindingFor, redirectDestinations, REDIRECT_BINDING_KIND, checksumSiteFacts, SITE_INSPECTION_POLICY_VERSION, isExactBarrierPageCover, aggregateSeedOutcome, SITE_INSPECTION_CLAIM_STATUS, type SiteIdentity, type SiteInspectionStore } from './siteInspectionCache';
import { fetchRecentVideoDescriptionsWithIds, type RecentVideoDescription } from './youtube';
import {candidateFromNativeInvite,extractDiscordCandidates,makeDiscordCandidate,mergeDiscordCandidates,type DiscordCandidate} from './discordCandidates';
import { bumpRepeatFailureHistoryOutage, bumpRepeatFailureSkip } from './operationsTelemetry';
import type { BrowserFallbackResult } from './browserCommunityFallback';
import { normalizeVisitUrl, type BrowserFallbackBudget } from './browserCommunityFallback';
import { parseAboutPageMetadataFromHtml } from './youtubePublicAbout';
import {effectiveAcquisitionOutcomes,hasMessagingBridgeEvidence,isDiscordCommunityAcquisitionSurface,isDotlessHostnameUrl,isMessagingPreviewUrl,isAuxiliaryTriageCandidate,isAuxiliaryForOutcome,acquisitionOwnershipUrl,isPageAssetInfrastructureUrl,rankCommunitySurfaces,scoreCommunitySurface,assessCrawlAdmission,recoverTruncatedQueryToRoot,isPossiblyTruncatedPath} from './communitySurfacePolicy';
import { isAcquisitionLadderEnabled, resolveRenderEscalation, selectSameSiteSitemapSeedCandidates, selectStructuredNavigationCandidates, MAX_LADDER_SITEMAP_SEEDS, MAX_LADDER_PROFILE_RUNS_PER_INSPECTION, ACQUISITION_LADDER_POLICY_VERSION } from './acquisitionLadder';
import { shouldFollowDestination, selectDiverseNavigationQueue, createDestinationBudget } from './destinationPolicy';
import { CRAWLER_MAX_REDIRECT_HOPS, extractHeadDiscovery, fetchProfilerUrl, isSiteProfilerEnabled, runSiteProfiler, type ProfilerTransportFailure } from './siteProfiler';
import {clampRetryAtTimestamp, communityAcquisitionRetryDirective, isCommunityRetryableObservation, retryAtFromUnknown, type CommunityRetryDirective} from './communityRetryPolicy';
import {renderedCrawlerTelemetry, staticCrawlerTelemetry, createDropCounter, type CrawlerTelemetry, type CeilingKind, type ExperimentAttribution} from './crawlerTelemetry';
import {fetchUrlFailureHistory, skippedUrlsFromHistory, normalizeSkipUrl, hasConsecutiveTimeoutExhaustion, type UrlFailureRow} from './crawlUrlSkipPolicy';
import { MAX_CRAWL_RESPONSE_CHARS, readBoundedResponseText } from './crawlResponseBounds';
import { assessPublicDestination, defaultDnsResolve, PUBLIC_DESTINATION_DNS_TIMEOUT_MS, type DnsResolver } from './publicDestination';
import { withPinnedExternalFetch } from './pinnedExternalFetch';
import { classifyUrlRelevance, type RelevanceDecision } from './acquisitionRelevance';
import {
  isRelevanceEnforcementEnabled,
  isLoginBlockSemanticsEnabled,
  isPathAwareShortlinkBorrowEnabled,
  isPartialStaticRetryEnabled,
} from './r6FollowupFlags';
import { isConfirmedLoginWall, LOGIN_WALL_FAILURE_CLASS, isConfirmedPaywall, PAYWALL_FAILURE_CLASS } from './loginWallDetection';
import { hasBlockMarkers } from './permanentBlockDetection';
import { isConclusivePermanentBlock, PERMANENT_ACCESS_BLOCK_FAILURE_CLASS } from './permanentBlockDetection';
import { assessStaticNotFoundBody, isConfirmedStaticTerminalNotFound, markConfirmedStaticTerminalNotFound } from './staticTerminalNotFound';
import { STATIC_BUDGET_GAP_FAILURE_CLASS } from './communityRetryPolicy';

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
      // Upgrade an earlier ID-less observation of the same text instead of
      // counting the same upload twice when a later sample supplies its ID.
      // Distinct videos that merely share text still count separately below.
      const idlessIndex = merged.findIndex(existing => !existing.videoId && existing.description === item.description);
      if (idlessIndex >= 0) merged[idlessIndex] = item;
      else merged.push(item);
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
  /**
   * Normalized seed URLs whose consecutive rendered-timeout tail is exhausted
   * (see `hasConsecutiveTimeoutExhaustion`). Their observations keep full
   * outcome/status accounting; they only lose retry ownership, and the queue
   * projection uses this list so status and job scheduling stay consistent.
   */
  retrySuppressedUrls?: string[];
  /** Per-seed click-window progress after this inspection: previous offsets
   * plus the controls this run actually examined. The queue persists this in
   * the retry job payload so a failure before any control was clicked reuses
   * the same window instead of skipping it. */
  nextClickOffsets?: Record<string, number>;
  discordCandidates?: DiscordCandidate[];
  /** P4 platform-community evidence observed during this inspection
   * (Whop/Skool/Circle/Patreon). Projected as COMMUNITY_INDICATED_NO_INVITE /
   * PAID_COMMUNITY_INDICATED; never an invite. */
  communityIntent?: CommunityIntentEvidence[];
}
export type ExternalAcquisitionStatus='FOUND'|'INSPECTED_NO_MATCH'|'PARTIALLY_INSPECTED'|'ACQUISITION_FAILED';
export type AcquisitionSurface='YOUTUBE_ABOUT'|'RECENT_VIDEO_DESCRIPTIONS'|'CHANNEL_EXTERNAL_LINKS'|'CREATOR_WEBSITES'|'SOCIAL_PROFILES'|'DISCORD_VALIDATION';
export interface ExternalAcquisitionObservation {requestedUrl:string;finalUrl?:string;wrapperUrl?:string;surface:AcquisitionSurface;required:boolean;outcome:ExternalAcquisitionStatus;retryable:boolean;httpStatus?:number;failureClass?:string;retryAt?:number;detail:string;observedAt:string;telemetry?:CrawlerTelemetry;rootUrl?:string;/** Body-level confirmation from the bounded static 404/410 probe. This is not a skip: the whole seed predicate must also pass. */staticNotFoundBodyConfirmed?:boolean;staticNotFoundBodyReason?:string;/** True only when rendered escalation was actually skipped for this seed; persisted provenance for post-deploy measurement. The observation itself stays FAILED/non-retryable. */staticTerminalNotFound?:boolean;staticTerminalNotFoundReason?:string;/** Lender seed URL when this row references shared same-inspection evidence instead of a direct fetch. The lender inspected the bytes; this row carries no page counters of its own. */sharedEvidenceFrom?:string}

/** Advance per-seed click-window progress only by controls this inspection
 * actually started clicking. A failed/zero-page run contributes nothing, so a
 * retry reuses the same window instead of skipping it. Progress per seed is
 * capped at one page budget: telemetry aggregates pages, and every page starts
 * at the same rotation offset, so summing page clicks would over-advance. */
export function nextRenderedClickOffsets(
  previous: Record<string, number> | null | undefined,
  outcomes: Array<{ requestedUrl?: string; telemetry?: { clicksStarted?: number } }> | null | undefined,
  maxClicksPerPage = 4,
): Record<string, number> {
  const next = new Map<string, number>();
  for (const [url, value] of Object.entries(previous || {})) {
    const key = normalizeVisitUrl(url);
    const offset = Math.max(0, Math.trunc(Number(value)) || 0);
    if (key && offset > 0) next.set(key, offset);
  }
  const observed = new Map<string, number>();
  for (const outcome of outcomes || []) {
    const key = normalizeVisitUrl(outcome?.requestedUrl || '');
    if (!key) continue;
    const clicks = Math.max(0, Math.trunc(Number(outcome?.telemetry?.clicksStarted)) || 0);
    if (clicks > 0) observed.set(key, Math.max(observed.get(key) || 0, clicks));
  }
  const windowSize = Math.max(1, Math.trunc(maxClicksPerPage) || 4);
  for (const [key, clicks] of observed) {
    next.set(key, (next.get(key) || 0) + Math.min(windowSize, clicks));
  }
  return Object.fromEntries([...next].filter(([, offset]) => offset > 0));
}


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
    // R6 admission boundary (shared, generic): malformed/non-public and
    // asset/resource URLs never become crawl candidates. This runs before
    // scoring/ranking and crawling on every admission path.
    if(!assessCrawlAdmission(parsed.toString()).eligible)return null;
    parsed.hash='';
    for(const key of [...parsed.searchParams.keys()])if(/^utm_|^(fbclid|gclid|feature)$/i.test(key))parsed.searchParams.delete(key);
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

/**
 * Derive creator-canonical website hosts from channel links for Discord
 * ownership inference. Uses the same normalized destinations acquisition
 * crawls (YouTube redirects unwrapped, tracking params stripped): only
 * WEBSITE-kind hosts qualify, shared/multi-tenant community hosts are
 * excluded (a link proves reference, never ownership), and a leading www.
 * is stripped so aliases match consistently on both comparison sides.
 */
export function creatorWebsiteHostsFromLinks(links: Array<string | null | undefined>): string[] {
  const hosts = new Set<string>();
  for (const link of links) {
    if (!link || typeof link !== 'string') continue;
    const normalized = normalizeExternalUrl(link);
    if (!normalized || normalized.kind !== 'WEBSITE') continue;
    let host = '';
    try { host = new URL(normalized.url).hostname.toLowerCase().replace(/^www\./, ''); } catch { continue; }
    if (!host.includes('.')) continue;
    // Boundary-safe shared-host exclusion: both the platform host itself and
    // any tenant subdomain (e.g. community.circle.so) are multi-tenant and
    // can never be creator-canonical. Exact-match checks alone would admit
    // every tenant subdomain as owned.
    const shared = [...CROSS_DOMAIN_COMMUNITY_HOSTS].some(
      entry => host === entry || host === entry.replace(/^www\./, '') || host.endsWith(`.${entry.replace(/^www\./, '')}`),
    );
    if (shared) continue;
    hosts.add(host);
  }
  return Array.from(hosts);
}

/**
 * Resolver selection for the crawler. The real resolver is the default for
 * every fetch implementation, including injected/proxy fetches. Tests that use
 * fixture-only hostnames must pass an explicit resolver; there is deliberately
 * no synthetic-public fallback, because that would fail open for a production
 * caller that injects an instrumented fetch. Connection-time pinning is still
 * only available on the real fetch (see pinnedExternalFetch.ts).
 */
// Keep the crawler's existing request identity. The shared bounded fetch now
// owns redirects, but switching User-Agent/Accept headers would independently
// change what origins serve and make this security fix harder to review.
const CRAWLER_FETCH_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};

const CRAWLER_FETCH_TIMEOUT_MS = 10_000;

function resolverForFetch(_fetchImpl: typeof fetch, resolveHost?: DnsResolver): DnsResolver {
  return resolveHost ?? defaultDnsResolve;
}

async function fetchExternalPage(url:string,fetchImpl:typeof fetch,resolveHost?:DnsResolver,probeTerminalNotFoundBody=false):Promise<{page:{html:string;finalUrl:string;truncated:boolean}|null;observation?:Omit<ExternalAcquisitionObservation,'surface'|'required'|'observedAt'|'wrapperUrl'>}> {
  const resolver=resolverForFetch(fetchImpl,resolveHost);
  // The end-to-end budget starts before the admission lookup. The lookup gets
  // only the remaining slice, and the following fetch gets what is left after
  // DNS; a 3s resolver can therefore never add 3s on top of a 10s fetch.
  const fetchStartedAt=Date.now();
  // Initial destination check happens BEFORE any request. This covers seeds
  // that bypass admission (for example a direct messaging-preview call) and
  // rejects public-looking hostnames that currently resolve to private space.
  // DNS failure/timeout stays retryable and is classified separately from a
  // deliberate non-public block; malformed URLs are input errors, not SSRF.
  const initial=await assessPublicDestination(
    url,
    resolver,
    Math.min(
      PUBLIC_DESTINATION_DNS_TIMEOUT_MS,
      Math.max(1, CRAWLER_FETCH_TIMEOUT_MS - (Date.now() - fetchStartedAt)),
    ),
  );
  if(!initial.allowed){
    const nonPublic=initial.reason==='NON_PUBLIC_ADDRESS'||initial.reason==='NON_PUBLIC_RESOLVED_ADDRESS'||initial.reason==='NON_HTTP_SCHEME';
    const failureClass=nonPublic?'SSRF_BLOCKED':initial.reason==='DNS_TIMEOUT'?'TIMEOUT':initial.reason==='DNS_RESOLUTION_FAILED'?'NETWORK_FAILURE':'INVALID_URL';
    const retryable=initial.reason==='DNS_RESOLUTION_FAILED'||initial.reason==='DNS_TIMEOUT';
    const detail=nonPublic
      ? `Blocked non-public destination (${initial.reason})${initial.hostname?`: ${initial.hostname}`:''}`
      : initial.reason==='DNS_TIMEOUT'
        ? `Destination DNS lookup timed out${initial.hostname?`: ${initial.hostname}`:''}`
        : initial.reason==='DNS_RESOLUTION_FAILED'
          ? `Destination DNS lookup failed${initial.hostname?`: ${initial.hostname}`:''}`
          : `Invalid destination (${initial.reason})`;
    return {page:null,observation:{requestedUrl:url,finalUrl:url,outcome:'ACQUISITION_FAILED',retryable,failureClass,detail}};
  }
  // Redirects are followed manually inside fetchProfilerUrl; every Location
  // is resolved and checked against the same public-destination guard before
  // it is contacted. The wrapper pins DNS at connect time for the real fetch.
  let transportFailure:ProfilerTransportFailure|undefined;
  const fetched=await fetchProfilerUrl(
    url,
    withPinnedExternalFetch(fetchImpl),
    MAX_CRAWL_RESPONSE_CHARS,
    Math.max(1, CRAWLER_FETCH_TIMEOUT_MS - (Date.now() - fetchStartedAt)),
    resolver,
    CRAWLER_FETCH_HEADERS,
    {
    maxHops:CRAWLER_MAX_REDIRECT_HOPS,
    onTransportError:failure=>{transportFailure=failure;},
    // Preserve the pre-refactor acquisition contract: only read a final body
    // when it can be page content, or for the bounded 401/403 block-marker
    // probe. A stalled 429/5xx or binary body must not consume the 10s budget
    // or hide Retry-After from the observation.
    shouldReadFinalBody:response=>{
      const contentType=response.headers.get('content-type')||'';
      if(response.status===401||response.status===403)return true;
      // Bounded 404/410 probe (seed only): only declared text-like error
      // bodies can prove a plain terminal page. Untyped, JSON, and binary
      // bodies stay unread and therefore keep the rendered path (no body
      // evidence is never terminal evidence). Child-page 404s are never used
      // by the terminal barrier, so they keep the pre-existing body-
      // suppression behavior.
      if(probeTerminalNotFoundBody&&(response.status===404||response.status===410)){
        const type=contentType.toLowerCase();
        const charset=/charset\s*=\s*"?([^";]+)/i.exec(type)?.[1]?.trim()||'';
        // The probe reader decodes UTF-8 only. UTF-16/32 bodies would hide
        // links behind NUL bytes, so leave them unread and render-eligible.
        if(charset.startsWith('utf-16')||charset.startsWith('utf-32'))return false;
        return type.includes('text/')||type.includes('application/xhtml+xml')||type.includes('application/xml')||type.includes('+xml');
      }
      if(response.status<200||response.status>=300)return false;
      return contentType.includes('text/html')||contentType.includes('json')||contentType.includes('plain');
    },
    ...(probeTerminalNotFoundBody?{terminalNotFoundBodyMaxChars:64_000,terminalNotFoundBodyTimeoutMs:1_500}:{}),
  });
  if(!fetched){
    const timedOut=transportFailure?.name==='AbortError'||Date.now()-fetchStartedAt>=9900;
    const connectionBlocked=transportFailure?.code==='ESSRFBLOCKED'||transportFailure?.causeCode==='ESSRFBLOCKED';
    const failureClass=connectionBlocked?'SSRF_BLOCKED':timedOut?'TIMEOUT':'NETWORK_FAILURE';
    const cause=transportFailure
      ? ` (${transportFailure.name}${transportFailure.code?`:${transportFailure.code}`:''}${transportFailure.causeCode?`/${transportFailure.causeCode}`:''}: ${transportFailure.message})`
      : '';
    return {page:null,observation:{requestedUrl:url,outcome:'ACQUISITION_FAILED',retryable:!connectionBlocked,failureClass,detail:connectionBlocked?`Blocked non-public DNS answer at connection time${cause}`:timedOut?`External fetch timed out${cause}`:`External fetch failed${cause}`}};
  }
  if(fetched.redirectFailure){
    const target=fetched.rejectedRedirect?`: ${fetched.rejectedRedirect}`:'';
    switch(fetched.redirectFailure){
      case 'NON_PUBLIC_DESTINATION':
        return {page:null,observation:{requestedUrl:url,finalUrl:fetched.finalUrl,outcome:'ACQUISITION_FAILED',retryable:false,httpStatus:fetched.status,failureClass:'SSRF_BLOCKED',detail:`Blocked redirect to non-public destination${target}`}};
      case 'MALFORMED_LOCATION':
        return {page:null,observation:{requestedUrl:url,finalUrl:fetched.finalUrl,outcome:'ACQUISITION_FAILED',retryable:false,httpStatus:fetched.status,failureClass:'INVALID_REDIRECT',detail:`Malformed redirect Location${target}`}};
      case 'DNS_RESOLUTION_FAILED':
        return {page:null,observation:{requestedUrl:url,finalUrl:fetched.finalUrl,outcome:'ACQUISITION_FAILED',retryable:true,httpStatus:fetched.status,failureClass:'NETWORK_FAILURE',detail:`Redirect destination DNS lookup failed${target}`}};
      case 'DNS_TIMEOUT':
        return {page:null,observation:{requestedUrl:url,finalUrl:fetched.finalUrl,outcome:'ACQUISITION_FAILED',retryable:true,httpStatus:fetched.status,failureClass:'TIMEOUT',detail:`Redirect destination DNS lookup timed out${target}`}};
      case 'REDIRECT_LOOP':
        return {page:null,observation:{requestedUrl:url,finalUrl:fetched.finalUrl,outcome:'ACQUISITION_FAILED',retryable:false,httpStatus:fetched.status,failureClass:'REDIRECT_LOOP',detail:`Redirect loop detected${target}`}};
      case 'REDIRECT_LIMIT':
        return {page:null,observation:{requestedUrl:url,finalUrl:fetched.finalUrl,outcome:'ACQUISITION_FAILED',retryable:true,httpStatus:fetched.status,failureClass:'REDIRECT_LIMIT',detail:`Redirect hop limit reached${target}`}};
    }
  }
  if(fetched.redirectRejected){
    return {page:null,observation:{requestedUrl:url,finalUrl:fetched.finalUrl,outcome:'ACQUISITION_FAILED',retryable:false,httpStatus:fetched.status,failureClass:'SSRF_BLOCKED',detail:`Blocked redirect to non-public destination${fetched.rejectedRedirect?`: ${fetched.rejectedRedirect}`:''}`}};
  }
  const contentType=fetched.contentType||'';
  if(fetched.status<200||fetched.status>=300){
    // Uncertain barrier → retryable (only conclusive permanent barriers go
    // terminal): 401/403 stay retryable until the bounded identical-history
    // + markers rule establishes permanence at the seed loop. 429/5xx keep
    // existing retryable behavior with Retry-After clamping.
    const retryable=fetched.status===429||fetched.status>=500||fetched.status===401||fetched.status===403;
    const retryAfter=fetched.retryAfter||'',retryAfterSeconds=Number(retryAfter),retryAt=retryable?(Number.isFinite(retryAfterSeconds)?clampRetryAtTimestamp(Date.now()+Math.max(0,retryAfterSeconds*1000)):clampRetryAtTimestamp(Date.parse(retryAfter)||undefined)):undefined;
    // Permanent-block content probe (additive, still a failure): the bounded
    // body was already read by fetchProfilerUrl, so markers are evaluated on
    // the same bytes the old response probe used.
    const blockMarkers=(fetched.status===401||fetched.status===403)&&hasBlockMarkers(fetched.text);
    // Optional-surface terminal evidence (additive; the observation remains a
    // visible FAILED/non-retryable HTTP_ERROR). Only a readable, complete,
    // link-free/no-community 404/410 body qualifies; every uncertain case
    // keeps the existing rendered escalation.
    const staticNotFound=(probeTerminalNotFoundBody&&(fetched.status===404||fetched.status===410))
      ? assessStaticNotFoundBody({
          text:fetched.text,
          truncated:fetched.truncated,
          bodySuppressed:fetched.bodySuppressed===true,
          bodyProbeFailed:fetched.bodyProbeFailed===true,
        })
      : null;
    return {page:null,observation:{requestedUrl:url,finalUrl:fetched.finalUrl,outcome:'ACQUISITION_FAILED',retryable,httpStatus:fetched.status,failureClass:fetched.status===429?'RATE_LIMIT':fetched.status>=500?'TRANSIENT_HTTP':'HTTP_ERROR',retryAt,detail:`HTTP ${fetched.status}`,...(blockMarkers?{blockMarkers:true}:{}),...(staticNotFound?.confirmed?{staticNotFoundBodyConfirmed:true,staticNotFoundBodyReason:staticNotFound.reason}:{})}};
  }
  if(!contentType.includes('text/html')&&!contentType.includes('json')&&!contentType.includes('plain'))return {page:null,observation:{requestedUrl:url,finalUrl:fetched.finalUrl,outcome:'ACQUISITION_FAILED',retryable:false,httpStatus:fetched.status,failureClass:'UNSUPPORTED_CONTENT_TYPE',detail:`Unsupported content type ${contentType||'unknown'}`}};
  return {page:{html:fetched.text,finalUrl:fetched.finalUrl,truncated:fetched.truncated}};
}

export interface ExternalDiscordCrawlResult {foundInvite:string|null;foundLocation?:string;details:string;outcome:ExternalAcquisitionStatus;observations:ExternalAcquisitionObservation[];candidates:DiscordCandidate[];domainWeightShadows?:DomainWeightShadowEvaluation[];/** Terminal-success page URLs (finals) in visit order for the shared-evidence registry. Additive; absent on early failure paths. */visitedUrls?:string[];/** Root-page scored navigation targets (single-seed calls) for lender inventory. Additive. */rootNavigation?:Array<{url:string;score:number}>;/** P4 platform-community evidence observed while crawling (Whop/Skool/Circle/Patreon). Never an invite; absent means no evidence. */communityIntent?:CommunityIntentEvidence[]}

/**
 * Shared static lender inventory (v2 L1): terminal-success root inspections
 * keyed by normalized visit identity, carrying the lender's scored root
 * navigation so a borrower can skip the duplicate root fetch yet still
 * acquire its own children. Same-inspection scope only; rendered-tier needs
 * never consult it (tier monotonicity).
 */
export interface SharedStaticRootRecord {
  bySeed: string;
  finalUrl: string;
  childLinks: Array<{ url: string; score: number }>;
  /** Site-level Whop/Skool/Circle/Patreon evidence observed by the lender.
   * Replayed to borrowers that reuse the lender's root bytes; never an invite
   * and never an ownership claim. Optional for pre-existing inventories. */
  communityIntents?: CommunityIntentEvidence[];
  terminalSuccess?: boolean;
}

export interface SharedStaticInventory {
  visitedKeys: string[];
  // terminalSuccess marks lender records proven terminal-success at the
  // static tier. Lookup refuses explicit `false` records (truncated lenders)
  // so borrowers never inherit cut coverage; missing flags predate the gate
  // and are treated as terminal (they were fed under it).
  roots: Map<string, SharedStaticRootRecord>;
}

/**
 * Shared-root lender gate (v2 L1): a static root inspection is reusable only
 * when its evidence proves terminal success at the static tier — a clean or
 * FOUND crawl outcome with a fetched root and recorded navigation. A
 * truncated/incomplete (PARTIAL) or failed lender root never enters the
 * shared inventory, so a borrower can never inherit cut coverage. Pure.
 */
export function isReusableStaticRootLender(result: {
  outcome: unknown;
  visitedUrls?: unknown;
  rootNavigation?: unknown;
}): boolean {
  if (result.outcome !== 'INSPECTED_NO_MATCH' && result.outcome !== 'FOUND') return false;
  if (!Array.isArray(result.visitedUrls) || result.visitedUrls.length === 0) return false;
  return Array.isArray(result.rootNavigation);
}

/** Builds the reusable shared-root record for a terminal-success lender.
 * Community intent rides with the lender's root evidence because a borrower
 * skips the root fetch entirely; dropping it here would erase a Whop/Skool/
 * Circle/Patreon signal for every later borrower. Pure and exported so the
 * feed and replay contracts are directly testable. */
export function buildSharedStaticRootRecord(
  seedUrl: string,
  result: {
    outcome: unknown;
    visitedUrls?: unknown;
    rootNavigation?: unknown;
    communityIntent?: CommunityIntentEvidence[];
  },
): SharedStaticRootRecord | null {
  if (!isReusableStaticRootLender(result)) return null;
  const rootKey = normalizeVisitUrl(seedUrl);
  if (!rootKey) return null;
  return {
    bySeed: seedUrl,
    finalUrl: (result.visitedUrls as string[])[0],
    childLinks: result.rootNavigation as Array<{ url: string; score: number }>,
    communityIntents: Array.isArray(result.communityIntent) ? result.communityIntent : [],
    terminalSuccess: true,
  };
}

function preserveResolvedWrapperProvenance(wrapperCandidate:DiscordCandidate,nativeCandidates:DiscordCandidate[]):DiscordCandidate[]{
  return nativeCandidates.map(native=>{
    if(!native.nativeInviteCode)return native;
    const {candidateId:_,canonicalInviteId:__,ownershipStatus:___,ownershipConfidence:____,ownershipReasons:_____,...base}=wrapperCandidate;
    return makeDiscordCandidate({...base,nativeInviteCode:native.nativeInviteCode,normalizedLocator:`https://discord.gg/${native.nativeInviteCode}`,sourceUrl:native.sourceUrl||wrapperCandidate.sourceUrl,extractionConfidence:'RESOLVED',observations:[...(wrapperCandidate.observations||[]),...(native.observations||[])]});
  });
}

/** Bounded static acquisition that retains every Discord candidate observed
 * within the page budget. A first invite is evidence, not a stop condition. */
export async function crawlExternalLinks(links:string[],logDetails:string[]=[],debugLog?:any,fetchImpl:typeof fetch=fetch,surface:AcquisitionSurface='CREATOR_WEBSITES',required=false,wrapperUrl?:string,ladderStructured?:boolean,frontier?:FrontierCrawlOptions,seedAdmission?:{admitted:number;considered:number}|null,evaluateDomainWeights?:boolean,preVisited?:string[]|SharedStaticInventory,r6Options?:{loginSemantics?:boolean;partialStaticRetry?:boolean},resolveHost?:DnsResolver):Promise<ExternalDiscordCrawlResult>{
  let scannedCount=0;const observations:ExternalAcquisitionObservation[]=[];const discovered:DiscordCandidate[]=[];const domainWeightShadows:DomainWeightShadowEvaluation[]=[];const communityIntents:CommunityIntentEvidence[]=[];
  // Shared-visit pre-seeding (v2 L1): terminal-success finals inspected by an
  // earlier same-inspection crawl are never refetched. Same-tier evidence
  // only (static tier here); higher-tier needs are unaffected. Accepts raw
  // key lists or a lender inventory (whose root records additionally let a
  // borrower skip a duplicate root fetch yet still acquire its own children
  // from the lender's scored navigation).
  const sharedRoots = preVisited && typeof preVisited === 'object' && !Array.isArray(preVisited)
    ? (preVisited as SharedStaticInventory).roots
    : undefined;
  const sharedKeyList: string[] = Array.isArray(preVisited)
    ? preVisited
    : ((preVisited as SharedStaticInventory | undefined)?.visitedKeys || []);
  const sharedVisited=new Set(sharedKeyList.map(u=>normalizeVisitUrl(u)).filter((k):k is string=>typeof k==='string'&&k.length>0));
  const sharedKey=(u:string):string|null=>normalizeVisitUrl(u);
  const crawledUrls:string[]=[];
  let rootNavigation: Array<{ url: string; score: number }> | undefined;
  for(const rawUrl of links){
    if(!rawUrl||typeof rawUrl!=='string')continue;let url=rawUrl.trim();if(!url.startsWith('http://')&&!url.startsWith('https://'))url=`https://${url}`;
    // R6 admission boundary (shared): rejected candidates never reach scoring
    // or fetching on any path. No observation is recorded for them, so they
    // can never own retry work either.
    const admission=assessCrawlAdmission(url);if(!admission.eligible){logDetails.push(`Admission rejected (${admission.reasonCode}): ${url}; not crawled.`);continue;}
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
    // P-C per-seed frontier state (flag-gated): declared before first use so
    // root accounting below never hits temporal-dead-zone errors.
    const frontierOn=frontier?.enabled===true&&!!frontier?.siteIdentity;
    // Experiment attribution for the persisted seed observation below
    // (observational only): names the active experimental treatments so
    // ladder/frontier crawls stay distinguishable from legacy crawls in the
    // ledger. Absent on legacy crawls, leaving persisted rows byte-identical.
    // Stopping reason joins at the observation site from the persisted
    // ceiling (only the arbiter sets 'frontier-yield').
    const seedExperimentAttribution: ExperimentAttribution | undefined = (ladderStructured || frontierOn || !!seedAdmission)
      ? {
          policies: [...(frontierOn ? [FRONTIER_POLICY_VERSION] : []), ...((ladderStructured || seedAdmission) ? [ACQUISITION_LADDER_POLICY_VERSION] : [])],
          method: frontierOn ? 'frontier-crawl' : ladderStructured ? 'structured-navigation' : seedAdmission ? 'sitemap-seed' : undefined,
          ...(seedAdmission ? { admittedSeeds: seedAdmission.admitted, consideredSeeds: seedAdmission.considered } : {}),
        }
      : undefined;
    const frontierYieldHistory:number[]=[];
    let frontierEvidenceUnits=0;
    let frontierBlockedTerminals=0;
    // P-C frontier instrumentation (flag-gated): best-effort coverage and
    // admission writers. State above; flag off leaves the loop below
    // byte-identical to legacy behavior.
    const frontierRecordCoverage=(pageUrl:string,terminalState:string,method:string,evidenceUnits:number)=>{
      if(!frontierOn||!frontier?.siteIdentity)return Promise.resolve();
      const coverage=recordPageCoverage({siteIdentity:frontier.siteIdentity,pageKey:pageUrl,pageUrl,terminalState,acquisitionMethod:method,evidenceUnits,policyVersion:FRONTIER_POLICY_VERSION,weightVersion:frontier.weightVersion||''}).catch(()=>undefined);
      // P-D production data path (observational only): completed inspections
      // feed route statistics for the OFFLINE learner. Blocked/unreachable/
      // truncated/incomplete terminals carry no complete yield information
      // and are never recorded as attempts (never negative evidence). Best-effort like all
      // observational writes; failures never affect the crawl. Nothing here
      // is ever read back for routing, budgets, or stopping — the learner
      // runs offline and serving never consumes its weights.
      let stats:Promise<void>=Promise.resolve();
      if(shouldAccumulateRouteObservation(terminalState)){
        const pattern=routePatternFor(pageUrl);
        if(pattern){
          const sink=frontier.routeStatsSink||accumulateRouteStats;
          stats=sink({siteIdentity:frontier.siteIdentity,routePattern:pattern,evidenceUnits,observedAt:new Date().toISOString()}).catch(()=>undefined);
        }
      }
      return Promise.all([coverage,stats]).then(()=>undefined);
    };
    const frontierAdmitChildren=async (children:Array<{url:string;score:number}>,depth:number)=>{
      if(!frontierOn||!frontier?.siteIdentity)return;
      try{
        // Per-site admission cap: the persisted queue is bounded no matter
        // how many inspections discover the same site. Skips are silent by
        // design (in-memory navigation is unaffected).
        const queued=await countFrontierQueue(frontier.siteIdentity);
        if(queued>=MAX_FRONTIER_QUEUE_PER_SITE)return;
        await Promise.all(children.slice(0,12).map(child=>{
          const scored=scoreFrontierCandidate({url:child.url,hintScore:child.score,depth,attempts:0,sitemapListed:false,structuredNominated:false});
          return upsertFrontierQueueItem({siteIdentity:frontier.siteIdentity!,urlKey:child.url,url:child.url,expectedValue:scored.expectedValue,nominatingSource:'NAVIGATION',sourceDetail:{depth},weightVersion:frontier.weightVersion||'',scorerInputs:{hintScore:child.score,depth},decision:{admittedAt:new Date().toISOString()}});
        }));
      }catch{/* admission is best-effort persistence, never crawl behavior */}
    };
    const lookupSharedStaticRoot=(u:string):SharedStaticRootRecord|null=>{const key=sharedKey(u);if(!key||!sharedRoots)return null;const rec=sharedRoots.get(key)||null;if(rec&&rec.terminalSuccess===false)return null;return rec;};
    const sharedRoot=lookupSharedStaticRoot(url);
    let page:{html:string;finalUrl:string;truncated:boolean}|null;
    let fetchFailure:{httpStatus?:number;failureClass?:string}|undefined;
    if(sharedRoot){
      logDetails.push(`[Shared static evidence] ${url} reuses root inspection from ${sharedRoot.bySeed}; child acquisition continues below.`);
      if(sharedRoot.communityIntents?.length)communityIntents.push(...sharedRoot.communityIntents);
      page={html:'',finalUrl:sharedRoot.finalUrl,truncated:false};
    }else{
      // The terminal 404/410 barrier only ever consumes the seed's own
      // observation, so only seed fetches pay for the bounded body probe.
      const acquired=await fetchExternalPage(url,fetchImpl,resolveHost,true);
      page=acquired.page;
      if(acquired.observation){observations.push({...acquired.observation,wrapperUrl,surface,required,rootUrl:url,observedAt:new Date().toISOString(),telemetry:staticCrawlerTelemetry({redirectsFollowed,pagesInspected})});fetchFailure=acquired.observation;}
    }
    // A truncated prefix is incomplete coverage, never a complete inspection:
    // force the partial path so a cut-off response can never resolve a
    // definitive clean negative for this seed.
    let truncatedResponse=page?.truncated===true;if(truncatedResponse){seedCeiling??='response-cap';drops.count('response-cap');}
    if(debugLog&&page)debugLog.redirectsFollowed.push({from:url,to:page.finalUrl});if(page&&page.finalUrl!==url)redirectsFollowed++;if(!page){
      // A direct platform link that could not be fetched is still observed
      // intent: the creator linked a Whop/Skool/Circle/Patreon surface. Record
      // the URL as UNKNOWN rather than letting acquisition failure erase it.
      try{communityIntents.push(...extractCommunityIntentEvidence({pageUrl:url,html:''}));}catch{/* intent evidence is best-effort */}
      if(frontierOn){
        const failedRoot=fetchFailure;
        const terminal=classifyBlockedAcquisition({httpStatus:failedRoot?.httpStatus,failureClass:failedRoot?.failureClass,timedOut:failedRoot?.failureClass==='TIMEOUT',transportFailed:failedRoot?.failureClass==='NETWORK_FAILURE'});
        if(terminal!=='OK')frontierBlockedTerminals+=1;
        await frontierRecordCoverage(url,terminal==='OK'?'ACQUISITION_FAILED':terminal,'HTTP_STATIC',0);
      }
      logDetails.push(`Failed or timed out trying to reach external URL: ${url}`);continue;
    }
    crawledUrls.push(page.finalUrl);

    const inspectPage=(current:{html:string;finalUrl:string},depth:number,truncated=false):Array<{url:string;score:number}>=>{
      pagesInspected++;logDetails.push(`Successfully loaded ${current.finalUrl} (${current.html.length} bytes, depth ${depth})`);
      const pageCandidates=extractDiscordCandidates(`${current.finalUrl}\n${current.html}`,surface,current.finalUrl).filter(candidate=>candidate.nativeInviteCode);
      discovered.push(...pageCandidates);
      // P4: platform-community evidence on every inspected page (best-effort:
      // evidence extraction never breaks crawling or invite discovery). A
      // confirmed paywall on a child platform page is paid intent too; a
      // truncated prefix is never decisive. FOUND pages never become paywalls.
      let pagePaywall=false;
      try{pagePaywall=truncated!==true&&pageCandidates.length===0&&isConfirmedPaywall({finalUrl:current.finalUrl,html:current.html,hasCandidates:false});}catch{pagePaywall=false;}
      try{communityIntents.push(...extractCommunityIntentEvidence({pageUrl:current.finalUrl,html:current.html,confirmedPaywall:pagePaywall}));}catch{/* intent evidence is best-effort */}
      const $=cheerio.load(current.html),navigation:Array<{url:string;score:number;from?:string}>=[];
      $('a[href]').each((_,el)=>{const href=($(el).attr('href')||'').trim(),label=$(el).text().trim();if(!href)return;const anchorCandidates=extractDiscordCandidates(`${href} ${label}`,surface,current.finalUrl).filter(candidate=>candidate.nativeInviteCode);if(anchorCandidates.length){for(const candidate of anchorCandidates){candidate.observations=(candidate.observations||[]).map(obs=>({...obs,sourceAnchorText:label,sourcePageDepth:depth}));discovered.push(candidate);}return;}try{const absolute=new URL(href,current.finalUrl);absolute.hash='';if(!['http:','https:'].includes(absolute.protocol)){drops.countUnique('invalid-protocol',href);return;}const decision=shouldFollowDestination({url:absolute.toString(),currentUrl:current.finalUrl,anchorText:label,baseScore:communityNavigationScore(absolute.pathname+absolute.search,label)});if(!decision.eligible){drops.countUnique(decision.reason==='admission-rejected'?'admission-rejected':'cross-origin-disallowed',absolute.toString());return;}navigation.push({url:absolute.toString(),score:decision.score,from:current.finalUrl});}catch{drops.countUnique('invalid-protocol',href);}});
      for(const rawTarget of extractDynamicTargetValues(current.html)){const target=rawTarget.trim();const targetCandidates=extractDiscordCandidates(target,surface,current.finalUrl).filter(candidate=>candidate.nativeInviteCode);if(targetCandidates.length){discovered.push(...targetCandidates);continue;}try{const absolute=new URL(target,current.finalUrl);absolute.hash='';if(!['http:','https:'].includes(absolute.protocol)){drops.countUnique('invalid-protocol',target);continue;}const decision=shouldFollowDestination({url:absolute.toString(),currentUrl:current.finalUrl,anchorText:target,baseScore:communityNavigationScore(absolute.pathname+absolute.search,target)});if(!decision.eligible){drops.countUnique(decision.reason==='admission-rejected'?'admission-rejected':'cross-origin-disallowed',absolute.toString());continue;}navigation.push({url:absolute.toString(),score:decision.score,from:current.finalUrl});}catch{drops.countUnique('invalid-protocol',target);}}
      // P-B ladder structured step (flag-gated): sameAs/canonical inventory
      // joins navigation under identical scoring, cross-origin, and budget
      // rules. Flag off skips this block entirely (legacy navigation only).
      if(ladderStructured){try{
        const head=extractHeadDiscovery(current.html,current.finalUrl);
        for(const candidate of selectStructuredNavigationCandidates({canonicalHrefs:head.canonicalHrefs,jsonLdSameAs:head.jsonLdSameAs},current.finalUrl)){
          if(visited.has(candidate.url)){drops.countUnique('already-visited',candidate.url);continue;}
          const structuredAdmission=assessCrawlAdmission(candidate.url);if(!structuredAdmission.eligible){drops.countUnique('admission-rejected',candidate.url);continue;}
          const absolute=new URL(candidate.url);
          const structuredDecision=shouldFollowDestination({url:absolute.toString(),currentUrl:current.finalUrl,structuredNominated:true,baseScore:candidate.score});
          if(!structuredDecision.eligible){drops.countUnique(structuredDecision.reason==='admission-rejected'?'admission-rejected':'cross-origin-disallowed',absolute.toString());continue;}
          navigation.push({url:absolute.toString(),score:structuredDecision.score,from:current.finalUrl});
        }
      }catch{/* structured inventory never breaks navigation */}}
      navigation.sort((a,b)=>b.score-a.score);return navigation;
    };

    const visited=new Set<string>([page.finalUrl,url]);const beforeRootYield=discovered.length;const firstNavigation=sharedRoot?sharedRoot.childLinks:inspectPage(page,0,page.truncated===true);rootNavigation=firstNavigation;const rootYield=Math.max(0,discovered.length-beforeRootYield);if(frontierOn){frontierYieldHistory.push(rootYield);frontierEvidenceUnits+=rootYield;}// Deduplicate eligible navigation targets (keeping the best score) BEFORE
    // the queue bound: duplicate URLs must never consume budget while unique
    // eligible targets are dropped. Truncation of eligible uniques is itself
    // incomplete coverage.
    const dedupedNavigation=(()=>{const best=new Map<string,{url:string;score:number;from?:string}>();for(const item of firstNavigation){const prior=best.get(item.url);if(!prior||item.score>prior.score)best.set(item.url,item);}return [...best.values()];})();const duplicateDropped=Math.max(0,firstNavigation.length-dedupedNavigation.length);if(duplicateDropped>0)drops.count('duplicate',duplicateDropped);if(dedupedNavigation.length>12)seedCeiling??='queue-cap';const queueSelection=selectDiverseNavigationQueue(dedupedNavigation,12);if(queueSelection.dropped>0)drops.count('queue-cap',queueSelection.dropped);const queue=queueSelection.selected.map(item=>({...item,depth:1}));let explored=0;
    // P-D domain-weight shadow evaluation (observational only, default-off):
    // records what approved weights WOULD have picked against the live
    // score order. Never routes, budgets, or stops; null unless the
    // explicit experiment gate admits with an approved snapshot.
    if(evaluateDomainWeights){
      try{
        const shadowSiteIdentity=frontier?.siteIdentity||canonicalSiteIdentity(url)?.siteIdentity;
        if(shadowSiteIdentity){
          // Shadow input is the live capped queue (not the pre-cap deduped
          // list): the shadow must never select a URL the live crawl could
          // not attempt. Queue items carry the same url/score shape.
          const shadow=await evaluateDomainWeightShadow(shadowSiteIdentity,queue.map(item=>({url:item.url,score:item.score})));
          if(shadow)domainWeightShadows.push(shadow);
        }
      }catch{/* shadow evaluation never breaks acquisition */}
    }
    // Root-page discovered links enter the persisted queue like any child
    // page's links, so root-only discoveries are recorded too.
    if(frontierOn){await frontierAdmitChildren(dedupedNavigation,1);}
    // Redirect-aware seed origin: a creator seed commonly redirects from the
    // bare host to www (or to a canonical path). The loaded root origin — not
    // the pre-redirect requested URL — is the creator site whose internal
    // links must stay exempt from the external-host page budget.
    const destinationBudget=createDestinationBudget({seedUrl:page.finalUrl});
    while(queue.length&&explored<12){
    if(frontierOn){
      // P-C stopping arbiter (flag-gated): halts child exploration on
      // coverage, budget, or marginal-yield exhaustion. Roots are always
      // crawled above; this gate only ever stops *additional* children.
      const frontierDecision=decideFrontierStep({
        queued:queue.map(item=>scoreFrontierCandidate({url:item.url,hintScore:item.score,depth:item.depth??1,attempts:0,sitemapListed:false,structuredNominated:false})),
        acquiredPages:explored+1,evidenceUnits:frontierEvidenceUnits,yieldHistory:frontierYieldHistory,blockedTerminals:frontierBlockedTerminals,
        spentBudget:explored,budgetCap:frontier?.budgetCap??MAX_FRONTIER_PAGES_PER_SITE,
      },{marginalFloor:frontier?.marginalFloor??0,remainingValueFloor:frontier?.remainingValueFloor??0,marginalWindow:frontier?.marginalWindow??5});
      if(frontierDecision.action==='STOP'){seedCeiling??='frontier-yield';drops.count('frontier-yield-stop');logDetails.push(`[Frontier] stopping child exploration: ${frontierDecision.reason}.`);break;}
    }
    queue.sort((a,b)=>b.score-a.score);const next=queue.shift()!;if(next.depth>2){seedCeiling??='depth-limit';drops.count('depth-limit');continue;}if(visited.has(next.url)||sharedVisited.has(sharedKey(next.url)??'')){drops.count('already-visited');continue;}const reservation=destinationBudget.reserve(next.url,next.from||url);if(!reservation.admitted){seedCeiling??='exploration-limit';drops.count('destination-budget');logDetails.push(`Destination budget (${reservation.reason}): skipped ${next.url}; seed coverage remains incomplete.`);continue;}visited.add(next.url);explored++;logDetails.push(`Prioritized website crawl depth ${next.depth}: ${next.url}`);const subAcquired=await fetchExternalPage(next.url,fetchImpl,resolveHost),subPage=subAcquired.page;if(subAcquired.observation)observations.push({...subAcquired.observation,wrapperUrl,surface,required,rootUrl:url,observedAt:new Date().toISOString(),telemetry:staticCrawlerTelemetry({redirectsFollowed,pagesInspected,ceiling:subPage?.truncated?'response-cap':undefined})});if(!subPage){
      if(frontierOn){
        const failed=subAcquired.observation;
        const terminal=classifyBlockedAcquisition({httpStatus:failed?.httpStatus,failureClass:failed?.failureClass,timedOut:failed?.failureClass==='TIMEOUT',transportFailed:failed?.failureClass==='NETWORK_FAILURE'});
        if(terminal!=='OK')frontierBlockedTerminals+=1;
        await frontierRecordCoverage(next.url,terminal==='OK'?'ACQUISITION_FAILED':terminal,'HTTP_STATIC',0);
      }
      continue;
    }
    crawledUrls.push(subPage.finalUrl);
    if(subPage.truncated){truncatedResponse=true;seedCeiling??='response-cap';drops.count('response-cap');}if(debugLog)debugLog.redirectsFollowed.push({from:next.url,to:subPage.finalUrl});if(subPage.finalUrl!==next.url)redirectsFollowed++;const beforeChildYield=discovered.length;const children=inspectPage(subPage,next.depth,subPage.truncated===true);if(frontierOn){
      // P-C per-page accounting (flag-gated): yield delta, coverage row, and
      // frontier admission for discovered children. Best-effort persistence;
      // failures never affect the crawl.
      const childYield=Math.max(0,discovered.length-beforeChildYield);
      frontierYieldHistory.push(childYield);frontierEvidenceUnits+=childYield;
      await frontierRecordCoverage(next.url,childYield>0?'FOUND':(subPage.truncated?'PARTIALLY_INSPECTED':'INSPECTED_NO_MATCH'),'HTTP_STATIC',childYield);
      await frontierAdmitChildren(children,next.depth);
    }if(next.depth>=2){const seenChildren=new Set<string>();const unvisitedChildren=children.filter(child=>{if(seenChildren.has(child.url))return false;seenChildren.add(child.url);return !visited.has(child.url)&&!sharedVisited.has(sharedKey(child.url)??'');});if(unvisitedChildren.length>0){seedCeiling??='depth-limit';drops.count('depth-limit',unvisitedChildren.length);}}else{const bestChild=new Map<string,{url:string;score:number;from?:string}>();for(const child of children){const prior=bestChild.get(child.url);if(!prior||child.score>prior.score)bestChild.set(child.url,child);}const duplicateChildren=Math.max(0,children.length-bestChild.size);if(duplicateChildren>0)drops.count('duplicate',duplicateChildren);for(const child of [...bestChild.values()])if((!visited.has(child.url)&&!sharedVisited.has(sharedKey(child.url)??'')))queue.push({...child,depth:next.depth+1});}}
    if(queue.some(item=>!visited.has(item.url)))seedCeiling??='exploration-limit';const leftoverUnvisited=queue.filter(item=>!visited.has(item.url)).length;if(leftoverUnvisited>0)drops.count('exploration-limit',leftoverUnvisited);
    if(wrapperCandidate){const nativeForSeed=discovered.slice(beforeSeed).filter(candidate=>candidate.nativeInviteCode);if(nativeForSeed.length){discovered.splice(beforeSeed,discovered.length-beforeSeed,...preserveResolvedWrapperProvenance(wrapperCandidate,nativeForSeed));}}
    const foundForSeed=discovered.length>beforeSeed;
    // Confirmed login-wall terminal (resolved-flag gated, fail-open):
    // redirect-to-login + content markers from already-fetched root html,
    // never on FOUND rows, never URL-only, never shared as final across URLs
    // (borrow guarded at call site). Generic 429/403/999/NO_PAGE/transient/
    // network/bot remain retryable per bounded policy. Flags arrive via
    // r6Options from the inspection runner (single resolved source); direct
    // callers omitting options get the enabled defaults.
    const loginFlag = r6Options?.loginSemantics ?? true;
    let confirmedLogin = false;
    let confirmedPaywall = false;
    try {
      // Truncated roots never confirm barriers: the detector only sees the
      // bounded prefix, and decisive content past the cut could contradict
      // the classification. Truncated pages keep incomplete/retryable
      // semantics (STATIC_BUDGET_GAP) instead of terminal results.
      if (loginFlag && !foundForSeed && page && page.finalUrl && page.html && page.truncated !== true) {
        confirmedLogin = isConfirmedLoginWall({
          requestedUrl: url, finalUrl: page.finalUrl, html: page.html, httpStatus: 200, hasCandidates: false,
        });
        if (!confirmedLogin) {
          confirmedPaywall = isConfirmedPaywall({
            finalUrl: page.finalUrl, html: page.html, hasCandidates: false,
          });
        }
      }
    } catch { confirmedLogin = false; confirmedPaywall = false; }
    if (confirmedPaywall) {
      // P4: a confirmed paywall on a community-platform page is paid-community
      // intent, never "nothing found". The invite may exist behind membership;
      // the paid signal is recorded as first-class evidence.
      try{communityIntents.push(...extractCommunityIntentEvidence({pageUrl:page.finalUrl,html:page.html,confirmedPaywall:true}));}catch{/* intent evidence is best-effort */}
    }
    const confirmedBarrier = confirmedLogin || confirmedPaywall;
    const barrierClass = confirmedLogin ? LOGIN_WALL_FAILURE_CLASS : PAYWALL_FAILURE_CLASS;
    // Safe partial-static gaps (resolved-flag gated, independent):
    // ceiling-truncated real coverage becomes retryable STATIC_BUDGET_GAP
    // instead of silent non-retryable partial. Retry re-runs static first;
    // browser escalation still only per existing policy (no silent expensive
    // acquisition).
    const partialFlag = r6Options?.partialStaticRetry ?? true;
    const staticCeilingKinds = new Set(['queue-cap', 'depth-limit', 'exploration-limit', 'response-cap', 'frontier-yield']);
    const staticGapRetryable = partialFlag && !foundForSeed && !confirmedBarrier && !!seedCeiling && staticCeilingKinds.has(String(seedCeiling));
    const seedOutcome:ExternalAcquisitionStatus=foundForSeed?'FOUND':(seedCeiling||confirmedBarrier)?'PARTIALLY_INSPECTED':'INSPECTED_NO_MATCH';const sharedRootAttribution=sharedRoot?`Shared static root evidence from ${sharedRoot.bySeed}; `:'';observations.push({requestedUrl:url,finalUrl:page.finalUrl,wrapperUrl,surface,required,rootUrl:url,outcome:seedOutcome,retryable:confirmedBarrier?false:(staticGapRetryable?true:false),httpStatus:200,failureClass:confirmedBarrier?barrierClass:(staticGapRetryable?STATIC_BUDGET_GAP_FAILURE_CLASS:''),detail:`${sharedRootAttribution}${foundForSeed?`Discord candidate(s) retained while inspecting root plus ${explored} prioritized page(s)`:confirmedLogin?`Login wall confirmed at ${page.finalUrl}; absence is not confirmed, no further identical retry`:confirmedPaywall?`Paywall confirmed at ${page.finalUrl}; absence is not confirmed, no further identical retry`:seedCeiling?`Root plus ${explored} prioritized page(s) inspected without a Discord invite; crawl budget exhausted before full coverage${truncatedResponse?'; response truncated at the bounded-response cap before full coverage':''}`:`Root page plus ${explored} prioritized same-origin community/navigation page(s) inspected without a Discord invite`}`,observedAt:new Date().toISOString(),telemetry:staticCrawlerTelemetry({redirectsFollowed,pagesInspected,ceiling:seedCeiling,dropReasons:drops.snapshot(),...(seedExperimentAttribution?{experimentAttribution:{...seedExperimentAttribution,...(seedCeiling==='frontier-yield'?{stoppingReason:'frontier-yield-stop'}:{})}}:{})}),...(sharedRoot?{sharedEvidenceFrom:sharedRoot.bySeed}:{})});
    if(frontierOn){
      // P-C root coverage row (flag-gated, best-effort): terminal state
      // reflects the ROOT page's own evidence only (rootCoverageTerminal);
      // child outcomes live on their own rows, so a child-only invite never
      // marks the root FOUND and blocked children are never hidden.
      await frontierRecordCoverage(url,rootCoverageTerminal(rootYield,truncatedResponse),'HTTP_STATIC',rootYield);
    }
    }catch(error:any){logDetails.push(`Isolated acquisition error for ${String(rawUrl)}: ${error instanceof Error?error.message:String(error)}; continuing to next candidate.`);observations.push({requestedUrl:String(rawUrl||'unknown'),wrapperUrl,surface,required,rootUrl:String(rawUrl||'unknown'),outcome:'ACQUISITION_FAILED',retryable:true,failureClass:'ISOLATED_ACQUISITION_ERROR',detail:`Per-URL failure isolated; remaining candidates continue: ${error instanceof Error?error.message:String(error)}`,observedAt:new Date().toISOString(),telemetry:staticCrawlerTelemetry({redirectsFollowed:0,pagesInspected:0})});continue;}
  }
  const candidates=mergeDiscordCandidates(discovered);const failed=observations.filter(item=>item.outcome==='ACQUISITION_FAILED').length,inspected=observations.filter(item=>item.outcome==='INSPECTED_NO_MATCH').length,partial=observations.filter(item=>item.outcome==='PARTIALLY_INSPECTED').length,found=observations.some(item=>item.outcome==='FOUND');const outcome:ExternalAcquisitionStatus=found?'FOUND':(failed&&inspected)||partial>0?'PARTIALLY_INSPECTED':failed?'ACQUISITION_FAILED':'INSPECTED_NO_MATCH';
  logDetails.push(`Crawled ${scannedCount} external link(s); retained ${candidates.length} distinct Discord candidate(s).`);
  return {foundInvite:candidates[0]?.nativeInviteCode||null,foundLocation:candidates[0]?.sourceUrl,details:logDetails.join('\n'),outcome,observations,candidates,domainWeightShadows,visitedUrls:crawledUrls,rootNavigation,communityIntent:communityIntents};
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
export async function crawlMessagingPreview(seedUrl:string,logDetails:string[]=[],debugLog?:any,fetchImpl:typeof fetch=fetch,surface:AcquisitionSurface='CREATOR_WEBSITES',wrapperUrl?:string,resolveHost?:DnsResolver):Promise<ExternalDiscordCrawlResult & {bridgeEvidence:boolean;previewHtmlLength:number;truncated:boolean}>{
  const observedAt=new Date().toISOString();
  const seedLocators=extractDiscordCandidates(seedUrl,surface,seedUrl);
  const direct=seedLocators.filter(candidate=>candidate.nativeInviteCode);
  let seedIntent:CommunityIntentEvidence[]=[];
  try{seedIntent=extractCommunityIntentEvidence({pageUrl:seedUrl,html:''});}catch{/* intent evidence is best-effort */}
  if(direct.length){
    if(debugLog)debugLog.discordRegexAttempts.push({source:'crawlMessagingPreview_direct',url:seedUrl,result:direct.map(c=>c.nativeInviteCode)});
    return {foundInvite:direct[0].nativeInviteCode||null,foundLocation:seedUrl,details:`[Messaging preview] ${direct.length} direct Discord candidate(s) in URL: ${seedUrl}`,outcome:'FOUND',observations:[{requestedUrl:seedUrl,finalUrl:seedUrl,wrapperUrl,surface,required:false,outcome:'FOUND',retryable:false,detail:`${direct.length} direct Discord candidate(s) in messaging URL`,observedAt,telemetry:staticCrawlerTelemetry({redirectsFollowed:0,pagesInspected:0})}],candidates:mergeDiscordCandidates(direct),bridgeEvidence:false,previewHtmlLength:0,truncated:false,communityIntent:seedIntent};
  }
  let acquired:Awaited<ReturnType<typeof fetchExternalPage>>;
  try{
    acquired=await fetchExternalPage(seedUrl,fetchImpl,resolveHost);
  }catch(error:any){
    return {foundInvite:null,details:`[Messaging preview] Isolated fetch error for ${seedUrl}; continuing.`,outcome:'ACQUISITION_FAILED',observations:[{requestedUrl:seedUrl,wrapperUrl,surface,required:true,outcome:'ACQUISITION_FAILED',retryable:true,failureClass:'ISOLATED_ACQUISITION_ERROR',detail:`Messaging preview fetch isolated: ${error instanceof Error?error.message:String(error)}`,observedAt,telemetry:staticCrawlerTelemetry({redirectsFollowed:0,pagesInspected:0})}],candidates:[],bridgeEvidence:false,previewHtmlLength:0,truncated:false,communityIntent:seedIntent};
  }
  if(acquired.observation){
    logDetails.push(`[Messaging preview] Static preview unavailable for ${seedUrl}: ${acquired.observation.detail}`);
    return {foundInvite:null,details:logDetails.join('\n'),outcome:'ACQUISITION_FAILED',observations:[{...acquired.observation,wrapperUrl,surface,required:true,observedAt,telemetry:staticCrawlerTelemetry({redirectsFollowed:0,pagesInspected:0})}],candidates:[],bridgeEvidence:false,previewHtmlLength:0,truncated:false,communityIntent:seedIntent};
  }
  const page=acquired.page!;
  if(debugLog)debugLog.redirectsFollowed.push({from:seedUrl,to:page.finalUrl});
  let previewIntent:CommunityIntentEvidence[]=[...seedIntent];
  let found:DiscordCandidate[]=[];
  try{
    found=extractDiscordCandidates(`${page.finalUrl}\n${page.html}`,surface,page.finalUrl).filter(candidate=>candidate.nativeInviteCode);
  }catch(error:any){
    logDetails.push(`[Messaging preview] Isolated parse error for ${seedUrl}; continuing.`);
    return {foundInvite:null,details:logDetails.join('\n'),outcome:'ACQUISITION_FAILED',observations:[{requestedUrl:seedUrl,finalUrl:page.finalUrl,wrapperUrl,surface,required:true,outcome:'ACQUISITION_FAILED',retryable:true,failureClass:'ISOLATED_ACQUISITION_ERROR',detail:`Messaging preview parse isolated: ${error instanceof Error?error.message:String(error)}`,observedAt,telemetry:staticCrawlerTelemetry({redirectsFollowed:0,pagesInspected:1})}],candidates:[],bridgeEvidence:false,previewHtmlLength:page.html.length,truncated:page.truncated===true,communityIntent:previewIntent};
  }
  if(debugLog)debugLog.discordRegexAttempts.push({source:'crawlMessagingPreview_html',url:page.finalUrl,result:found.map(c=>c.nativeInviteCode)});
  try{
    const pagePaywall=page.truncated!==true&&found.length===0&&isConfirmedPaywall({finalUrl:page.finalUrl,html:page.html,hasCandidates:false});
    previewIntent=[...previewIntent,...extractCommunityIntentEvidence({pageUrl:page.finalUrl,html:page.html,confirmedPaywall:pagePaywall})];
  }catch{/* intent evidence is best-effort */}
  if(found.length){
    const candidates=mergeDiscordCandidates(found);
    return {foundInvite:candidates[0]?.nativeInviteCode||null,foundLocation:candidates[0]?.sourceUrl,details:`[Messaging preview] Retained ${candidates.length} Discord candidate(s) statically from ${page.finalUrl} (${page.html.length} bytes, 0 Playwright launches).`,outcome:'FOUND',observations:[{requestedUrl:seedUrl,finalUrl:page.finalUrl,wrapperUrl,surface,required:false,outcome:'FOUND',retryable:false,httpStatus:200,detail:`${candidates.length} Discord candidate(s) statically retained from messaging preview`,observedAt,telemetry:staticCrawlerTelemetry({redirectsFollowed:page.finalUrl!==seedUrl?1:0,pagesInspected:1,ceiling:page.truncated===true?'response-cap':undefined})}],candidates,bridgeEvidence:false,previewHtmlLength:page.html.length,truncated:page.truncated===true,communityIntent:previewIntent};
  }
  const bridgeEvidence=hasMessagingBridgeEvidence(page.html);
  const truncated=page.truncated===true;
  logDetails.push(`[Messaging preview] Static preview of ${page.finalUrl} (${page.html.length} bytes) contains no Discord invite${truncated?'; response truncated at the bounded-response cap before full coverage':''}${bridgeEvidence?'; bridge evidence present, rendered escalation justified':'; no bridge evidence, 0 Playwright launches'}.`);
  // A truncated prefix is incomplete coverage: it stays retry-owned and
  // partial so it can never resolve a definitive clean negative, even when
  // the observed prefix holds no bridge evidence.
  if(truncated){
    return {foundInvite:null,details:logDetails.join('\n'),outcome:'PARTIALLY_INSPECTED',observations:[{requestedUrl:seedUrl,finalUrl:page.finalUrl,wrapperUrl,surface,required:true,outcome:'PARTIALLY_INSPECTED',retryable:true,httpStatus:200,failureClass:'RESPONSE_TRUNCATED',detail:`Messaging preview truncated at the bounded-response cap before full coverage (${page.html.length} bytes observed)`,observedAt,telemetry:staticCrawlerTelemetry({redirectsFollowed:page.finalUrl!==seedUrl?1:0,pagesInspected:1,ceiling:'response-cap'})}],candidates:[],bridgeEvidence,previewHtmlLength:page.html.length,truncated:true,communityIntent:previewIntent};
  }
  return {foundInvite:null,details:logDetails.join('\n'),outcome:'INSPECTED_NO_MATCH',observations:[{requestedUrl:seedUrl,finalUrl:page.finalUrl,wrapperUrl,surface,required:false,outcome:'INSPECTED_NO_MATCH',retryable:false,httpStatus:200,detail:bridgeEvidence?'Messaging preview statically inspected without an extractable invite; bridge evidence present':`Messaging preview statically inspected without a Discord invite (${page.html.length} bytes, 0 Playwright launches)`,observedAt,telemetry:staticCrawlerTelemetry({redirectsFollowed:page.finalUrl!==seedUrl?1:0,pagesInspected:1})}],candidates:[],bridgeEvidence,previewHtmlLength:page.html.length,truncated:false,communityIntent:previewIntent};
}

async function crawlSocialBios(socialUrls:string[],logDetails:string[]=[],debugLog?:any):Promise<ExternalDiscordCrawlResult>{return crawlExternalLinks(socialUrls,logDetails,debugLog,fetch,'SOCIAL_PROFILES');}

export async function scrapeRecentVideoDescriptions(youtubeUrl:string):Promise<string[]>{return (await scrapeRecentVideoDescriptionsWithCoverage(youtubeUrl)).descriptions;}
/**
 * Scrape recent-video descriptions with coverage diagnostics. `fetchImpl` is
 * injectable so snapshot-retention tests can feed large watch pages without
 * network access; production callers keep the real fetchWithTimeout.
 */
export async function scrapeRecentVideoDescriptionsWithCoverage(youtubeUrl:string,fetchImpl:typeof fetchWithTimeout=fetchWithTimeout):Promise<{descriptions:string[];items:RecentVideoDescription[];attempted:number;acquired:number}>{
  if(!youtubeUrl||!youtubeUrl.startsWith('http'))return {descriptions:[],items:[],attempted:0,acquired:0};const videosPageUrl=youtubeUrl.endsWith('/videos')?youtubeUrl:`${youtubeUrl.replace(/\/+$/,'')}/videos`;const page=await fetchImpl(videosPageUrl,0);if(!page)throw new Error('Recent-video page acquisition failed');const html=page.html;const videoIds=extractYouTubeVideoIds(html,10);if(videoIds.length===0)throw new Error('Recent-video page schema was not recognized; absence is not confirmed');const descriptions:string[]=[];const items:RecentVideoDescription[]=[];let acquired=0;for(const vId of videoIds.slice(0,10)){const watchUrl=`https://www.youtube.com/watch?v=${vId}`,vPage=await fetchImpl(watchUrl,0);if(vPage){acquired++;const metaDesc=vPage.html.match(/<meta\s+name="description"\s+content="([^"]+)"/i)||vPage.html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i);let desc=metaDesc?detachPageSlice(metaDesc[1]):'';const cleanVHtml=decodeEmbeddedMarkup(vPage.html);const extInVid=extractExternalUrlsFromText(cleanVHtml),invs=extractDiscordCandidates(cleanVHtml,'RECENT_VIDEO_DESCRIPTIONS',watchUrl).filter(candidate=>candidate.nativeInviteCode);for(const inv of invs)desc+=` ${inv.normalizedLocator}`;if(extInVid.length>0)desc+=` ${extInVid.join(' ')}`;if(desc.trim()){descriptions.push(desc.trim());items.push({videoId:vId,description:desc.trim()});}}}if(videoIds.length>0&&acquired===0)throw new Error('Recent-video descriptions could not be acquired');return {descriptions,items,attempted:videoIds.length,acquired};
}

// About-page metadata parsing (ytInitialData + og fallbacks, with page-slice
// detaching) is shared with the Gate 1 public-About path via
// parseAboutPageMetadataFromHtml in youtubePublicAbout; re-exported here for
// callers that import it from the inspector module (including the
// snapshot-retention regression test).
export { parseAboutPageMetadataFromHtml };

async function fetchLiveYouTubeChannelData(youtubeUrl:string,enableDebug?:boolean):Promise<{rawHtml?:string;fetchLog?:string;bio?:string;channelLinks?:string[];videoDescriptions?:string[];thumbnailUrl?:string;truncated?:boolean;}|null>{
  if(!youtubeUrl||!youtubeUrl.startsWith('http'))return null;const page=await fetchWithTimeout(youtubeUrl,0);if(!page)return null;const html=page.html,cleanHtml=decodeEmbeddedMarkup(html);const {bio,thumbnailUrl,explicitLinks}=parseAboutPageMetadataFromHtml(html);const extractedUrls=Array.from(new Set([...explicitLinks,...extractExternalUrlsFromText(cleanHtml)])).filter(url=>!isPageAssetInfrastructureUrl(url));if(page.truncated&&!bio&&extractedUrls.length===0)return null;return {bio,channelLinks:extractedUrls,thumbnailUrl,truncated:page.truncated,rawHtml:enableDebug?cleanHtml:undefined,fetchLog:enableDebug?`Fetched ${page.finalUrl} (${page.html.length} bytes)`:undefined};
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
/**
 * Required-gap input for outcome classification (v2 coverage contract):
 * required members the rendered run did not terminally satisfy. Only
 * consulted when the run actually inspected pages; zero-page runs keep the
 * existing failure path. All fields optional and additive.
 */
export interface RenderedRequiredGap {
  unvisited: string[];
  transientFailures: string[];
  permanentFailures: string[];
}

function renderedAcquisitionOutcome(rendered:BrowserFallbackResult,renderedProcessed:boolean,renderedCandidates:DiscordCandidate[],requiredGap?:RenderedRequiredGap):{outcome:ExternalAcquisitionStatus;failureClass?:string;gapRetryable?:boolean}{
  const gap = requiredGap && (rendered.inspectedPages || 0) > 0 ? requiredGap : undefined;
  const hasUnvisited = !!gap && gap.unvisited.length > 0;
  const hasTransient = !!gap && gap.transientFailures.length > 0;
  const hasPermanentOnly = !!gap && !hasUnvisited && !hasTransient && gap.permanentFailures.length > 0;
  // Interaction gap: an evidence-bearing control (button/tab/accordion that can
  // reveal community content, e.g. a "Join Discord" toggle) failed to click or
  // was skipped by the control budget. Unlike a wall-clock stop after full
  // required-link coverage, this is content that was never examined, so it can
  // never resolve as a clean absence and keeps bounded retry alive.
  const interactionGap = rendered.interactionGap === true;
  const interactionClass = interactionGap ? 'RENDERED_INTERACTION_GAP' : undefined;
  // FOUND never erases outstanding required obligations: invites are retained
  // and reported, while a retryable gap keeps bounded recovery alive through
  // the returned gapRetryable flag (consumed by the caller into the
  // observation's retryable flag and failure class).
  if(renderedCandidates.length) {
    if (hasUnvisited) return {outcome:'FOUND',failureClass:'REQUIRED_UNVISITED_BUDGET_GAP',gapRetryable:true};
    if (hasTransient) return {outcome:'FOUND',failureClass:rendered.timedOut?'RENDERED_TIMEOUT':'RENDERED_PARTIAL_COVERAGE',gapRetryable:true};
    // A retryable interaction gap may hide further invites, so it outranks a
    // permanent-only required failure (which never owns retry work).
    if (interactionGap) return {outcome:'FOUND',failureClass:rendered.timedOut?'RENDERED_TIMEOUT':'RENDERED_INTERACTION_GAP',gapRetryable:true};
    if (hasPermanentOnly) return {outcome:'FOUND',gapRetryable:false};
    return{outcome:'FOUND'};
  }
  // SUFFICIENT_CLEAN: the required set (seed document + directly discovered
  // same-host community-hint links) is fully terminal-success with no invites
  // and no required failures. Any remainder is opportunistic depth-2+/capped
  // traversal by definition, so a wall-clock or page-budget stop on top of
  // full required coverage resolves clean instead of manufacturing an
  // incomplete. Only applies when the producer instruments required
  // coverage; legacy results without it keep exact legacy behavior.
  const requiredCovered = rendered.requiredTotal !== undefined && (rendered.inspectedPages || 0) > 0 &&
    !(rendered.requiredUnvisited?.length) && !(rendered.requiredTransientFailures?.length) && !(rendered.requiredPermanentFailures?.length);
  // Required-link coverage never absorbs an interaction gap: a click-only
  // control that failed or was skipped could still be holding the invite.
  if (requiredCovered && !interactionGap) return {outcome:'INSPECTED_NO_MATCH'};
  if(rendered.complete&&renderedProcessed&&!interactionGap)return{outcome:'INSPECTED_NO_MATCH'};
  // A timeout is a total-timeout ceiling, not proof of page-budget pressure:
  // keep RENDERED_BUDGET_EXPIRED only when page-budget drops evidence it,
  // otherwise attribute the timeout truthfully so it never reads as budget.
  const pageBudgetCut=(rendered.dropReasons?.['page-budget']||0)>0;
  const timeoutClass=rendered.timedOut?(pageBudgetCut?'RENDERED_BUDGET_EXPIRED':'RENDERED_TIMEOUT'):undefined;
  if (hasUnvisited) return{outcome:'PARTIALLY_INSPECTED',failureClass:'REQUIRED_UNVISITED_BUDGET_GAP',gapRetryable:true};
  // An unexamined control outranks a permanent-only required failure: the
  // blocked link cannot own retry work, but content hidden behind a failed or
  // skipped community control still can, and must not be certified clean.
  if (interactionGap) return{outcome:rendered.inspectedPages>0?'PARTIALLY_INSPECTED':'ACQUISITION_FAILED',failureClass:rendered.timedOut?'RENDERED_TIMEOUT':'RENDERED_INTERACTION_GAP',gapRetryable:true};
  // Required permanent-only failure (e.g. BLOCKED wall on a required member
  // with no other gap) stays visible but never owns retry work: identical
  // refetch patterns cannot clear access denial.
  if (hasPermanentOnly) return{outcome:rendered.inspectedPages>0?'PARTIALLY_INSPECTED':'ACQUISITION_FAILED',failureClass:rendered.timedOut?'RENDERED_TIMEOUT':'RENDERED_PARTIAL_COVERAGE',gapRetryable:false};
  if(rendered.inspectedPages>0)return{outcome:'PARTIALLY_INSPECTED',failureClass:timeoutClass||interactionClass||'RENDERED_PARTIAL_COVERAGE',gapRetryable:interactionGap||undefined};
  return{outcome:'ACQUISITION_FAILED',failureClass:timeoutClass||interactionClass||rendered.failureClass||'NO_PAGE_PROCESSED',gapRetryable:interactionGap||undefined};
}

/**
 * Builds the required-gap input for outcome classification from a rendered
 * result. Returns undefined when the run inspected nothing (zero-page runs
 * keep the existing failure path) or when legacy producers provide no
 * required-set instrumentation (identical legacy behavior).
 */
function requiredGapFromRendered(rendered:BrowserFallbackResult):RenderedRequiredGap|undefined{
  if((rendered.inspectedPages||0)<=0)return undefined;
  const unvisited=rendered.requiredUnvisited||[];
  const transientFailures=rendered.requiredTransientFailures||[];
  const permanentFailures=rendered.requiredPermanentFailures||[];
  if(!unvisited.length&&!transientFailures.length&&!permanentFailures.length)return undefined;
  return{unvisited,transientFailures,permanentFailures};
}

/**
 * Per-item static isolation wrapper (PR #434 item 2). `crawlExternalLinks`
 * already isolates per-seed failures internally; this additionally guarantees a
 * single item can never throw out of the Step 4/5 loops and prevent subsequent
 * candidates from being attempted.
 */
async function safeCrawlStatic(seedUrl:string,debugLog:any,fetchImpl:typeof fetch,surface:AcquisitionSurface,wrapperUrl?:string,ladderStructured?:boolean,frontier?:FrontierCrawlOptions,seedAdmission?:{admitted:number;considered:number}|null,evaluateDomainWeights?:boolean,preVisited?:string[]|SharedStaticInventory,r6Options?:{loginSemantics?:boolean;partialStaticRetry?:boolean},resolveHost?:DnsResolver):Promise<{crawlRes:ExternalDiscordCrawlResult}>{
  try{
    return {crawlRes:await crawlExternalLinks([seedUrl],[],debugLog,fetchImpl,surface,false,wrapperUrl,ladderStructured,frontier,seedAdmission,evaluateDomainWeights,preVisited,r6Options,resolveHost)};
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
export function hasProcessedAcquisitionEvidence(item:{telemetry?:CrawlerTelemetry;sharedEvidenceFrom?:string}):boolean{
  // Shared-evidence rows reference bytes inspected by the lender run in this
  // same inspection: genuine evidence, attributed explicitly, with zero
  // page counters of their own (no inspection is double-counted).
  if(typeof item.sharedEvidenceFrom==='string'&&item.sharedEvidenceFrom) return true;
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
 * Community relevance for FINAL-OUTCOME purposes: a meaningful website
 * observation whose URL is not auxiliary/demoted. Auxiliary failures
 * (affiliate, broker, transactional, no-community commerce) stay in the
 * raw telemetry/ledger and keep their evidence on success, but they can
 * never independently own the channel-level Discord outcome or retry.
 * Crawling, ranking, recall, and retry classification of other hosts are
 * unaffected — this gates outcome ownership only.
 */
export function isCommunityRelevantObservation(item: { rootUrl?: string; requestedUrl: string }): boolean {
  // Clearly-unrelated BLOCK and low-value DEMOTE tiers never own outcome
  // (acquisition-layer decision, separate from PR #504 auxiliary logic below
  // which is preserved). Absent tier (legacy/disabled/failed-open) preserves
  // existing behavior. Exclusion is outcome-ownership only: demoted seeds are
  // still crawled static-only and their candidates join websiteCandidates
  // unfiltered, so a demoted FOUND still retains its invite through the
  // candidate path exactly like auxiliary successes.
  const tier = (item as { relevanceTier?: unknown }).relevanceTier;
  if (tier === 'BLOCK' || tier === 'DEMOTE') return false;
  return isMeaningfulWebsiteObservation(item) && !isAuxiliaryForOutcome(acquisitionOwnershipUrl(item));
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

/**
 * Effective Step-4/community summary: the same community-relevant outcome set
 * that owns final status/retry, rendered for user-facing reporting. The raw
 * acquisition ledger (`acquisitionOutcomes`) always retains auxiliary
 * observations; this selector only chooses which rows the summary counts so
 * the Step-4 line can never contradict the effective outcome.
 */
export function summarizeEffectiveLinkedWebsiteAcquisition(
  observations: ExternalAcquisitionObservation[],
): LinkedWebsiteAcquisitionSummary {
  return summarizeLinkedWebsiteAcquisition(
    observations.filter((item) =>
      isCommunityRelevantObservation(item as { rootUrl?: string; requestedUrl: string }),
    ),
  );
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

export async function runChannelInspection(channelData:{enableDebug?:boolean;channelId:string;channelName?:string;channelBio:string;channelLinks?:string[];pinnedComment?:string;videoDescriptions?:string[];videoDescriptionsAuthoritative?:boolean;recentVideoDescriptions?:SampledVideoInput[];socialLinks?:string[];youtubeUrl?:string;forceLiveFetch?:boolean;liveChannelDataLoader?:typeof fetchLiveYouTubeChannelData;recentVideoDescriptionsLoader?:(channelId:string)=>Promise<Array<string|{videoId?:string|null;description?:string|null}>>;externalFetchImpl?:typeof fetch;destinationResolver?:DnsResolver;creatorLikelyTrading?:boolean;renderedFallback?:(seedUrl:string,budget?:Partial<BrowserFallbackBudget>)=>Promise<BrowserFallbackResult>;urlFailureHistoryLoader?:(channelId:string,urls?:string[])=>Promise<UrlFailureRow[]>;siteInspectionStore?:SiteInspectionStore;bypassBorrowedCoverage?:boolean;scanAttempts?:number;clickOffsets?:Record<string,number>;}):Promise<InspectionResult>{
  const steps:InspectionStep[]=[];const now=new Date().toISOString();let extractedThumbnailUrl:string|undefined;
  const markSsrfSeedRequired = (observations: ExternalAcquisitionObservation[], seedUrl: string): void => {
    const key = normalizeVisitUrl(seedUrl);
    for (const obs of observations) {
      if (String(obs.failureClass || '') !== 'SSRF_BLOCKED') continue;
      if (normalizeVisitUrl(String(obs.requestedUrl || '')) !== key) continue;
      // A blocked seed is a required acquisition failure even though normal
      // static website observations are optional. It was not inspected, so a
      // channel-level INSPECTED_NO_MATCH would be a false negative.
      obs.required = true;
      obs.retryable = false;
      obs.detail = `${obs.detail}; destination block is a required channel-level failure`;
    }
  };

  const acquisitionOutcomes:ExternalAcquisitionObservation[]=[];let acquiredAboutUrl:string|undefined;const acquiredRecentDescriptionSurfaces:string[]=[];let debugLog:any=channelData.enableDebug?{rawAboutPageHtml:null,fetchLog:null,extractedUrls:[],redirectsFollowed:[],discordRegexAttempts:[],failureStep:null}:undefined;let bio=channelData.channelBio||'',links=channelData.channelLinks||[],videoDescs=channelData.videoDescriptions||[];let creatorLikelyTrading=channelData.creatorLikelyTrading,creatorName=channelData.channelName||'';
  if((creatorLikelyTrading===undefined||!creatorName)&&channelData.channelId){try{const stored=await getChannelById(channelData.channelId);if(creatorLikelyTrading===undefined)creatorLikelyTrading=stored?.trading_status==='TRADING_CONFIRMED';if(!creatorName)creatorName=stored?.channel_name||'';}catch{if(creatorLikelyTrading===undefined)creatorLikelyTrading=false;}}creatorLikelyTrading=creatorLikelyTrading===true;
  // Per-seed rendered rotation state. Retry jobs carry the durable map in
  // their payload; initial scans fall back to the legacy channel attempt
  // offset. A seed with no recorded progress starts at zero.
  const clickOffsetsBySeed=new Map<string,number>();
  for(const [url,offset] of Object.entries(channelData.clickOffsets||{})){
    const key=normalizeVisitUrl(url);
    const value=Math.max(0,Math.trunc(Number(offset))||0);
    if(key&&value>0)clickOffsetsBySeed.set(key,value);
  }
  const defaultClickOffset=Math.max(0,Math.trunc(Number(channelData.scanAttempts))||0);
  const renderedClickOffsetForSeed=(seedUrl:string):number=>{
    const key=normalizeVisitUrl(seedUrl);
    return (key?clickOffsetsBySeed.get(key):undefined)??defaultClickOffset;
  };
  // Channel-sampled descriptions acquired during THIS inspection, kept
  // separate from preloaded search-selected snippets. Only this collection
  // carries authoritative provenance for the aggregated-language country
  // voter (see observedVideoDescriptions): preloaded discovery input must
  // never become the language sample merely because it was passed in.
  // Tracked as (videoId, text) pairs: API and keyless scrape sample the same
  // newest uploads, so merging by video ID keeps one upload from voting twice
  // when its two observed texts differ in encoding or appended links.
  let channelSampled: RecentVideoDescription[] = [];
  // Authoritative descriptions reused from enrichment, kept at function scope
  // so Step 3 can prioritize them (and any keyless top-up) over preloaded
  // discovery-selected snippets.
  let authoritativeInspectionDescriptions: string[] = [];
  const channelSampledDescs = (): string[] => channelSampled.map(item => item.description);
  const trackChannelSampled = (input: SampledVideoInput[] | null | undefined): void => {
    channelSampled = mergeSampledVideoDescriptions(channelSampled, normalizeSampledVideoDescriptions(input));
  };
  if(channelData.youtubeUrl||channelData.channelId){const shouldRefreshAbout=Boolean(channelData.youtubeUrl&&(channelData.forceLiveFetch||creatorLikelyTrading||links.length===0||bio.length<20));if(shouldRefreshAbout&&channelData.youtubeUrl){try{const liveData=await (channelData.liveChannelDataLoader||fetchLiveYouTubeChannelData)(channelData.youtubeUrl,channelData.enableDebug);if(liveData){acquiredAboutUrl=channelData.youtubeUrl;if(liveData.bio)bio=`${bio} ${liveData.bio}`.trim();if(liveData.channelLinks?.length)links=Array.from(new Set([...links,...liveData.channelLinks]));if(liveData.thumbnailUrl)extractedThumbnailUrl=liveData.thumbnailUrl;if(debugLog){debugLog.rawAboutPageHtml=liveData.rawHtml;debugLog.fetchLog=liveData.fetchLog;}}else acquisitionOutcomes.push({requestedUrl:channelData.youtubeUrl,surface:'YOUTUBE_ABOUT',required:true,outcome:'ACQUISITION_FAILED',retryable:true,failureClass:'YOUTUBE_ABOUT_ACQUISITION_FAILED',retryAt:undefined,detail:'YouTube About page could not be acquired',observedAt:now});}catch(e){acquisitionOutcomes.push({requestedUrl:channelData.youtubeUrl,surface:'YOUTUBE_ABOUT',required:true,outcome:'ACQUISITION_FAILED',retryable:true,failureClass:'YOUTUBE_ABOUT_ACQUISITION_FAILED',retryAt:retryAtFromUnknown(e),detail:e instanceof Error?e.message:String(e),observedAt:now});}}
    const preloaded=[...videoDescs];let authoritative=false;
    // Gate 3 reuses the authoritative recent-upload sample enrichment already
    // paid for. Without this, a confirmed trading channel triggers the same
    // 100-unit search.list a second time in the very next pipeline stage.
    // Provenance is strict: only a sample marked authoritative may take this
    // path; discovery-selected snippets still fall through to the loader.
    const suppliedAuthoritative=channelData.videoDescriptionsAuthoritative===true
      ? normalizeSampledVideoDescriptions(channelData.recentVideoDescriptions)
      : [];
    if(channelData.videoDescriptionsAuthoritative===true){
      authoritative=true;
      const seeded=suppliedAuthoritative.length?suppliedAuthoritative:normalizeSampledVideoDescriptions(preloaded);
      trackChannelSampled(seeded);
      // The reused sample was inspected, not fetched by Gate 3. Record a
      // distinct surface so a no-invite result still produces the normal
      // INSPECTED_NO_MATCH acquisition observation.
      if(seeded.length)acquiredRecentDescriptionSurfaces.push(`enrichment:channel:${channelData.channelId}:recent-video-descriptions`);
      const seededTexts=seeded.map(item=>item.description);
      authoritativeInspectionDescriptions=seededTexts;
      if(seededTexts.length)videoDescs=Array.from(new Set([...seededTexts,...preloaded]));
    }else if(channelData.channelId&&(creatorLikelyTrading||channelData.forceLiveFetch)){try{const apiDescs=await (channelData.recentVideoDescriptionsLoader||fetchRecentVideoDescriptionsWithIds)(channelData.channelId);acquiredRecentDescriptionSurfaces.push(`youtube-api:channel:${channelData.channelId}:recent-video-descriptions`);authoritative=true;trackChannelSampled(apiDescs);const apiTexts=normalizeSampledVideoDescriptions(apiDescs).map(item=>item.description);if(apiTexts.length)videoDescs=Array.from(new Set([...apiTexts,...preloaded]));}catch(e){acquisitionOutcomes.push({requestedUrl:`youtube-api:channel:${channelData.channelId}:recent-video-descriptions`,surface:'RECENT_VIDEO_DESCRIPTIONS',required:true,outcome:'ACQUISITION_FAILED',retryable:true,failureClass:'RECENT_VIDEO_DESCRIPTION_API_FAILED',retryAt:retryAtFromUnknown(e),detail:e instanceof Error?e.message:String(e),observedAt:now});}}else if(videoDescs.length<5&&channelData.channelId){try{const apiDescs=await (channelData.recentVideoDescriptionsLoader||fetchRecentVideoDescriptionsWithIds)(channelData.channelId);acquiredRecentDescriptionSurfaces.push(`youtube-api:channel:${channelData.channelId}:recent-video-descriptions`);authoritative=true;trackChannelSampled(apiDescs);const apiTexts=normalizeSampledVideoDescriptions(apiDescs).map(item=>item.description);if(apiTexts.length)videoDescs=Array.from(new Set([...apiTexts,...videoDescs]));}catch(e){acquisitionOutcomes.push({requestedUrl:`youtube-api:channel:${channelData.channelId}:recent-video-descriptions`,surface:'RECENT_VIDEO_DESCRIPTIONS',required:true,outcome:'ACQUISITION_FAILED',retryable:true,failureClass:'RECENT_VIDEO_DESCRIPTION_API_FAILED',retryAt:retryAtFromUnknown(e),detail:e instanceof Error?e.message:String(e),observedAt:now});}}
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
  let collectedExternalUrls:{url:string;wrapperUrl?:string;kind:'WEBSITE'|'SOCIAL'|'MESSAGING';contextMatches:boolean;source:string}[]=[];const checkContext=(text:string,url:string):boolean=>{const contextKeywords=['discord','community','join','trading floor','members','server'],lowerText=text.toLowerCase(),urlIndex=lowerText.indexOf(url.toLowerCase());if(urlIndex===-1)return false;const window=lowerText.substring(Math.max(0,urlIndex-100),Math.min(lowerText.length,urlIndex+url.length+100));return contextKeywords.some(kw=>window.includes(kw));};
  // R6 admission audit trail: every candidate rejected by the shared admission
  // boundary is logged with its stable reason code (no silent drops).
  const admissionRejectionLogs:string[]=[];
  const logAdmissionRejection=(raw:string)=>{const decision=assessCrawlAdmission(raw);if(!decision.eligible)admissionRejectionLogs.push(`Admission rejected (${decision.reasonCode}): ${raw}; not admitted.`);return decision.eligible;};
  const addExternalUrls=(text:string,source:string)=>{const urls=extractExternalUrlsFromText(text);if(debugLog)debugLog.extractedUrls.push(...urls);for(const url of urls){if(!logAdmissionRejection(url))continue;const normalized=normalizeExternalUrl(url);if(!normalized||isPageAssetInfrastructureUrl(normalized.url))continue;collectedExternalUrls.push({...normalized,contextMatches:checkContext(text,url),source});}};
  for(const link of links)if(link&&typeof link==='string'){if(debugLog)debugLog.extractedUrls.push(link);if(!logAdmissionRejection(link))continue;const normalizedLink=normalizeExternalUrl(link);if(!normalizedLink||isPageAssetInfrastructureUrl(normalizedLink.url))continue;collectedExternalUrls.push({...normalizedLink,contextMatches:false,source:'CHANNEL_LINKS'});}for(const link of channelData.socialLinks||[])if(link&&typeof link==='string'){if(debugLog)debugLog.extractedUrls.push(link);if(!logAdmissionRejection(link))continue;const normalizedSocial=normalizeExternalUrl(link);if(!normalizedSocial||isPageAssetInfrastructureUrl(normalizedSocial.url))continue;collectedExternalUrls.push({...normalizedSocial,contextMatches:false,source:'SOCIAL_LINKS'});}
  const discoveredCandidates:DiscordCandidate[]=[];const retainCandidates=(items:DiscordCandidate[])=>{discoveredCandidates.push(...items.filter(item=>item.nativeInviteCode));};
  const communityIntentEvidence:CommunityIntentEvidence[]=[];const retainCommunityIntent=(items:CommunityIntentEvidence[]|undefined)=>{if(items?.length)communityIntentEvidence.push(...items);};
  // Creator-canonical domains: hosts from creator-controlled channel links
  // (YouTube About external links, incl. live-refreshed). Wires the existing
  // CREATOR_CANONICAL_DOMAIN (+55) ownership signal in inferDiscordOwnership,
  // which was previously unreachable because no caller passed
  // creatorWebsiteHosts. Only normalized WEBSITE-kind destinations qualify:
  // social profiles, messaging previews, and shared/multi-tenant community
  // hosts can never confer canonical ownership (a link proves reference, not
  // ownership), and partner/affiliate links remain guarded by the -80
  // PARTNER_OR_AFFILIATE_SURFACE rule.
  const creatorWebsiteHosts = creatorWebsiteHostsFromLinks(links);
  const ownershipInput = { creatorName, creatorWebsiteHosts };

  const step1Logs:string[]=[];step1Logs.push(`Inspecting channel bio text (${bio.length} characters) and embedded links.`);const bioCandidates=extractDiscordCandidates(bio,'YOUTUBE_ABOUT',channelData.youtubeUrl).filter(c=>c.nativeInviteCode),directBioInvite=bioCandidates[0]?.nativeInviteCode||null;if(debugLog)debugLog.discordRegexAttempts.push({source:'CHANNEL_ABOUT',textLength:bio.length,result:bioCandidates.map(c=>c.nativeInviteCode)});addExternalUrls(bio,'CHANNEL_ABOUT');retainCandidates(bioCandidates);if(directBioInvite){step1Logs.push(`${bioCandidates.length} direct Discord candidate(s) detected in Channel Bio.`);addStep('BIO','Step 1 — Channel Bio & About Panel','FOUND',step1Logs,directBioInvite,'CHANNEL_ABOUT');acquisitionOutcomes.push({requestedUrl:channelData.youtubeUrl||`youtube:channel:${channelData.channelId}`,surface:'YOUTUBE_ABOUT',required:true,outcome:'FOUND',retryable:false,detail:`${bioCandidates.length} Discord candidate(s) discovered in YouTube About content`,observedAt:now});}else{if(acquiredAboutUrl)acquisitionOutcomes.push({requestedUrl:acquiredAboutUrl,surface:'YOUTUBE_ABOUT',required:true,outcome:'INSPECTED_NO_MATCH',retryable:false,detail:'YouTube About page acquired and inspected without a Discord invite',observedAt:now});step1Logs.push('No direct Discord invite found in channel bio.');addStep('BIO','Step 1 — Channel Bio & About Panel','NOT_FOUND',step1Logs);}

  const step2Logs:string[]=[];const rawLinkCandidates=links.flatMap(link=>extractDiscordCandidates(link,'CHANNEL_EXTERNAL_LINKS',link)).filter(c=>c.nativeInviteCode);const linkCandidates=mergeDiscordCandidates(rawLinkCandidates,ownershipInput);retainCandidates(linkCandidates);if(links.length){step2Logs.push(`Scanning ${links.length} channel links.`);if(linkCandidates.length){const inviteCodes=linkCandidates.map(candidate=>candidate.nativeInviteCode!).filter(Boolean);step2Logs.push(`${linkCandidates.length} distinct direct Discord candidate(s) retained from channel links.`);step2Logs.push(`Retained invite code${inviteCodes.length===1?'':'s'}: ${inviteCodes.join(', ')}`);for(const candidate of linkCandidates)acquisitionOutcomes.push({requestedUrl:candidate.sourceUrl||candidate.rawLocator,surface:'CHANNEL_EXTERNAL_LINKS',required:true,outcome:'FOUND',retryable:false,detail:'Discord invite discovered in channel links',observedAt:now});addStep('EXTERNAL_LINKS','Step 2 — Channel External Links','FOUND',step2Logs,linkCandidates[0].nativeInviteCode||null,'CHANNEL_LINKS',inviteCodes);}else{step2Logs.push('No direct Discord invite found in channel links.');addStep('EXTERNAL_LINKS','Step 2 — Channel External Links','NOT_FOUND',step2Logs);}}else addStep('EXTERNAL_LINKS','Step 2 — Channel External Links','SKIPPED',['No channel links found.']);

  const orderedVideoDescs=authoritativeInspectionDescriptions.length?Array.from(new Set([...channelSampledDescs(),...videoDescs])):videoDescs;const descriptionsToInspect=orderedVideoDescs.slice(0,5),step3Logs:string[]=[];const videoCandidates:DiscordCandidate[]=[];if(descriptionsToInspect.length){step3Logs.push(`Scanning ${descriptionsToInspect.length} recent video descriptions${orderedVideoDescs.length>descriptionsToInspect.length?` (${orderedVideoDescs.length} available; newest authoritative descriptions are prioritized).`:'.'}`);for(let i=0;i<descriptionsToInspect.length;i++){const d=descriptionsToInspect[i],sourceName=`VIDEO_${i+1}_DESCRIPTION`;addExternalUrls(d,sourceName);const candidates=extractDiscordCandidates(d,'RECENT_VIDEO_DESCRIPTIONS',`youtube:channel:${channelData.channelId}:${sourceName}`).filter(c=>c.nativeInviteCode);videoCandidates.push(...candidates);if(debugLog)debugLog.discordRegexAttempts.push({source:sourceName,textLength:d.length,result:candidates.map(c=>c.nativeInviteCode)});if(candidates.length)acquisitionOutcomes.push({requestedUrl:`youtube:channel:${channelData.channelId}:${sourceName}`,surface:'RECENT_VIDEO_DESCRIPTIONS',required:true,outcome:'FOUND',retryable:false,detail:`${candidates.length} Discord candidate(s) discovered in recent video description`,observedAt:now});}retainCandidates(videoCandidates);if(videoCandidates.length){step3Logs.push(`${videoCandidates.length} Discord candidate observation(s) retained across the inspected descriptions.`);addStep('VIDEO_DESCRIPTIONS','Step 3 — Latest Video Descriptions','FOUND',step3Logs,videoCandidates[0].nativeInviteCode||null,'RECENT_VIDEO_DESCRIPTIONS');}else{step3Logs.push('No direct Discord invite found in the descriptions actually inspected.');addStep('VIDEO_DESCRIPTIONS','Step 3 — Latest Video Descriptions','NOT_FOUND',step3Logs);}}else addStep('VIDEO_DESCRIPTIONS','Step 3 — Latest Video Descriptions','SKIPPED',['No video descriptions available.']);for(const surface of acquiredRecentDescriptionSurfaces)if(!videoCandidates.length)acquisitionOutcomes.push({requestedUrl:surface,surface:'RECENT_VIDEO_DESCRIPTIONS',required:true,outcome:'INSPECTED_NO_MATCH',retryable:false,detail:`Recent video descriptions acquired; ${descriptionsToInspect.length} description(s) inspected without a Discord invite`,observedAt:now});

  // Recall-safe acquisition (PR #434 items 1-3): ranking reorders but never
  // discards — the complete deduplicated candidate list is attempted in rank
  // order within the existing per-URL budgets. There is intentionally no
  // per-channel URL cap (no "≤4" slice): a channel with many legitimate URLs
  // must not silently lose lower-ranked FOUND paths.
  // R6 safe truncation handling (approved scope): T-Q recovers a cut query to
  // the valid host root ONLY under the high-confidence same-host sibling-key
  // prefix rule (corpus from this inspection's own collected candidates; no
  // keyword lists); T-P records a log-only signal and stays eligible as-is.
  // Legitimate domains are preserved: recovery never changes hosts, and
  // uncertain path-prefix candidates are never rewritten.
  //
  // Bare/www duplicate collapse: WEBSITE seeds sharing one canonical site
  // identity with identical scheme, path, and query whose hosts differ only
  // by a leading www. (e.g. http://asenna.com.au/ vs http://www.asenna.com.au/)
  // crawl byte-identical pages, so they share one seed instead of two
  // independent 6-page/60s rendered runs. Tier B/C path/subdomain tenants
  // never share an identity and can never collapse; distinct paths, queries,
  // or schemes never collapse. First seed wins with context-match merging;
  // every collapse is logged (no silent discards).
  const admissionRecoveryLogs:string[]=[];const admissionTruncationSignals:string[]=[];const seedDedupeLogs:string[]=[];
  const siblingValuedKeysByHost=new Map<string,Set<string>>();const siblingPathsByHost=new Map<string,Set<string>>();
  for(const item of collectedExternalUrls){let parsed:URL|null=null;try{parsed=new URL(item.url);}catch{continue;}const host=parsed.hostname.toLowerCase();if(!siblingPathsByHost.has(host))siblingPathsByHost.set(host,new Set());siblingPathsByHost.get(host)!.add(parsed.pathname||'/');for(const [key,value] of parsed.searchParams){if(value){if(!siblingValuedKeysByHost.has(host))siblingValuedKeysByHost.set(host,new Set());siblingValuedKeysByHost.get(host)!.add(key);}}}
  const uniqueUrls=new Map<string,{url:string;wrapperUrl?:string;kind:'WEBSITE'|'SOCIAL'|'MESSAGING';contextMatches:boolean;source:string;sitemapUrl?:string}>();const collapseIndex=new Map<string,string>();
  // Collapse key for bare/www duplicates: same site identity, scheme, path,
  // and query with hosts equal modulo one leading www. Null when the rule
  // does not apply (unidentifiable, non-www hosts are keyed distinctly so
  // unrelated subdomains can never merge).
  const wwwSchemeCollapseKey=(rawUrl:string):string|null=>{let parsed:URL;try{parsed=new URL(rawUrl);}catch{return null;}const identity=canonicalSiteIdentity(rawUrl)?.siteIdentity;if(!identity)return null;const host=parsed.hostname.toLowerCase();const stripped=host.replace(/^www\./,'');return `${identity}\u0000${parsed.protocol}\u0000${stripped}\u0000${parsed.port}\u0000${parsed.pathname}\u0000${parsed.search}`;};
  const hostsDifferOnlyByWww=(a:string,b:string):boolean=>{let pa:URL,pb:URL;try{pa=new URL(a);pb=new URL(b);}catch{return false;}const ha=pa.hostname.toLowerCase(),hb=pb.hostname.toLowerCase();return ha!==hb&&(ha===`www.${hb}`||hb===`www.${ha}`)&&pa.port===pb.port;};
  for(const item of collectedExternalUrls){let seedUrl=item.url;if(item.kind==='WEBSITE'){try{const host=new URL(seedUrl).hostname.toLowerCase();const recovered=recoverTruncatedQueryToRoot(seedUrl,siblingValuedKeysByHost.get(host)??new Set());if(recovered&&recovered!==seedUrl){admissionRecoveryLogs.push(`Recovered truncated query to host root (TRUNCATED_QUERY_PREFIX): ${seedUrl} → ${recovered}`);seedUrl=recovered;}else if(isPossiblyTruncatedPath(seedUrl,siblingPathsByHost.get(host)??new Set())){admissionTruncationSignals.push(`Possibly truncated path (signal only, still eligible): ${seedUrl}`);}}catch{/* recovery never breaks collection */}}const key=seedUrl;const existing=uniqueUrls.get(key);if(existing){if(item.contextMatches)existing.contextMatches=true;continue;}if(item.kind==='WEBSITE'){const collapseKey=wwwSchemeCollapseKey(seedUrl);if(collapseKey){const primaryKey=collapseIndex.get(collapseKey);const primary=primaryKey?uniqueUrls.get(primaryKey):undefined;if(primary&&hostsDifferOnlyByWww(primary.url,seedUrl)){if(item.contextMatches)primary.contextMatches=true;seedDedupeLogs.push(`Seed deduplicated (BARE_WWW_DUPLICATE): ${seedUrl} → kept ${primary.url}`);continue;}if(!primaryKey)collapseIndex.set(collapseKey,key);}}uniqueUrls.set(key,{...item,url:seedUrl});}const allCollectedUrls=Array.from(uniqueUrls.values());let websiteUrls=rankCommunitySurfaces(allCollectedUrls.filter(u=>u.kind==='WEBSITE'));const socialBioUrls=rankCommunitySurfaces(allCollectedUrls.filter(u=>u.kind==='SOCIAL')),messagingUrls=rankCommunitySurfaces(allCollectedUrls.filter(u=>u.kind==='MESSAGING'));
  // P-B acquisition ladder (flag-gated, default off): sitemap-inventoried URLs
  // enter as scored seed nominations through the normal ranking and budgets.
  // Flag off (or missing/failed profiles) yields zero seeds, leaving the
  // ranked order above byte-identical. Fail open toward legacy seeds.
  const ladderOn=await isAcquisitionLadderEnabled().catch(()=>false);
  // P-D domain-weight shadow experiment (observational only, default-off):
  // read once per inspection and threaded into crawls; the evaluator inside
  // still requires an approved snapshot, so no weights ever flow by default.
  const evaluateDomainWeights=await isDomainWeightExperimentConsumptionEnabled().catch(()=>false);
  // Render-escalation attribution for persisted rendered observations
  // (observational only): present only when the ladder policy governed the
  // escalation decision. Absent on legacy escalations (identical rows).
  const ladderRenderAttribution: ExperimentAttribution | undefined = ladderOn
    ? { policies: [ACQUISITION_LADDER_POLICY_VERSION], escalation: 'rendered' as const }
    : undefined;
  // Ladder seed-admission counts for persisted observation attribution
  // (observational only): admitted vs considered sitemap seeds for this
  // inspection. Null unless the ladder seeding block below runs.
  let ladderSeedAdmission:{admitted:number;considered:number}|null=null;
  const ladderSeedsConsidered=websiteUrls.length;
  // P-C frontier controls (flag-gated, default off): per-seed crawl options
  // carrying the site identity for coverage/admission writes. Flag off (or
  // DB failure) yields undefined options, leaving every crawl legacy.
  const frontierOn=await isFrontierEnabled().catch(()=>false);
  const frontierOptsFor=(seedUrl:string):FrontierCrawlOptions|undefined=>{
    if(!frontierOn)return undefined;
    const identity=canonicalSiteIdentity(seedUrl)?.siteIdentity;
    if(!identity)return undefined;
    return {enabled:true,siteIdentity:identity};
  };
  if(ladderOn&&websiteUrls.length){
    try{
      const seedIdentities=new Map<string,string>();
      for(const seed of websiteUrls){
        const identity=canonicalSiteIdentity(seed.url);
        if(identity)seedIdentities.set(seed.url,identity.siteIdentity);
      }
      const profiles=await getSiteProfiles(Array.from(new Set(seedIdentities.values())));
      // Lazy profile population (ladder-gated): seed identities with no
      // stored profile are inventoried on demand, bounded per inspection,
      // best-effort. Without this the profiler could never produce the
      // inventories the seeding below consumes. Refresh policy belongs to
      // adaptive revisit (P-D); here absent profiles only are backfilled.
      try{
        if(await isSiteProfilerEnabled().catch(()=>false)){
          const known=new Set(profiles.map(profile=>profile.siteIdentity));
          let runs=0;
          for(const seed of websiteUrls){
            if(runs>=MAX_LADDER_PROFILE_RUNS_PER_INSPECTION)break;
            const identity=seedIdentities.get(seed.url);
            if(!identity||known.has(identity))continue;
            known.add(identity);
            runs+=1;
            const tier=canonicalSiteIdentity(seed.url)?.tier||'A';
            const result=await runSiteProfiler(
              {siteIdentity:identity,identityTier:tier,seedUrl:seed.url},
              {fetchImpl:channelData.externalFetchImpl||fetch,...(channelData.destinationResolver?{resolveHost:channelData.destinationResolver}:{})},
            );
            if(result.status!=='PROFILED'||!result.profile)continue;
            const profile=result.profile;
            await upsertSiteProfile({
              siteIdentity:profile.siteIdentity,identityTier:profile.identityTier,
              robotsState:typeof profile.robotsFetch.state==='string'?profile.robotsFetch.state:'UNKNOWN',
              robotsFetchedAt:profile.robotsFetch.fetchedAt,
              sitemapInventory:profile.sitemaps as unknown as Array<Record<string,unknown>>,
              feedInventory:profile.feeds as unknown as Array<Record<string,unknown>>,
              structuredData:{jsonLdTypes:profile.head?.jsonLdTypes||[]},
              pageType:profile.pageType,politeness:profile.politeness as Record<string,unknown>,
              profile:{provenance:profile.provenance,canonicalConflicts:profile.canonicalConflicts} as Record<string,unknown>,
              policyVersion:profile.policyVersion,
            });
            profiles.push({
              siteIdentity:profile.siteIdentity,identityTier:profile.identityTier,
              robotsState:profile.robotsFetch.state,robotsFetchedAt:profile.robotsFetch.fetchedAt,
              sitemapInventory:profile.sitemaps as unknown as Array<Record<string,unknown>>,
              feedInventory:profile.feeds as unknown as Array<Record<string,unknown>>,
              structuredData:{},pageType:profile.pageType,
              politeness:profile.politeness as Record<string,unknown>,
              profile:{},policyVersion:profile.policyVersion,
              firstObservedAt:null,lastObservedAt:null,observedCount:1,
            });
          }
        }
      }catch{/* lazy profiling never breaks seed selection */}
      const profileByIdentity=new Map(profiles.map(profile=>[profile.siteIdentity,profile]));
      const sitemapSeeds:typeof websiteUrls=[];
      // Performance (P2: Repeated Sitemap Identity Lookups): seeds sharing
      // one canonical site identity share one profile/inventory, and the
      // same-site filter depends only on that identity — so each distinct
      // identity's inventories are scanned once. Skipping repeats is
      // behavior-preserving: a repeat scan would score the same filtered
      // survivors and only find duplicates already in sitemapSeeds.
      const processedSitemapIdentities=new Set<string>();
      for(const seed of websiteUrls){
        const identity=seedIdentities.get(seed.url);
        const profile=identity?profileByIdentity.get(identity):undefined;
        if(!profile||!identity)continue;
        if(processedSitemapIdentities.has(identity))continue;
        processedSitemapIdentities.add(identity);
        const inventories=profile.sitemapInventory as Array<{sourceUrl?:string;urls?:Array<{loc?:string}>}>;
        for(const inventory of inventories){
          // Candidate-level same-site gate with filter-before-cap ordering
          // (P1: Valid Tenant Pages Lose Seed Slots). The inventory source
          // itself is intentionally NOT required to share the seed's exact
          // path-tenant identity: a conventional root sitemap (e.g.
          // https://linktr.ee/sitemap.xml) routinely inventories tenant
          // pages (e.g. https://linktr.ee/trader1/community) for a tenant
          // seed (e.g. https://linktr.ee/trader1). Same-site filtering
          // happens INSIDE the selector before the 5-seed cap, so valid
          // tenant URLs are never crowded out by higher-scoring other-tenant
          // or off-site URLs. Off-site/private destinations never survive
          // the pre-filter, so the crawler never requests them. The cached
          // identity reuses seedIdentities (no per-URL seed re-resolution).
          for(const candidate of selectSameSiteSitemapSeedCandidates(
            seed.url,
            (inventory.urls||[]).map(entry=>({loc:String(entry.loc||'')})),
            String(inventory.sourceUrl||seed.url),
            MAX_LADDER_SITEMAP_SEEDS,
            identity,
          )){
            if(websiteUrls.some(existing=>existing.url===candidate.url)||sitemapSeeds.some(existing=>existing.url===candidate.url))continue;
            sitemapSeeds.push({url:candidate.url,kind:'WEBSITE',contextMatches:false,source:'SITEMAP_DISCOVERY',sitemapUrl:candidate.sitemapUrl});
          }
        }
      }
      if(sitemapSeeds.length)websiteUrls=rankCommunitySurfaces([...websiteUrls,...sitemapSeeds]);
      ladderSeedAdmission={admitted:sitemapSeeds.length,considered:ladderSeedsConsidered};
    }catch{/* sitemap seeding never breaks seed selection */}
  }
  // Repeat-failure skip set: URLs with 5+ consecutive identical deterministic
  // failures are skipped (fail-open to empty on any history error so a
  // telemetry outage can never block crawling). History is scoped to the
  // current candidates with a per-URL window, so busy channels cannot push a
  // candidate's streak outside the read.
  let skippedRepeatUrls=new Set<string>();
  // Failure history for this inspection's candidates (fail-open): drives the
  // repeat-failure skip set below and the consecutive-timeout retry
  // suppression at the acquisition-status boundary.
  let loadedFailureHistory: UrlFailureRow[] = [];
  if(channelData.channelId&&(websiteUrls.length||socialBioUrls.length)){try{
    const skipCandidateUrls=[...websiteUrls,...socialBioUrls].map(item=>normalizeSkipUrl(item.url)).filter(Boolean);
    const historyRows=channelData.urlFailureHistoryLoader
      ?await channelData.urlFailureHistoryLoader(channelData.channelId,skipCandidateUrls)
      :await fetchUrlFailureHistory(channelData.channelId,skipCandidateUrls);
    loadedFailureHistory = historyRows;
    skippedRepeatUrls=skippedUrlsFromHistory(historyRows);
  }catch(error){console.warn(`[RepeatFailureSkip] History load failed for ${channelData.channelId}; crawling without skips:`,error instanceof Error?error.message:String(error));bumpRepeatFailureHistoryOutage();skippedRepeatUrls=new Set<string>();loadedFailureHistory=[];}}
  let repeatSkippedCount=0;
  // Community-relevant skips drive final uncertainty: auxiliary-only skips
  // (affiliate/commerce/asset-pattern URLs under the repeat cap) are still
  // skipped and logged, but they can never manufacture PARTIAL/uncertain
  // acquisition state on their own.
  let repeatSkippedRelevantCount=0;
  const repeatSkipLine=(url:string):string|null=>{
    const key=normalizeSkipUrl(url);
    if(!key||!skippedRepeatUrls.has(key))return null;
    repeatSkippedCount++;
    if(!isAuxiliaryForOutcome(key))repeatSkippedRelevantCount++;
    bumpRepeatFailureSkip(1);
    return `Skipping repeatedly-failing URL under the repeat-failure cap (5 consecutive identical failures): ${url}; remaining surfaces continue normally.`;
  };

  const step5Logs:string[]=[];const websiteCandidates:DiscordCandidate[]=[];
  // Seeds whose rendered run retained invite(s) while leaving a required gap
  // outstanding (FOUND_REQUIRED_GAP): invites stay displayed while the gap
  // keeps bounded recovery alive, so multi-invite recall is never sacrificed
  // to eliminate the incomplete status.
  const foundGapSeeds:{url:string;retryable:boolean}[]=[];
  // v2 shared-evidence registry (same inspection only — never crosses
  // creators, since every candidate pool here belongs to one investigation):
  // normalized visit key → terminal-success rendered records with evidence
  // weight, candidate counts, and discovered hint links for required-closure
  // proofs. Static terminal-success finals accumulate separately for
  // same-tier pre-seeding (rendered runs never skip on static evidence:
  // tier monotonicity — only rendered evidence satisfies rendered needs).
  interface SharedRenderedRecord {bySeed:string;pages:number;candidatesFound:number;hintLinks:string[];complete:boolean;}
  const sharedRenderedEvidence=new Map<string,SharedRenderedRecord[]>();
  const sharedStaticVisited=new Set<string>();
  const sharedStaticRoots=new Map<string,SharedStaticRootRecord>();
  // Lender feed gate: only terminal-success static roots enter the shared
  // inventory (see isReusableStaticRootLender). Truncated/incomplete lenders
  // never become reusable, so borrowers can never inherit cut coverage.
  const feedSharedStaticRoot=(seedUrl:string,crawlRes:{outcome:unknown;visitedUrls?:unknown;rootNavigation?:unknown;communityIntent?:CommunityIntentEvidence[]}):boolean=>{
    const record=buildSharedStaticRootRecord(seedUrl,crawlRes);
    const rootKey=normalizeVisitUrl(seedUrl);
    if(!record||!rootKey||sharedStaticRoots.has(rootKey))return false;
    sharedStaticRoots.set(rootKey,record);
    return true;
  };
  // Lender gate (fail closed): only complete, non-timed-out rendered runs
  // without an interaction gap may enter the shared inventory. A truncated or
  // interaction-gapped lender would let a later borrower skip rendering based
  // on coverage that never existed — the exact class of leak this gate closes.
  const recordRenderedEvidence=(seedUrl:string,rendered:{visitedUrls?:string[];pageHintLinks?:Record<string,string[]>;inspectedPages?:number;complete?:boolean;timedOut?:boolean;interactionGap?:boolean},candidates:{sourceUrl?:string}[]):void=>{
    if(rendered.complete!==true||rendered.timedOut===true||rendered.interactionGap===true)return;
    const hintIndex=rendered.pageHintLinks||{};
    for(const raw of rendered.visitedUrls||[]){const key=normalizeVisitUrl(raw);if(!key)continue;const found=candidates.filter(c=>normalizeVisitUrl(c.sourceUrl||'')===key).length;const list=sharedRenderedEvidence.get(key)||[];if(!list.some(r=>r.bySeed===seedUrl))list.push({bySeed:seedUrl,pages:1,candidatesFound:found,hintLinks:[...(hintIndex[key]||[])],complete:true});sharedRenderedEvidence.set(key,list);}
  };
  const findRenderedShare=(seedUrl:string):SharedRenderedRecord|null=>{const key=normalizeVisitUrl(seedUrl);if(!key)return null;const recs=sharedRenderedEvidence.get(key);const rec=recs&&recs[0];if(!rec||rec.complete!==true)return null;for(const raw of rec.hintLinks){const hk=normalizeVisitUrl(raw);if(!hk)continue;if(!sharedRenderedEvidence.get(hk)?.length)return null;}return rec;};
  // R6 admission audit trail: truncation recovery/signal lines join the Step 4
  // log so the trail shows exactly which seeds were recovered or flagged.
  for(const line of admissionRejectionLogs)step5Logs.push(line);
  for(const line of admissionRecoveryLogs)step5Logs.push(line);
  for(const line of admissionTruncationSignals)step5Logs.push(line);
  for(const line of seedDedupeLogs)step5Logs.push(line);
  // Global site-inspection dedup (WEBSITE-kind seeds only; SOCIAL profiles
  // are inherently per-creator path-tenants and MESSAGING previews are
  // cheap — both bypass the cache and crawl as before). Each seed maps to
  // a site identity; creator->site associations are always recorded; fresh
  // cached inspections are borrowed instead of recrawled. Fail-open: any
  // cache failure crawls everything exactly as before.
  const siteCache:SiteInspectionStore=channelData.siteInspectionStore||{
    read:(identities)=>getSiteInspections(identities),
    write:(row)=>upsertSiteInspection(row),
    recordLinks:(channelId,links)=>recordCreatorSiteLinks(channelId,links),
  };
  const siteIdentityByUrl=new Map<string,SiteIdentity>();
  const siteRowsByIdentity=new Map<string,SiteInspectionRow>();
  try{
    for(const item of websiteUrls){
      const identity=canonicalSiteIdentity(item.url);
      if(identity)siteIdentityByUrl.set(item.url,identity);
    }
    if(channelData.channelId&&siteIdentityByUrl.size){
      await siteCache.recordLinks(channelData.channelId,Array.from(siteIdentityByUrl.entries()).map(([url,identity])=>({siteIdentity:identity.siteIdentity,sourceSurface:'CREATOR_WEBSITES',sourceUrl:url}))).catch(()=>undefined);
    }
    if(siteIdentityByUrl.size){
      const rows=await siteCache.read(Array.from(siteIdentityByUrl.values()).map(identity=>identity.siteIdentity)).catch(()=>[] as SiteInspectionRow[]);
      for(const row of rows)if(row&&row.siteIdentity)siteRowsByIdentity.set(row.siteIdentity,row);
      // Prefetch redirect-alias destinations one hop so the per-seed borrow
      // block can resolve without extra reads. Chains are never chased.
      const needFinals:string[]=[];
      for(const row of rows){
        if(!row||row.outcome!=='REDIRECTED')continue;
        for(const destination of redirectDestinations(row)){
          const finalIdentity=canonicalSiteIdentity(destination);
          if(!finalIdentity||finalIdentity.siteIdentity===row.siteIdentity)continue;
          if(!siteRowsByIdentity.has(finalIdentity.siteIdentity)&&!needFinals.includes(finalIdentity.siteIdentity))needFinals.push(finalIdentity.siteIdentity);
        }
      }
      if(needFinals.length){
        const finalRows=await siteCache.read(needFinals).catch(()=>[] as SiteInspectionRow[]);
        for(const row of finalRows)if(row&&row.siteIdentity)siteRowsByIdentity.set(row.siteIdentity,row);
      }
    }
  }catch{/* site cache must never break inspection */}
  // Captures one seed's site-facts after its crawl (static + rendered when
  // run) for future borrowers. Best-effort: never throws into inspection.
  const captureSeedSiteInspection=async(item:{url:string;wrapperUrl?:string},outcomeStart:number,candidateStart:number,renderedCovered:boolean,intentStart:number):Promise<void>=>{
    try{
      const seedObservations=acquisitionOutcomes.slice(outcomeStart);
      const seedCandidates=websiteCandidates.slice(candidateStart);
      const seedCommunityIntents=communityIntentEvidence.slice(intentStart);
      const seedFinal=[...seedObservations].reverse().find(o=>typeof o.finalUrl==='string'&&o.finalUrl)?.finalUrl as string|undefined;
      const identity=canonicalSiteIdentity(item.url,seedFinal||null);
      if(!identity)return;
      // Aggregate outcome (E1): strongest observation + candidate presence,
      // never array position. `rollup` remains only for HTTP status/detail.
      const rollup=[...seedObservations].reverse().find(o=>o.requestedUrl===item.url);
      const invites=seedCandidates.map(c=>c.nativeInviteCode).filter((code):code is string=>typeof code==='string'&&!!code);
      const outcome=aggregateSeedOutcome(seedObservations,invites.length);
      // Claim handshake (E2): candidate-bearing rows start PENDING; the queue
      // flips them to CLAIMED once admission committed. PENDING rows are never
      // reusable, so the crash window between cache write and claim forces an
      // idempotent re-admission instead of silent discovery loss.
      const claimStatus=invites.length?SITE_INSPECTION_CLAIM_STATUS.PENDING:SITE_INSPECTION_CLAIM_STATUS.NONE;
      await siteCache.write({
        siteIdentity:identity.siteIdentity,identityTier:identity.tier,identityBasis:identity.basis,
        canonicalUrl:identity.crawlUrl,finalUrl:seedFinal||null,outcome,
        retryable:seedObservations.some(o=>o.retryable===true),
        httpStatus:typeof rollup?.httpStatus==='number'?rollup.httpStatus:null,
        failureClass:rollup?.failureClass||'',
        detail:rollup?.detail||`Seed crawl captured for site dedup (${seedObservations.length} observation(s))`,
        payloadChecksum:checksumSiteFacts({outcome,inviteCodes:invites,finalUrl:seedFinal||null}),
        candidates:seedCandidates as unknown as Array<Record<string,unknown>>,
        observations:seedObservations as unknown as Array<Record<string,unknown>>,
        communityIntents:seedCommunityIntents as unknown as Array<Record<string,unknown>>,
        renderedCovered,
        sourceChannelId:channelData.channelId||null,
        claimStatus,
        provenance:{policyVersion:SITE_INSPECTION_POLICY_VERSION},
      });
      const requestedIdentity=canonicalSiteIdentity(item.url);
      if(seedFinal&&requestedIdentity&&requestedIdentity.siteIdentity!==identity.siteIdentity){
        // Redirect crossed site identities: merge this requested-URL binding
        // into the alias row so distinct wrappers on the same host coexist
        // instead of overwriting each other. Alias rows carry no facts and
        // are never borrowed directly — exact-binding one-hop resolution
        // only. The pre-crawl link records what the creator linked; the
        // destination association below records what was inspected.
        const priorAlias=siteRowsByIdentity.get(requestedIdentity.siteIdentity);
        const priorBindings=priorAlias&&priorAlias.outcome==='REDIRECTED'?priorAlias.observations:[];
        await siteCache.write({
          siteIdentity:requestedIdentity.siteIdentity,identityTier:requestedIdentity.tier,identityBasis:requestedIdentity.basis,
          canonicalUrl:requestedIdentity.crawlUrl,finalUrl:seedFinal,outcome:'REDIRECTED',
          retryable:false,httpStatus:typeof rollup?.httpStatus==='number'?rollup.httpStatus:null,
          failureClass:'',detail:`Redirect observed from ${item.url} to ${seedFinal}; destination facts live under ${identity.siteIdentity}`,
          payloadChecksum:checksumSiteFacts({outcome:'REDIRECTED',inviteCodes:[],finalUrl:seedFinal}),
          candidates:[],observations:mergeRedirectBinding(priorBindings,{kind:REDIRECT_BINDING_KIND,requestedUrl:item.url,finalUrl:seedFinal,observedAt:now}),
          renderedCovered:false,
          provenance:{policyVersion:SITE_INSPECTION_POLICY_VERSION},
        });
        if(channelData.channelId){
          await siteCache.recordLinks(channelData.channelId,[{siteIdentity:identity.siteIdentity,sourceSurface:'CREATOR_WEBSITES',sourceUrl:seedFinal||item.url}]).catch(()=>undefined);
        }
      }
    }catch{/* site cache must never break inspection */}
  };
  // Messaging previews are attempted first via the lightweight static path so a
  // cheap FOUND can never be starved by expensive website crawls, and messaging
  // candidates join websiteCandidates before the Step 4 aggregate below.
  if(messagingUrls.length){step5Logs.push(`Inspecting ${messagingUrls.length} messaging preview URL(s) via lightweight static inspection (0 default Playwright launches; render only on bridge evidence).`);for(const item of messagingUrls){step5Logs.push(`[Messaging preview] ${item.url} (Source: ${item.source})`);let preview:Awaited<ReturnType<typeof crawlMessagingPreview>>|null=null;try{preview=await crawlMessagingPreview(item.url,[],debugLog,channelData.externalFetchImpl||fetch,'CREATOR_WEBSITES',item.wrapperUrl,channelData.destinationResolver);}catch(error:any){acquisitionOutcomes.push({requestedUrl:item.url,wrapperUrl:item.wrapperUrl,surface:'CREATOR_WEBSITES',required:true,outcome:'ACQUISITION_FAILED',retryable:true,failureClass:'ISOLATED_ACQUISITION_ERROR',detail:`Messaging preview isolated after unexpected error; remaining candidates continue: ${error instanceof Error?error.message:String(error)}`,observedAt:now,telemetry:staticCrawlerTelemetry({redirectsFollowed:0,pagesInspected:0})});continue;}acquisitionOutcomes.push(...preview.observations);websiteCandidates.push(...preview.candidates);retainCommunityIntent(preview.communityIntent);if(preview.outcome==='FOUND'){step5Logs.push(`Messaging preview retained Discord candidate(s) statically; no escalation needed.`);continue;}    // Bridge evidence alone justifies escalation: creator classification must
    // never silently suppress a legitimate messaging discovery path. A
    // truncated preview escalates the same way: the unobserved remainder may
    // hold the invite, so a cut-off prefix without bridge evidence still keeps
    // its rendered-fallback eligibility instead of resolving clean.
    const previewSsrfBarrier=preview.observations.some(o=>String(o.failureClass||'')==='SSRF_BLOCKED');if(previewSsrfBarrier){step5Logs.push(`[Security barrier] ${item.url} static SSRF destination block is terminal; no rendered escalation.`);continue;}if(preview.outcome==='ACQUISITION_FAILED'||(!preview.bridgeEvidence&&!preview.truncated))continue;const {crawlRenderedCommunitySurface:renderMessagingSurface,wasRenderedResultProcessed}=await import('./browserCommunityFallback');const rendered=await (channelData.renderedFallback||renderMessagingSurface)(item.url,{clickOffset:renderedClickOffsetForSeed(item.url),resolveHost:channelData.destinationResolver}).catch((error:any)=>isolatedRenderedFallback(item.url,error));const renderedProcessed=wasRenderedResultProcessed(rendered);const renderedCandidates=normalizedRenderedCandidates(rendered,'CREATOR_WEBSITES',item.url);websiteCandidates.push(...renderedCandidates);const renderedResult=renderedAcquisitionOutcome(rendered,renderedProcessed,renderedCandidates,requiredGapFromRendered(rendered)),renderedOutcome:ExternalAcquisitionStatus=renderedResult.outcome;acquisitionOutcomes.push({requestedUrl:item.url,finalUrl:rendered.foundLocation,wrapperUrl:item.wrapperUrl,surface:'CREATOR_WEBSITES',required:true,outcome:renderedOutcome,retryable:renderedResult.failureClass==='SSRF_BLOCKED'?false:(renderedResult.gapRetryable!==undefined?renderedResult.gapRetryable:(rendered.retryable||!renderedProcessed)),failureClass:renderedResult.failureClass,detail:rendered.detail,observedAt:now,telemetry:renderedCrawlerTelemetry({inspectedPages:rendered.inspectedPages,clicks:rendered.clicks,complete:rendered.complete,timedOut:rendered.timedOut,telemetry:rendered.telemetry,scrollsUsed:rendered.scrolls||0,dropReasons:rendered.dropReasons})});step5Logs.push(renderedCandidates.length?`Messaging rendered fallback retained ${renderedCandidates.length} candidate(s).`:rendered.detail);}}
  if(websiteUrls.length||messagingUrls.length){step5Logs.push(`Crawling ${websiteUrls.length} website URLs${messagingUrls.length?` (plus ${messagingUrls.length} messaging preview(s) inspected above)`:''}; discovery continues after a first invite.`);
  // R6 relevance pre-pass (flag-gated, fail-open): classify each website seed
  // from stored pre-acquisition signals only (no fetch). BLOCKED seeds skip
  // below with audit only (no observation/failure/retry/NO_MATCH); DEMOTED
  // seeds crawl after eligible, static-only, no render unless bridge/FOUND.
  // Disabled/errored → legacy order byte-identical.
  let relevanceEnforcement = false;
  try { relevanceEnforcement = await isRelevanceEnforcementEnabled(); } catch { relevanceEnforcement = false; }
  let loginSemantics = true;
  try { loginSemantics = await isLoginBlockSemanticsEnabled(); } catch { loginSemantics = true; }
  let strictBorrow = true;
  try { strictBorrow = await isPathAwareShortlinkBorrowEnabled(); } catch { strictBorrow = true; }
  let partialStaticRetry = true;
  try { partialStaticRetry = await isPartialStaticRetryEnabled(); } catch { partialStaticRetry = true; }
  const relevanceDecisions = new Map<string, RelevanceDecision>();
  let creatorCanonicalHosts: Set<string> = new Set();
  try {
    // Live-refreshed channel links (About-page refresh above merges into
    // `links`): a creator site discovered during the current inspection gets
    // the same canonical treatment and never demotes for being new.
    creatorCanonicalHosts = new Set(creatorWebsiteHostsFromLinks(links || []));
  } catch { creatorCanonicalHosts = new Set(); }
  if (relevanceEnforcement && websiteUrls.length > 1) {
    try {
      const scored = websiteUrls.map((item, index) => {
        let decision: RelevanceDecision;
        try {
          decision = classifyUrlRelevance({
            url: item.url,
            source: (item as { source?: string }).source || '',
            contextMatches: (item as { contextMatches?: boolean }).contextMatches === true,
            wrapperUrl: (item as { wrapperUrl?: string }).wrapperUrl,
            creatorCanonicalHosts,
          });
        } catch {
          decision = classifyUrlRelevance({ url: item.url, source: '', contextMatches: false });
        }
        relevanceDecisions.set(item.url, decision);
        return { item, index, demoted: decision.tier === 'DEMOTE' ? 1 : 0 };
      });
      scored.sort((a, b) => a.demoted - b.demoted || a.index - b.index);
      websiteUrls = scored.map(s => s.item);
    } catch { /* ordering never breaks inspection */ }
  }
  if (debugLog && !Array.isArray((debugLog as { relevanceDecisions?: unknown }).relevanceDecisions)) {
    (debugLog as { relevanceDecisions?: unknown[] }).relevanceDecisions = [];
  }
  for(const item of websiteUrls){
  // R6 admission boundary (shared, defense-in-depth for non-collection seeds
  // such as sitemap nominations): rejected candidates never reach scoring or
  // crawling. Collection-time admission already filters observed links.
  const seedAdmissionCheck=assessCrawlAdmission(item.url);if(!seedAdmissionCheck.eligible){step5Logs.push(`Admission rejected (${seedAdmissionCheck.reasonCode}): ${item.url}; not crawled.`);continue;}
  // R6 relevance enforcement (flag-gated, fail-open, audit-preserving):
  // BLOCKED URLs are logged with classification/reason/signals/source/
  // channel/URL/timestamp, discovery evidence stays recorded via
  // recordLinks above, and no acquisition observation is created (no
  // failure, retry ownership, or false INSPECTED_NO_MATCH).
  let seedRelevance: RelevanceDecision | undefined;
  if (relevanceEnforcement) {
    try {
      seedRelevance = relevanceDecisions.get(item.url) || classifyUrlRelevance({
        url: item.url,
        source: (item as { source?: string }).source || '',
        contextMatches: (item as { contextMatches?: boolean }).contextMatches === true,
        wrapperUrl: (item as { wrapperUrl?: string }).wrapperUrl,
        creatorCanonicalHosts,
      });
      relevanceDecisions.set(item.url, seedRelevance);
    } catch { seedRelevance = undefined; }
    if (seedRelevance && seedRelevance.tier === 'BLOCK') {
      const audit = `[Relevance BLOCKED] ${item.url} (reason: ${seedRelevance.reason}; signals: host=${seedRelevance.signals.hostname} family=${seedRelevance.signals.platformFamily} path=${seedRelevance.signals.path} source=${seedRelevance.signals.source}; channel=${(channelData as { channelId?: string }).channelId || 'unknown'}; ${new Date().toISOString()})`;
      step5Logs.push(audit);
      try {
        ((debugLog as { relevanceDecisions?: unknown[] }).relevanceDecisions || []).push({
          url: item.url, tier: 'BLOCK', reason: seedRelevance.reason, signals: seedRelevance.signals,
          source: (item as { source?: string }).source || '', channelId: (channelData as { channelId?: string }).channelId || null,
          observedAt: new Date().toISOString(), policyVersion: seedRelevance.policyVersion,
        });
      } catch { /* audit never breaks inspection */ }
      continue;
    }
    if (seedRelevance && seedRelevance.tier === 'DEMOTE') {
      step5Logs.push(`[Relevance DEMOTED] ${item.url} (reason: ${seedRelevance.reason}; static-only, order-last, no render unless bridge/FOUND).`);
    }
    // Per-URL audit (flag-gated): every classified seed records tier/reason/
    // signals/source/channel/URL/timestamp so the classification of any
    // discovered URL (blocked, demoted, or eligible) is determinable later.
    if (relevanceEnforcement && seedRelevance) {
    try {
      ((debugLog as { relevanceDecisions?: unknown[] }).relevanceDecisions || []).push({
        url: item.url, tier: seedRelevance.tier,
        reason: seedRelevance.reason,
        signals: seedRelevance.signals,
        source: (item as { source?: string }).source || '', channelId: (channelData as { channelId?: string }).channelId || null,
        observedAt: new Date().toISOString(), policyVersion: seedRelevance.policyVersion,
      });
    } catch { /* audit never breaks inspection */ }
    }
  }
  const seedOutcomeStart=acquisitionOutcomes.length,seedCandidateStart=websiteCandidates.length,seedIntentStart=communityIntentEvidence.length;let seedRenderedCovered=false;
  const repeatSkipWeb=repeatSkipLine(item.url);if(repeatSkipWeb){step5Logs.push(repeatSkipWeb);continue;}
  const seedSiteIdentity=siteIdentityByUrl.get(item.url);
  // One-hop redirect-alias resolution: alias rows carry no facts, only the
  // observed requested-URL -> destination-identity redirect. Resolve to the
  // destination row (recrawl when unresolvable); never borrow the alias
  // itself and never chase chains.
  let seedCachedRow=seedSiteIdentity?siteRowsByIdentity.get(seedSiteIdentity.siteIdentity):undefined;
  let coverageUrl=item.url;
  if(seedCachedRow&&seedCachedRow.outcome==='REDIRECTED'
    &&isSiteInspectionReusable(seedCachedRow,Date.now())){
    // Exact-binding resolution: only the binding recorded for this requested
    // URL may resolve. Other wrappers sharing the host never match, so their
    // destinations can neither be borrowed nor merged here.
    const binding=redirectBindingFor(seedCachedRow,item.url,Date.now());
    const finalIdentity=binding?canonicalSiteIdentity(binding.finalUrl):null;
    const finalRow=finalIdentity&&seedSiteIdentity&&finalIdentity.siteIdentity!==seedSiteIdentity.siteIdentity
      ?siteRowsByIdentity.get(finalIdentity.siteIdentity):undefined;
    if(binding&&finalRow&&finalRow.outcome!=='REDIRECTED'){seedCachedRow=finalRow;coverageUrl=binding.finalUrl;}
    else{seedCachedRow=undefined;}
  }
  const seedReusable=seedCachedRow?isSiteInspectionReusable(seedCachedRow,Date.now()):false;
  const seedCovered=seedCachedRow?siteInspectionCoversRequest(seedCachedRow,coverageUrl,{ strictFoundCoverage: strictBorrow }):false;
  // Blocked results are never shared as final across URLs: LOGIN_WALL,
  // PAYWALL_WALL, and PERMANENT_ACCESS_BLOCK rows are coverage facts for
  // their own exact page only when strictBorrow holds; legacy (flag off)
  // preserves prior borrow behavior. Exact-page means the borrower's URL
  // matches the row's canonical/final OR a previously requested/root URL on
  // the row (same page, e.g. after a login redirect) — never another path on
  // the same host.
  if(seedCachedRow&&(seedCachedRow.failureClass==='LOGIN_WALL'||seedCachedRow.failureClass==='PAYWALL_WALL'||seedCachedRow.failureClass==='PERMANENT_ACCESS_BLOCK')&&strictBorrow){
    if(!isExactBarrierPageCover(seedCachedRow,coverageUrl)){seedCachedRow=undefined;}
  }
  // Same-owner cache candidate recovery (E3): the row holds THIS channel's
  // own unclaimed candidates from a crashed/quota-aborted run (PENDING claim
  // handshake). Borrow the coverage observations and push the candidates back
  // through the normal pipeline: global claim, ownership inference, and
  // validation still decide. Cross-creator borrows never reach this path and
  // stay candidate-free; the queue flips the row to CLAIMED once admission
  // commits.
  // Migration 150: the row may now contain another channel's pending
  // candidates alongside ours, so recovery is decided by this channel's own
  // pending map entry, not by the last writer's row-level source channel.
  const sameOwnerRecovery = hasSameOwnerPendingCandidates(seedCachedRow, channelData.channelId);
  if (sameOwnerRecovery) {
    const borrowed = buildBorrowedSiteInspection(seedCachedRow!,{requestedUrl:item.url,surface:'CREATOR_WEBSITES',required:false,wrapperUrl:item.wrapperUrl,observedAt:now,channelId:channelData.channelId});
    retainCommunityIntent(borrowed.communityIntents as unknown as CommunityIntentEvidence[]);
    const recoveredCandidates = borrowed.recoveredCandidates as unknown as DiscordCandidate[];
    if (recoveredCandidates.length) {
      websiteCandidates.push(...recoveredCandidates);
      step5Logs.push(`[Site cache] ${item.url} recovered ${recoveredCandidates.length} same-owner candidate(s) from cached inspection for re-admission (${seedCachedRow!.siteIdentity}, observed ${seedCachedRow!.lastObservedAt}).`);
      // Explicit recovery audit (P3 item 12): the recovery itself is recorded,
      // best-effort, before the candidates re-enter normal admission.
      await recordDiscoveryRecoveryAudit({
        channelId: channelData.channelId,
        source: 'CACHE',
        siteIdentity: seedCachedRow!.siteIdentity,
        candidateIds: recoveredCandidates.map(candidate => candidate.candidateId),
        detail: `same-owner cache recovery for ${item.url}`,
      }).catch(() => undefined);
      // PENDING rows are deliberately non-reusable (E2), so recovered
      // candidates do not imply complete coverage. Only borrow observations
      // when the ordinary coverage gate would also have allowed the borrow;
      // otherwise fall through and recrawl so unfinished pages are not
      // mistaken for a completed inspection.
      const canBorrowRecovered = seedReusable && seedCovered
        && !(channelData.bypassBorrowedCoverage && (seedCachedRow!.retryable || seedCachedRow!.outcome === 'PARTIALLY_INSPECTED'));
      if (canBorrowRecovered) {
        acquisitionOutcomes.push(...borrowed.observations as unknown as ExternalAcquisitionObservation[]);
        continue;
      }
    }
  }
  if(seedCachedRow&&seedReusable&&!seedCovered){
    step5Logs.push(`[Site cache] ${item.url} not covered by cached inspection for ${seedCachedRow.siteIdentity} (cached ${seedCachedRow.lastObservedAt}); recrawling for full path coverage.`);
  }
  if(seedCachedRow&&seedReusable&&seedCovered&&!(channelData.bypassBorrowedCoverage&&(seedCachedRow.retryable||seedCachedRow.outcome==='PARTIALLY_INSPECTED'))){
    // Coverage-only borrow (cross-creator invariant): a freshly covered site
    // is never re-crawled for a later creator, and the originating
    // investigation's discoveries are never transferred. Only coverage
    // observations are reused; candidates stay with their own investigation,
    // so the borrower receives zero of the originator's Discord/Telegram/
    // community discoveries. Creator-dependent rendered escalation is
    // intentionally absent here: site-driven recrawls (stale TTL, uncovered
    // paths) still happen above and below; creator difference alone never
    // triggers a new crawl.
    // Retry-owned reacquisitions bypass borrowing ONLY for incomplete site
    // coverage (retryable or PARTIALLY_INSPECTED): the unresolved site is
    // re-acquired, while unrelated freshly covered sites still borrow. The
    // flag alone never disables borrowing for complete coverage.
    const borrowed=buildBorrowedSiteInspection(seedCachedRow,{requestedUrl:item.url,surface:'CREATOR_WEBSITES',required:false,wrapperUrl:item.wrapperUrl,observedAt:now});
    retainCommunityIntent(borrowed.communityIntents as unknown as CommunityIntentEvidence[]);
    step5Logs.push(`[Site cache] ${item.url} reuses site inspection for ${seedCachedRow.siteIdentity} (observed ${seedCachedRow.lastObservedAt}); no recrawl, no borrowed candidates.`);
    // Relevance tagging for borrows (flag-gated): a DEMOTE seed reusing
    // cached coverage stays non-owning exactly like a fresh demoted crawl.
    // BLOCKED seeds never reach borrowing (skipped with audit only above).
    if (relevanceEnforcement && seedRelevance) {
      for (const obs of borrowed.observations) {
        (obs as unknown as Record<string, unknown>).relevanceTier = seedRelevance.tier;
        (obs as unknown as Record<string, unknown>).relevanceReason = seedRelevance.reason;
      }
    }
    acquisitionOutcomes.push(...borrowed.observations as unknown as ExternalAcquisitionObservation[]);
    continue;
  }
  if(seedCachedRow&&seedReusable&&seedCovered){
    step5Logs.push(`[Site cache] ${item.url} bypasses borrowed coverage for retry-owned reacquisition of incomplete coverage; re-crawling.`);
  }
  step5Logs.push(`[Crawling] ${item.url} (Priority Score: ${scoreCommunitySurface(item)}, Context Match: ${item.contextMatches}, Source: ${item.source})`);const crawlRes=(await safeCrawlStatic(item.url,debugLog,channelData.externalFetchImpl||fetch,'CREATOR_WEBSITES',item.wrapperUrl,ladderOn,frontierOptsFor(item.url),ladderOn?ladderSeedAdmission:undefined,evaluateDomainWeights,{visitedKeys:[...sharedStaticVisited,...sharedRenderedEvidence.keys()],roots:sharedStaticRoots},{ loginSemantics, partialStaticRetry },channelData.destinationResolver)).crawlRes;retainCommunityIntent(crawlRes.communityIntent);for(const raw of crawlRes.visitedUrls||[]){const key=normalizeVisitUrl(raw);if(key)sharedStaticVisited.add(key);}feedSharedStaticRoot(item.url,crawlRes);
  // Relevance telemetry (additive, no semantics): tag static observations with
  // tier/reason so retry ownership, outcome collapse, and audit can determine
  // eligibility without changing legacy behavior when disabled (ELIGIBLE).
  if (relevanceEnforcement && seedRelevance) {
    for (const obs of crawlRes.observations) {
      (obs as unknown as Record<string, unknown>).relevanceTier = seedRelevance.tier;
      (obs as unknown as Record<string, unknown>).relevanceReason = seedRelevance.reason;
    }
  }
  // Conclusive static terminal barrier (visible PARTIAL/FAILED, non-retryable)
  // never escalates this seed into rendered acquisition, which could
  // hide/replace the terminal result or restore retry ownership. Site facts
  // are still captured below as usual.
  const staticSsrfBarrier = crawlRes.observations.some(o =>
    String(o.failureClass || '') === 'SSRF_BLOCKED' &&
    normalizeVisitUrl(String(o.requestedUrl || '')) === normalizeVisitUrl(item.url));
  if (staticSsrfBarrier) markSsrfSeedRequired(crawlRes.observations, item.url);
  // Confirmed static 404/410 on an optional creator website is terminal: the
  // bounded body probe proved there is no link, community marker, block page,
  // or unread/truncated content that a rendered browser could still recover.
  // Required YouTube surfaces are structurally ineligible.
  const staticNotFoundBarrier = isConfirmedStaticTerminalNotFound({
    surface: 'CREATOR_WEBSITES',
    seedUrl: item.url,
    crawlOutcome: crawlRes.outcome,
    observations: crawlRes.observations,
    candidateCount: crawlRes.candidates.length,
    communityIntentCount: crawlRes.communityIntent?.length || 0,
  });
  if (staticNotFoundBarrier) markConfirmedStaticTerminalNotFound({ seedUrl: item.url, observations: crawlRes.observations });
  const staticTerminalBarrier = staticSsrfBarrier || staticNotFoundBarrier || (loginSemantics && crawlRes.observations.some(o =>
    (o.outcome === 'PARTIALLY_INSPECTED' || o.outcome === 'ACQUISITION_FAILED') &&
    (String(o.failureClass || '') === LOGIN_WALL_FAILURE_CLASS ||
     String(o.failureClass || '') === PAYWALL_FAILURE_CLASS ||
     String(o.failureClass || '') === PERMANENT_ACCESS_BLOCK_FAILURE_CLASS)));
  // Conclusive permanent block (flag-gated, fail-closed): identical
  // deterministic 401/403 + markers across bounded retries → terminal
  // PERMANENT_ACCESS_BLOCK (visible FAILED, non-retryable, never NO_MATCH).
  // Single failures, missing fields, or non-identical history stay retryable.
  if (loginSemantics) {
    try {
      const seedObs = crawlRes.observations.filter(o => o.requestedUrl === item.url && o.outcome === 'ACQUISITION_FAILED' && String(o.failureClass || '') === 'HTTP_ERROR' && (Number(o.httpStatus) === 401 || Number(o.httpStatus) === 403));
      for (const obs of seedObs) {
        const markers = (obs as unknown as Record<string, unknown>).blockMarkers === true;
        if (!markers) continue;
        const conclusive = isConclusivePermanentBlock({
          current: {
            requestedUrl: obs.requestedUrl, failureClass: obs.failureClass, httpStatus: obs.httpStatus,
            finalUrl: (obs as { finalUrl?: unknown }).finalUrl, outcome: obs.outcome,
            pagesInspected: (obs.telemetry as { pagesInspected?: unknown } | undefined)?.pagesInspected,
            hasCandidates: false, blockMarkers: true,
          },
          history: (loadedFailureHistory || [])
            // Scope to this seed: another candidate URL must neither
            // contribute to nor break this seed's permanence streak. Timestamps
            // are preserved so the detector reconstructs true chronology.
            .filter(row => String(row.requestedUrl || '').trim() === String(obs.requestedUrl || '').trim())
            .map(row => ({
              requestedUrl: row.requestedUrl, failureClass: row.failureClass, httpStatus: row.httpStatus,
              finalUrl: row.finalUrl, outcome: row.outcome, pagesInspected: 0, hasCandidates: false,
              observedAt: (row as { observedAt?: unknown }).observedAt,
            })),
        });
        if (conclusive) {
          obs.failureClass = PERMANENT_ACCESS_BLOCK_FAILURE_CLASS;
          obs.retryable = false;
          obs.detail = `${obs.detail}; conclusive permanent access block established over bounded identical retries (terminal, no further identical retry)`;
          step5Logs.push(`[Permanent block] ${item.url} conclusive PERMANENT_ACCESS_BLOCK (identical 401/403 + markers over bounded retries); terminal, visible, no retry.`);
        }
      }
    } catch { /* permanent-block check never breaks inspection */ }
  }
  acquisitionOutcomes.push(...crawlRes.observations);for(const shadow of crawlRes.domainWeightShadows||[])step5Logs.push(`[DomainWeightShadow] site=${shadow.siteIdentity} weights=${shadow.weightsVersion} routes=${shadow.routeCount} baseline=${shadow.baselineTopUrl} shadow=${shadow.shadowPickUrl} agreement=${shadow.agreement}.`);websiteCandidates.push(...crawlRes.candidates);const staticMerged=mergeDiscordCandidates(crawlRes.candidates,ownershipInput);const hasCreatorOwned=staticMerged.some(c=>c.ownershipStatus==='CREATOR_OWNED');// Eligibility doctrine: every admitted website URL — including auxiliary,
// broker/affiliate-pattern and promotional hosts — remains eligible for the
// normal acquisition path below. Static inspection only orders attempts and
// provides cheap evidence; it never decides whether a site is worth crawling.
// Admission-rejected candidates (malformed/dotless single-label hosts such as
// `https://g/`, asset/resource URLs) never reach this point: the shared crawl
// admission boundary (`assessCrawlAdmission`) rejects them with
// DOTLESS_HOST/ASSET_HOST/RESOURCE_EXTENSION before scoring and crawling, so
// no static attempt, rendered escalation, or retry work can follow. Any
// syntactically legitimate public website, including a creator URL containing
// `/referral/`, keeps full rendered eligibility under the existing policy.
    if(isAuxiliaryTriageCandidate(item)){step5Logs.push(`Auxiliary triage (static-first, still fully eligible for deeper acquisition): ${item.url}`);}
    // DEMOTE tier (flag-gated, strict static-only): crawled after eligible
    // with existing static caps (small bounded budget), no browser rendering,
    // no scrolling/clicking/interaction, and no escalation for any reason —
    // including static FOUND (invite already retained statically; ownership
    // is established from static evidence, never via browser for demoted
    // seeds). Budget remaining is never a reason to escalate demoted seeds.
    const isDemotedSeed = relevanceEnforcement && seedRelevance && seedRelevance.tier === 'DEMOTE';
    const demoteSkipsRender = isDemotedSeed === true;
    if (demoteSkipsRender) {
      step5Logs.push(`[Relevance DEMOTED] ${item.url} static-only complete (${crawlRes.outcome}); no rendered escalation under any outcome.`);
    }
    if (staticSsrfBarrier) {
      step5Logs.push(`[Security barrier] ${item.url} static SSRF destination block is terminal; no rendered escalation.`);
    } else if (staticNotFoundBarrier) {
      const notFoundObservation = crawlRes.observations.find(o =>
        String(o.requestedUrl || '') === item.url &&
        String(o.failureClass || '') === 'HTTP_ERROR' &&
        (Number(o.httpStatus) === 404 || Number(o.httpStatus) === 410));
      step5Logs.push(`[Terminal barrier] ${item.url} confirmed static HTTP ${notFoundObservation?.httpStatus || '404/410'} with no recoverable content; no rendered escalation.`);
    } else if (staticTerminalBarrier) {
      step5Logs.push(`[Terminal barrier] ${item.url} conclusive permanent barrier established statically (${crawlRes.outcome}); no rendered escalation.`);
    }
    if(!staticTerminalBarrier && !demoteSkipsRender && creatorLikelyTrading&&(crawlRes.outcome!=='FOUND'||!hasCreatorOwned)){const {crawlRenderedCommunitySurface,wasRenderedResultProcessed}=await import('./browserCommunityFallback');const ladderDecision=resolveRenderEscalation({staticOutcome:crawlRes.outcome,creatorLikelyTrading:true,surface:'CREATOR_WEBSITES',hasCreatorOwnedEvidence:crawlRes.outcome==='FOUND'&&hasCreatorOwned});if(ladderOn)step5Logs.push(`[Ladder] render decision for ${item.url}: ${ladderDecision.justification} (${ACQUISITION_LADDER_POLICY_VERSION}).`);const shouldRendered=ladderDecision.escalate;if(shouldRendered){const sharedHit=findRenderedShare(item.url);if(sharedHit){acquisitionOutcomes.push({requestedUrl:item.url,finalUrl:item.url,wrapperUrl:item.wrapperUrl,surface:'CREATOR_WEBSITES',required:false,outcome:sharedHit.candidatesFound>0?'FOUND':'INSPECTED_NO_MATCH',retryable:false,httpStatus:200,detail:`Shared rendered evidence from ${sharedHit.bySeed} (terminal success, no refetch).`,observedAt:now,telemetry:renderedCrawlerTelemetry({inspectedPages:1,clicks:0,complete:true})});step5Logs.push(`[Shared evidence] ${item.url} reuses rendered inspection from ${sharedHit.bySeed}; no refetch.`);await captureSeedSiteInspection(item,seedOutcomeStart,seedCandidateStart,false,seedIntentStart);continue;}const rendered=await (channelData.renderedFallback||crawlRenderedCommunitySurface)(item.url,{alreadyVisited:[...sharedRenderedEvidence.keys()],clickOffset:renderedClickOffsetForSeed(item.url),resolveHost:channelData.destinationResolver}).catch((error:any)=>isolatedRenderedFallback(item.url,error)),renderedProcessed=wasRenderedResultProcessed(rendered),renderedCandidates=normalizedRenderedCandidates(rendered,'CREATOR_WEBSITES',item.url);websiteCandidates.push(...renderedCandidates);const renderedResult=renderedAcquisitionOutcome(rendered,renderedProcessed,renderedCandidates,requiredGapFromRendered(rendered)),renderedOutcome:ExternalAcquisitionStatus=renderedResult.outcome;acquisitionOutcomes.push({requestedUrl:item.url,finalUrl:rendered.foundLocation,wrapperUrl:item.wrapperUrl,surface:'CREATOR_WEBSITES',required:true,outcome:renderedOutcome,retryable:renderedResult.failureClass==='SSRF_BLOCKED'?false:(renderedResult.gapRetryable!==undefined?renderedResult.gapRetryable:(rendered.retryable||!renderedProcessed)),failureClass:renderedResult.failureClass,detail:rendered.detail,observedAt:now,telemetry:renderedCrawlerTelemetry({inspectedPages:rendered.inspectedPages,clicks:rendered.clicks,complete:rendered.complete,timedOut:rendered.timedOut,telemetry:rendered.telemetry,scrollsUsed:rendered.scrolls||0,dropReasons:rendered.dropReasons,experimentAttribution:ladderRenderAttribution})});if(renderedCandidates.length&&renderedResult.gapRetryable!==undefined&&!isAuxiliaryForOutcome(item.url))foundGapSeeds.push({url:item.url,retryable:renderedResult.gapRetryable});recordRenderedEvidence(item.url,rendered,renderedCandidates);step5Logs.push(renderedCandidates.length?`Rendered fallback retained ${renderedCandidates.length} candidate(s).`:rendered.detail);seedRenderedCovered=isSufficientRenderedCoverage({complete:rendered.complete,timedOut:rendered.timedOut,interactionGap:rendered.interactionGap},renderedProcessed);}}
    // Seed-slice relevance tagging (flag-gated): covers rendered + shared-hit
    // observations pushed above so DEMOTE seeds stay non-owning through every
    // acquisition path. Static observations were tagged identically earlier.
    if (relevanceEnforcement && seedRelevance) {
      for (let tagIndex = seedOutcomeStart; tagIndex < acquisitionOutcomes.length; tagIndex++) {
        (acquisitionOutcomes[tagIndex] as unknown as Record<string, unknown>).relevanceTier = seedRelevance.tier;
        (acquisitionOutcomes[tagIndex] as unknown as Record<string, unknown>).relevanceReason = seedRelevance.reason;
      }
    }
    await captureSeedSiteInspection(item,seedOutcomeStart,seedCandidateStart,seedRenderedCovered,seedIntentStart);}if(repeatSkippedCount>0)step5Logs.push(`Skipped ${repeatSkippedCount} repeatedly-failing website URL(s) under the repeat-failure cap; remaining surfaces inspected normally.`);retainCandidates(websiteCandidates);const mergedWebsite=mergeDiscordCandidates(websiteCandidates,ownershipInput),websiteOutcomes=effectiveAcquisitionOutcomes(acquisitionOutcomes.filter(item=>item.surface==='CREATOR_WEBSITES'&&isMeaningfulWebsiteObservation(item)&&isCommunityRelevantObservation(item as {rootUrl?:string;requestedUrl:string})));if(mergedWebsite.length){const inviteCodes=mergedWebsite.map(candidate=>candidate.nativeInviteCode!).filter(Boolean);step5Logs.push(`Linked website acquisition retained ${mergedWebsite.length} distinct Discord candidate(s).`);step5Logs.push(`Retained invite code${inviteCodes.length===1?'':'s'}: ${inviteCodes.join(', ')}`);const foundRetryableGap=foundGapSeeds.filter(s=>s.retryable).length,foundExhaustedGap=foundGapSeeds.length-foundRetryableGap;if(foundRetryableGap>0)step5Logs.push(`${foundRetryableGap} retained invite surface(s) still have outstanding required evidence with bounded recovery.`);if(foundExhaustedGap>0)step5Logs.push(`${foundExhaustedGap} retained invite surface(s) have exhausted/permanent required gaps (no further retry).`);step5Logs.push(formatLinkedWebsiteAcquisitionSummary(summarizeEffectiveLinkedWebsiteAcquisition(acquisitionOutcomes)));addStep('CUSTOM_DOMAINS','Step 4 — Linked Websites','FOUND',step5Logs,mergedWebsite[0].nativeInviteCode||null,'CUSTOM_DOMAIN',inviteCodes);}else{const websiteSkippedOnly=repeatSkippedRelevantCount>0&&!mergedWebsite.length,failedCount=websiteOutcomes.filter(item=>item.outcome==='ACQUISITION_FAILED').length,inspectedCount=websiteOutcomes.filter(item=>item.outcome==='INSPECTED_NO_MATCH'&&hasProcessedAcquisitionEvidence(item)).length,partialCount=websiteOutcomes.filter(item=>item.outcome==='PARTIALLY_INSPECTED').length,unevidencedCount=websiteOutcomes.filter(item=>item.outcome==='INSPECTED_NO_MATCH'&&!hasProcessedAcquisitionEvidence(item)).length,failed=failedCount>0,inspected=inspectedCount>0,partial=partialCount>0||unevidencedCount>0;const acquisitionSummary=summarizeEffectiveLinkedWebsiteAcquisition(acquisitionOutcomes);step5Logs.push(formatLinkedWebsiteAcquisitionSummary(acquisitionSummary));step5Logs.push(failed&&inspected?`Effective outcome across unique URLs: ${inspectedCount} inspected successfully; ${failedCount} unavailable after fallback.`:failed?`Effective outcome across unique URLs: ${failedCount} unavailable after fallback; absence is not confirmed.`:(failed||inspected)&&partial?`${partialCount} linked website surface(s) were only partially inspected (crawl budget exhausted before full coverage); absence is not confirmed.`:partialCount>0?`${partialCount} linked website surface(s) were only partially inspected (crawl budget exhausted before full coverage); absence is not confirmed.`:unevidencedCount>0?`${unevidencedCount} linked website surface(s) produced no inspection evidence (zero pages/requests processed); absence is not confirmed.`:'No Discord invite found in successfully inspected linked websites.');addStep('CUSTOM_DOMAINS','Step 4 — Linked Websites',failed?(inspected||partial?'PARTIAL':'ERROR'):partial||websiteSkippedOnly?'PARTIAL':'NOT_FOUND',step5Logs);}}else addStep('CUSTOM_DOMAINS','Step 4 — Linked Websites','SKIPPED',[...admissionRejectionLogs,...admissionRecoveryLogs,...admissionTruncationSignals,'No website or messaging URLs to crawl.']);

  const step6Logs:string[]=[];const socialCandidates:DiscordCandidate[]=[];
  const repeatSkippedWebsites=repeatSkippedCount;const repeatSkippedRelevantWebsites=repeatSkippedRelevantCount;if(socialBioUrls.length){step6Logs.push(`Crawling ${socialBioUrls.length} social profile URLs; discovery continues after a first invite.`);
  // Resolved R6 flags for the social loop (single source: DB-backed settings;
  // disabled settings actually disable the corresponding static behavior here).
  let socialLoginSemantics = true, socialPartialRetry = true;
  try { socialLoginSemantics = await isLoginBlockSemanticsEnabled(); } catch { socialLoginSemantics = true; }
  try { socialPartialRetry = await isPartialStaticRetryEnabled(); } catch { socialPartialRetry = true; }
  for(const item of socialBioUrls){const socialAdmissionCheck=assessCrawlAdmission(item.url);if(!socialAdmissionCheck.eligible){step6Logs.push(`Admission rejected (${socialAdmissionCheck.reasonCode}): ${item.url}; not crawled.`);continue;}const repeatSkipSoc=repeatSkipLine(item.url);if(repeatSkipSoc){step6Logs.push(repeatSkipSoc);continue;}step6Logs.push(`[Crawling] ${item.url} (Priority Score: ${scoreCommunitySurface(item)}, Source: ${item.source})`);const crawlRes=(await safeCrawlStatic(item.url,debugLog,channelData.externalFetchImpl||fetch,'SOCIAL_PROFILES',item.wrapperUrl,ladderOn,frontierOptsFor(item.url),undefined,evaluateDomainWeights,undefined,{ loginSemantics: socialLoginSemantics, partialStaticRetry: socialPartialRetry },channelData.destinationResolver)).crawlRes;retainCommunityIntent(crawlRes.communityIntent);acquisitionOutcomes.push(...crawlRes.observations);for(const shadow of crawlRes.domainWeightShadows||[])step6Logs.push(`[DomainWeightShadow] site=${shadow.siteIdentity} weights=${shadow.weightsVersion} routes=${shadow.routeCount} baseline=${shadow.baselineTopUrl} shadow=${shadow.shadowPickUrl} agreement=${shadow.agreement}.`);socialCandidates.push(...crawlRes.candidates);const staticMerged=mergeDiscordCandidates(crawlRes.candidates,ownershipInput),hasCreatorOwned=staticMerged.some(c=>c.ownershipStatus==='CREATOR_OWNED');
    // Conclusive static terminal barrier: same no-escalation rule as website
    // seeds — a terminal LOGIN_WALL/PAYWALL_WALL/PERMANENT_ACCESS_BLOCK must
    // stay visible and non-retryable, never replaced by rendered work.
    const socialSsrfBarrier = crawlRes.observations.some(o =>
      String(o.failureClass || '') === 'SSRF_BLOCKED' &&
      normalizeVisitUrl(String(o.requestedUrl || '')) === normalizeVisitUrl(item.url));
    if (socialSsrfBarrier) markSsrfSeedRequired(crawlRes.observations, item.url);
    // Same confirmed-terminal 404/410 rule for optional social profiles.
    const socialNotFoundBarrier = isConfirmedStaticTerminalNotFound({
      surface: 'SOCIAL_PROFILES',
      seedUrl: item.url,
      crawlOutcome: crawlRes.outcome,
      observations: crawlRes.observations,
      candidateCount: crawlRes.candidates.length,
      communityIntentCount: crawlRes.communityIntent?.length || 0,
    });
    if (socialNotFoundBarrier) markConfirmedStaticTerminalNotFound({ seedUrl: item.url, observations: crawlRes.observations });
    const socialTerminalBarrier = socialSsrfBarrier || socialNotFoundBarrier || (socialLoginSemantics && crawlRes.observations.some(o =>
      (o.outcome === 'PARTIALLY_INSPECTED' || o.outcome === 'ACQUISITION_FAILED') &&
      (String(o.failureClass || '') === 'LOGIN_WALL' ||
       String(o.failureClass || '') === 'PAYWALL_WALL' ||
       String(o.failureClass || '') === 'PERMANENT_ACCESS_BLOCK')));
    if (socialSsrfBarrier) {
      step6Logs.push(`[Security barrier] ${item.url} static SSRF destination block is terminal; no rendered escalation.`);
    } else if (socialNotFoundBarrier) {
      const notFoundObservation = crawlRes.observations.find(o =>
        String(o.requestedUrl || '') === item.url &&
        String(o.failureClass || '') === 'HTTP_ERROR' &&
        (Number(o.httpStatus) === 404 || Number(o.httpStatus) === 410));
      step6Logs.push(`[Terminal barrier] ${item.url} confirmed static HTTP ${notFoundObservation?.httpStatus || '404/410'} with no recoverable content; no rendered escalation.`);
    } else if (socialTerminalBarrier) {
      step6Logs.push(`[Terminal barrier] ${item.url} conclusive permanent barrier established statically (${crawlRes.outcome}); no rendered escalation.`);
    }
    if(!socialTerminalBarrier && creatorLikelyTrading&&(crawlRes.outcome!=='FOUND'||!hasCreatorOwned)){const {crawlRenderedCommunitySurface,wasRenderedResultProcessed}=await import('./browserCommunityFallback');const ladderDecision=resolveRenderEscalation({staticOutcome:crawlRes.outcome,creatorLikelyTrading:true,surface:'SOCIAL_PROFILES',hasCreatorOwnedEvidence:crawlRes.outcome==='FOUND'&&hasCreatorOwned});if(ladderOn)step6Logs.push(`[Ladder] render decision for ${item.url}: ${ladderDecision.justification} (${ACQUISITION_LADDER_POLICY_VERSION}).`);const shouldRendered=ladderDecision.escalate;if(shouldRendered){const rendered=await (channelData.renderedFallback||crawlRenderedCommunitySurface)(item.url,{clickOffset:renderedClickOffsetForSeed(item.url),resolveHost:channelData.destinationResolver}).catch((error:any)=>isolatedRenderedFallback(item.url,error)),renderedProcessed=wasRenderedResultProcessed(rendered),renderedCandidates=normalizedRenderedCandidates(rendered,'SOCIAL_PROFILES',item.url);socialCandidates.push(...renderedCandidates);const renderedResult=renderedAcquisitionOutcome(rendered,renderedProcessed,renderedCandidates,requiredGapFromRendered(rendered)),renderedOutcome:ExternalAcquisitionStatus=renderedResult.outcome;acquisitionOutcomes.push({requestedUrl:item.url,finalUrl:rendered.foundLocation,wrapperUrl:item.wrapperUrl,surface:'SOCIAL_PROFILES',required:true,outcome:renderedOutcome,retryable:renderedResult.failureClass==='SSRF_BLOCKED'?false:(renderedResult.gapRetryable!==undefined?renderedResult.gapRetryable:(rendered.retryable||!renderedProcessed)),failureClass:renderedResult.failureClass,detail:rendered.detail,observedAt:now,telemetry:renderedCrawlerTelemetry({inspectedPages:rendered.inspectedPages,clicks:rendered.clicks,complete:rendered.complete,timedOut:rendered.timedOut,telemetry:rendered.telemetry,scrollsUsed:rendered.scrolls||0,dropReasons:rendered.dropReasons,experimentAttribution:ladderRenderAttribution})});}}}if(repeatSkippedCount>repeatSkippedWebsites)step6Logs.push(`Skipped ${repeatSkippedCount-repeatSkippedWebsites} repeatedly-failing social URL(s) under the repeat-failure cap; remaining surfaces inspected normally.`);retainCandidates(socialCandidates);const mergedSocial=mergeDiscordCandidates(socialCandidates,ownershipInput),socialOutcomes=effectiveAcquisitionOutcomes(acquisitionOutcomes.filter(item=>item.surface==='SOCIAL_PROFILES'));if(mergedSocial.length){const inviteCodes=mergedSocial.map(candidate=>candidate.nativeInviteCode!).filter(Boolean);step6Logs.push(`Social acquisition retained ${mergedSocial.length} distinct Discord candidate(s).`);step6Logs.push(`Retained invite code${inviteCodes.length===1?'':'s'}: ${inviteCodes.join(', ')}`);addStep('SOCIAL_BIO','Step 5 — Social Profile Bios','FOUND',step6Logs,mergedSocial[0].nativeInviteCode||null,'SOCIAL_BIO',inviteCodes);}else{const socialSkippedOnly=(repeatSkippedRelevantCount-repeatSkippedRelevantWebsites)>0&&!mergedSocial.length,failedCount=socialOutcomes.filter(item=>item.outcome==='ACQUISITION_FAILED').length,inspectedCount=socialOutcomes.filter(item=>item.outcome==='INSPECTED_NO_MATCH'&&hasProcessedAcquisitionEvidence(item)).length,partialCount=socialOutcomes.filter(item=>item.outcome==='PARTIALLY_INSPECTED').length,unevidencedCount=socialOutcomes.filter(item=>item.outcome==='INSPECTED_NO_MATCH'&&!hasProcessedAcquisitionEvidence(item)).length,failed=failedCount>0,inspected=inspectedCount>0,partial=partialCount>0||unevidencedCount>0;step6Logs.push(failed&&inspected?`${inspectedCount} social profile surface(s) were inspected; ${failedCount} remained unavailable after rendered fallback.`:failed?'Social profile acquisition remained incomplete after rendered fallback; absence is not confirmed.':partialCount>0?'Social profile acquisition was only partially inspected (crawl budget exhausted before full coverage); absence is not confirmed.':unevidencedCount>0?'Social profile acquisition produced no inspection evidence (zero pages/requests processed); absence is not confirmed.':'No Discord invite found in inspected social profile bios.');addStep('SOCIAL_BIO','Step 5 — Social Profile Bios',failed?(inspected||partial?'PARTIAL':'ERROR'):partial||socialSkippedOnly?'PARTIAL':'NOT_FOUND',step6Logs);}}else addStep('SOCIAL_BIO','Step 5 — Social Profile Bios','SKIPPED',['No social profile URLs to crawl.']);

  if(debugLog&&!debugLog.failureStep)debugLog.failureStep='ALL_EXHAUSTED';const mergedCandidates=mergeDiscordCandidates(discoveredCandidates,ownershipInput);const required=effectiveAcquisitionOutcomes(acquisitionOutcomes.filter(item=>item.required)),communityRequired=required.filter(item=>isDiscordCommunityAcquisitionSurface(item.surface)&&isMeaningfulWebsiteObservation(item as {rootUrl?:string;requestedUrl:string})&&isCommunityRelevantObservation(item as {rootUrl?:string;requestedUrl:string})),failed=communityRequired.some(item=>item.outcome==='ACQUISITION_FAILED'),inspected=communityRequired.some(item=>item.outcome==='INSPECTED_NO_MATCH'&&hasProcessedAcquisitionEvidence(item)),partialCoverage=effectiveAcquisitionOutcomes(acquisitionOutcomes.filter(item=>isDiscordCommunityAcquisitionSurface(item.surface)&&isMeaningfulWebsiteObservation(item as {rootUrl?:string;requestedUrl:string})&&isCommunityRelevantObservation(item as {rootUrl?:string;requestedUrl:string}))).some(item=>item.outcome==='PARTIALLY_INSPECTED'||(item.outcome==='INSPECTED_NO_MATCH'&&!hasProcessedAcquisitionEvidence(item))),
  // Garbage inputs are fully invisible to outcome accounting: only genuine
  // (meaningful-root) observations decide failed/inspected/partial above, so
  // a malformed-only input set with all-genuine-clean surfaces resolves to
  // the definitive negative instead of manufacturing UNCERTAIN work. The
  // dotless note remains in the step logs for audit; no retry is ever owned
  // (communityRequired is empty, so no directive is built).
  acquisitionStatus:ExternalAcquisitionStatus=failed&&inspected||partialCoverage?'PARTIALLY_INSPECTED':failed?'ACQUISITION_FAILED':repeatSkippedRelevantCount>0?'PARTIALLY_INSPECTED':'INSPECTED_NO_MATCH';
  // Consecutive-tail retry suppression: seeds whose loaded failure history
  // already holds an exhausted identical budget/timeout tail stop owning new
  // retries (deterministic re-execution has 0% observed recovery), while their
  // PARTIAL/FAILED outcomes still drive acquisition status normally. Covers
  // rendered wall-clock timeouts, rendered required-unvisited budget gaps,
  // and FOUND rows carrying either gap class (multi-invite recall keeps the
  // invites while the gap stops re-owning work).
  const consecutiveTimeoutSuppressed=new Set<string>();
  const timeoutTailClasses=['RENDERED_TIMEOUT','REQUIRED_UNVISITED_BUDGET_GAP'];
  for(const item of communityRequired){const reqUrl=(item as {requestedUrl?:unknown}).requestedUrl;if(typeof reqUrl!=='string'||!reqUrl)continue;const oc=(item as {outcome?:unknown}).outcome;const fc=String((item as {failureClass?:unknown}).failureClass||'');const timeoutRow=(oc==='ACQUISITION_FAILED'||oc==='PARTIALLY_INSPECTED')&&(fc==='RENDERED_TIMEOUT'||fc==='REQUIRED_UNVISITED_BUDGET_GAP');const foundGapRow=oc==='FOUND'&&(fc==='REQUIRED_UNVISITED_BUDGET_GAP'||fc==='RENDERED_TIMEOUT'||fc==='RENDERED_PARTIAL_COVERAGE');if((timeoutRow||foundGapRow)&&hasConsecutiveTimeoutExhaustion(loadedFailureHistory,reqUrl,2,timeoutTailClasses))consecutiveTimeoutSuppressed.add(normalizeSkipUrl(reqUrl));}
  if(consecutiveTimeoutSuppressed.size){const customStep=steps.find(s=>s.step==='CUSTOM_DOMAINS');if(customStep)customStep.details+=`\nRetry suppressed (consecutive identical budget/timeout tail): ${[...consecutiveTimeoutSuppressed].join(', ')}`;}
  // Eligible static budget gaps join the retry directive input despite
  // required=false (their predicate exception owns bounded retry); DEMOTE /
  // BLOCK / auxiliary gaps stay excluded via the predicate itself, and URLs
  // already covered by communityRequired are deduped. Status accounting above
  // is unchanged.
  const coveredRetryUrls=new Set(communityRequired.map(o=>(o as {requestedUrl?:unknown}).requestedUrl));
  const staticGapExtras=acquisitionOutcomes.filter(o=>!o.required&&(o as {failureClass?:unknown}).failureClass===STATIC_BUDGET_GAP_FAILURE_CLASS&&(o as {retryable?:unknown}).retryable===true&&isCommunityRetryableObservation(o as never)&&!coveredRetryUrls.has((o as {requestedUrl?:unknown}).requestedUrl));
  return {foundInvite:mergedCandidates[0]?.nativeInviteCode||null,foundLocation:mergedCandidates[0]?.sourceUrl?.match(/VIDEO_\d+_DESCRIPTION/)?.[0]||mergedCandidates[0]?.sourceSurface,steps,extractedThumbnailUrl,debugLog,observedAboutBio:bio,observedChannelLinks:links,observedVideoDescriptions:channelSampledDescs().slice(0,10),observedVideoDescriptionsAuthoritative:channelSampled.length>0,acquisitionStatus:mergedCandidates.length?'FOUND':acquisitionStatus,acquisitionOutcomes,retryDirective:communityAcquisitionRetryDirective([...communityRequired,...staticGapExtras],consecutiveTimeoutSuppressed),retrySuppressedUrls:[...consecutiveTimeoutSuppressed],discordCandidates:mergedCandidates,communityIntent:communityIntentEvidence.length?communityIntentEvidence:undefined,nextClickOffsets:nextRenderedClickOffsets(channelData.clickOffsets,acquisitionOutcomes)};
}
