import { randomUUID } from 'node:crypto';
import { ChannelActivityBand, CountryMetadataStatus, CountryVocabulary, QuotaOrigin } from '../src/types';
import {
  assertOfficialYouTubeAllowed,
  isOfficialYouTubeQuotaAllowed,
  isOfficialYouTubeQuotaFenceError,
} from './officialYouTubeQuotaFence';
import { incrementQuota, getAppSetting, getDb, getYouTubeKeyPool, appendProviderCallEvent, recordYouTubeInvalidInput, isYouTubeInputQuarantined, recordYouTubeProviderSuspension } from './db';
import { fingerprintYouTubeKey } from './youtubeQuotaAttribution';
import {
  assertKeyCapReservationDayCurrent,
  isYouTubeKeyCapError,
  recordShadowDispatchSafe,
  reserveEnforcedKeyCap,
  resolveKeyCapEnforcement,
  settleKeyCapReservation,
  SHADOW_OBSERVATION_BUDGET_MS,
  type KeyCapReservationContext,
} from './quotaKeyCapShadow';
import { getConfiguredYouTubeProviders, getYouTubeQuotaGroupForKey } from './youtubeKeyPool';
import {
  YOUTUBE_INPUT_QUARANTINE_TTL_MS,
  YOUTUBE_SUSPENSION_RETRY_AFTER_MS,
  advanceYouTubeRotation,
  annotateYouTubeErrorMetadata,
  buildYouTubeTelemetryMetadata,
  clearYouTubeSuspensionIfCurrent,
  extractYouTubeQuarantineInput,
  isYouTubeInputFailure,
  isYouTubePageTokenFailure,
  isYouTubeQuotaAccountingError,
  normalizeYouTubeQuarantineInput,
  retryYouTubeQuotaAccounting,
  ensureYouTubeSuspensionHydration,
  serializeYouTubeSuspensionWrite,
  shouldClearYouTubeSuspension,
  youtubeDeploymentId,
  type YouTubeQuarantineInputKind,
  YouTubeQuotaAccountingError,
} from './youtubeKeyHealth';
import { executeProviderCall, ProviderCallError } from './providerResilience';
import { RetrievalLane } from './retrievalLanes';
import { SearchOrdering, youtubeOrder } from './searchOrdering';
import { countrySearchHints, normalizeLanguageCode } from './countrySearchHints';
import { isQuotaExceeded, youtubePoolBackoff, type YouTubePoolAcquisition } from './youtubePoolBackoff';
import { recordExecutionStage, recordFirstYouTubeRequest } from './executionTrace';
import { youtubeRequestScheduler, type YouTubeRequestPriority } from './youtubeRequestScheduler';
import { youtubeProviderCooldown, YouTubeProvidersCoolingDownError } from './youtubeProviderCooldown';
import { bumpInvalidApiKeyQuarantine } from './operationsTelemetry';
import { FEATURED_CHANNEL_PROVIDER_COST, parseFeaturedChannelSections, type FeaturedChannelProviderResult } from './featuredChannelAdapter';
export type { SearchOrdering } from './searchOrdering';
export type { RetrievalLane } from './retrievalLanes';

export interface YouTubeProviderLifecycle {
  requestId?: string;
  runId?: string;
  jobId?: string;
  preferredLanguage?: string;
}

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

export interface RelationshipProvenance {
  /** Explicitly designated canary cohort this candidate was discovered under. */
  cohortId: string;
  /** Relationship kind traversed to reach this candidate. */
  kind: 'featured' | 'playlist';
  /** Traversal depth from the cohort seed: 1 for direct relations, 2 maximum. */
  depth: number;
  /** Channel the relationship was traversed from (seed at depth 1). */
  parentChannelId?: string;
  /** Full traversal path from the seed, e.g. [seed, intermediate]. */
  path: string[];
}

export interface DiscoveredChannelRaw {
  channelId: string;
  channelName: string;
  youtubeUrl: string;
  description: string;
  videoTitles: string[];
  /** Sticky provenance used by the official YouTube quota fence. */
  quotaOrigin?: QuotaOrigin;
  locationTag?: string;
  channelLinks?: string[];
  pinnedComment?: string;
  videoDescriptions?: string[];
  /**
   * Provenance gate for the aggregated-content-language country voter. True
   * ONLY when videoDescriptions are an authoritative recent-channel sample
   * (channel enrichment recent-uploads fetch). Search-selected snippets,
   * playlist-adapter observations, and any other discovery-selected subsets
   * are non-authoritative and can never vote for a country rejection.
   */
  videoDescriptionsAuthoritative?: boolean;
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
  /**
   * Provenance marker for provider-declared language (uploader metadata from
   * YouTube enrichment/metadata hydration — never content-analyzed language).
   * The trading classifier strips marked hints; terminology selection keeps
   * them. Transcription-derived or otherwise analyzed hints must NOT set it.
   */
  providerDeclaredLanguage?: boolean;
  externalLinkDetails?: Array<{label?:string;url:string;domain?:string;resolved_entity_type?:string;source_family_id?:string;source_entity_id?:string}>;
  visualEvidence?: Array<{source_ref:string;description:string;model_provenance:string}>;
  enrichmentStage?: number;
  investigationId?: string;
  /** The retrieval document nominated this channel; it is not channel About metadata. */
  matchedDocument?: {type:'VIDEO'|'CHANNEL'|'PLAYLIST'|'EXTERNAL'|'MANUAL'|'UNKNOWN';providerNativeId?:string;title?:string;description?:string;publishedAt?:string;locator?:string};
  /**
   * Relationship-canary provenance. Present only for candidates discovered by
   * traversing creator relationships (featured sections, playlists) inside an
   * explicitly designated canary cohort — never for keyword search results.
   * It routes admission (hypothesis only, never proof) and cohort metrics; it
   * is not creator-level evidence and must never enter country attribution.
   */
  relationshipProvenance?: RelationshipProvenance;
  nominationId?: string;
  queryRunId?: string;
  discoveryJobId?: string;
}
export interface PlaylistChannelObservation {channelId:string;channelName:string;description:string;videoTitles:string[];observedAt:string}

/** One bounded channelSections.list request; only explicit multipleChannels IDs survive parsing. */
export async function fetchYouTubeFeaturedChannels(sourceChannelId: string, maximumFanout: number): Promise<FeaturedChannelProviderResult> {
  assertOfficialYouTubeAllowed('fetchYouTubeFeaturedChannels');
  if (!/^UC[A-Za-z0-9_-]{22}$/.test(sourceChannelId) || !Number.isInteger(maximumFanout) || maximumFanout < 1 || maximumFanout > 10) throw new Error('INVALID_FEATURED_CHANNEL_PROVIDER_INPUT');
  const keys = getYouTubeKeyPool(); if (!keys.length) throw new Error('YouTube featured-channel inspection requires an API key.');
  const acquisition = youtubePoolBackoff.beginAcquisition();
  let quotaExceededCount = 0;
  try {
    const providerIndexes = availableKeyIndexes(keys);
    for (let attempt = 0; attempt < providerIndexes.length; attempt++) {
      const index = providerIndexes[attempt];
      const apiKey = keys[index];
      let responseAccounted = false;
      try {
        const url = buildYouTubeApiUrl('channelSections', apiKey, { part: 'snippet,contentDetails', channelId: sourceChannelId, maxResults: Math.min(50, maximumFanout) });
        const response = await youtubeFetch(url, 'featured-channel-sections', FEATURED_CHANNEL_PROVIDER_COST, attempt + 1, acquisition, 'enrichment', apiKey);
        await accountYouTubeQuotaResponse(response, FEATURED_CHANNEL_PROVIDER_COST);
        responseAccounted = true;
        return parseFeaturedChannelSections({ sourceChannelId, maximumFanout, response: await readYouTubeJsonObject(response, 'featured-channel-sections'), observedAt: new Date().toISOString() });
      } catch (error) {
        // A successful provider response that cannot be accounted must not be
        // retried on another key: the first call may already have spent units.
        // The same applies to a response that was accounted and then failed
        // body validation/parsing: refetching would charge a second request
        // against one job reservation.
        if (responseAccounted || isYouTubeQuotaAccountingError(error)) throw error;
        recordProviderFailure(apiKey, error);
        if (isQuotaExceeded(error)) quotaExceededCount++;
        if (attempt === providerIndexes.length - 1) {
          acquisition.providerFailed(quotaExceededCount === providerIndexes.length ? 'QUOTA_EXHAUSTED' : 'INDETERMINATE');
          throwIfAllProvidersCoolingDown(keys);
          throw error;
        }
      }
    }
    throw new Error('All configured YouTube API keys failed for featured-channel inspection.');
  } finally { acquisition.release(); }
}

/** One bounded playlistItems call (cost: one unit); no pagination is followed by the canary. */
export async function fetchYouTubePlaylistChannels(playlistId:string,limit:number):Promise<PlaylistChannelObservation[]> {
  assertOfficialYouTubeAllowed('fetchYouTubePlaylistChannels');
  const keys=getYouTubeKeyPool();if(!keys.length)throw new Error('YouTube playlist inspection requires an API key.');
  const acquisition=youtubePoolBackoff.beginAcquisition(); let quotaExceededCount=0;
  const maxResults=Math.min(50,Math.max(1,Math.trunc(limit)));const observedAt=new Date().toISOString();
  try {
    const providerIndexes=availableKeyIndexes(keys);
    for(let attempt=0;attempt<providerIndexes.length;attempt++){const index=providerIndexes[attempt];let responseAccounted=false;
      try{const url=buildYouTubeApiUrl('playlistItems',keys[index],{part:'snippet',playlistId,maxResults});const response=await youtubeFetch(url,'playlist-items',1,attempt+1,acquisition,'enrichment',keys[index]);await accountYouTubeQuotaResponse(response, 1);responseAccounted=true;const data=await readYouTubeJsonObject(response, 'playlist-items');
        return (data.items||[]).map((item:any)=>({channelId:String(item.snippet?.videoOwnerChannelId||''),channelName:String(item.snippet?.videoOwnerChannelTitle||''),description:String(item.snippet?.description||''),videoTitles:[String(item.snippet?.title||'')],observedAt})).filter((x:PlaylistChannelObservation)=>x.channelId&&x.channelName);
      }catch(error){if(responseAccounted||isYouTubeQuotaAccountingError(error))throw error;recordProviderFailure(keys[index],error);if(isQuotaExceeded(error))quotaExceededCount++;if(attempt===providerIndexes.length-1){acquisition.providerFailed(quotaExceededCount===providerIndexes.length?'QUOTA_EXHAUSTED':'INDETERMINATE');throwIfAllProvidersCoolingDown(keys);throw error;}}
    }throw new Error('All configured YouTube API keys failed for playlist inspection.');
  } finally { acquisition.release(); }
}

/**
 * Retrieves all valid YouTube API keys available in environment variables.
 * Checks the configuration-driven YouTube key environment-variable pool.
 */
let activeKeyIndex = 0;
let outboundTraceSequence = 0;
const failedDispatchProvidersByAcquisition = new WeakMap<object, Set<string>>();
const youtubeResponseProviderContext = new WeakMap<Response, { providerKey?: string; acquisition?: YouTubePoolAcquisition; providerFailureGeneration?: number; keyCapReservation?: KeyCapReservationContext }>();

function failedDispatchProviders(acquisition?: YouTubePoolAcquisition): Set<string> | undefined {
  if (!acquisition || (typeof acquisition !== 'object' && typeof acquisition !== 'function')) return undefined;
  const key = acquisition as unknown as object;
  let failed = failedDispatchProvidersByAcquisition.get(key);
  if (!failed) { failed = new Set<string>(); failedDispatchProvidersByAcquisition.set(key, failed); }
  return failed;
}

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

/** Thrown before dispatch when an input is durably quarantined after repeated
 * HTTP 400/404/422 responses. Deliberately carries no status, providerReasons,
 * or quota flags so no failure classifier (suspension, rate-limit, dead-key,
 * quota) can mistake a bad input for a bad key. */
export class YouTubeQuarantinedInputError extends Error {
  readonly code = 'YOUTUBE_INPUT_QUARANTINED';
  constructor(
    readonly inputKind: YouTubeQuarantineInputKind,
    readonly inputValue: string,
    readonly operation: string,
  ) {
    super(`YouTube ${operation} withheld: ${inputKind} is quarantined after repeated invalid-input responses.`);
    this.name = 'YouTubeQuarantinedInputError';
  }
}

export function isYouTubeQuarantinedInput(error: unknown): boolean {
  return error instanceof YouTubeQuarantinedInputError
    || (error as { code?: unknown } | null)?.code === 'YOUTUBE_INPUT_QUARANTINED';
}

/** Pre-dispatch gate: throws when this call's input is quarantined, before
 * any key is touched. Callers invoke this once, outside their key-failover
 * loops, so a bad input aborts instead of burning through every key. */
export async function throwIfYouTubeInputQuarantined(
  operation: string,
  input: { channelId?: string | null; query?: string | null },
): Promise<void> {
  const raw = input.channelId || input.query || null;
  const kind: YouTubeQuarantineInputKind = input.channelId ? 'channelId' : 'searchQuery';
  const value = normalizeYouTubeQuarantineInput(kind, raw);
  if (!value) return;
  if (await isYouTubeInputQuarantined(kind, value)) {
    throw new YouTubeQuarantinedInputError(kind, value, operation);
  }
}

/** Persists a suspended/dead key durably (best effort: never breaks the
 * failure path). Resolved against the current pool so the stored key_index
 * and quota group stay interpretable. */
async function persistYouTubeKeySuspension(providerKey: string, reason: string): Promise<void> {
  try {
    const pool = getYouTubeKeyPool();
    const index = pool.indexOf(providerKey);
    const configured = getConfiguredYouTubeProviders().find(item => item.key === providerKey);
    // Serialized with gated clears (arrival order): a re-suspension issued
    // after an in-flight clear executes after it, so the fresh row survives.
    await serializeYouTubeSuspensionWrite(() => recordYouTubeProviderSuspension({
      keyFingerprint: fingerprintYouTubeKey(providerKey),
      keyIndex: index >= 0 ? index + 1 : 0,
      envName: configured?.envName || '',
      quotaGroup: configured?.quotaGroup || getYouTubeQuotaGroupForKey(providerKey) || '',
      status: reason === 'INVALID_API_KEY' ? 'INVALID_KEY' : 'SUSPENDED',
      retryAfterMs: YOUTUBE_SUSPENSION_RETRY_AFTER_MS,
      reason,
    }));
  } catch {
    // Durable suspension is telemetry-grade hardening; a write failure must
    // never mask the original provider error.
  }
}

export function recordProviderFailure(key: string, error: unknown): void {
  // A policy fence is not a provider failure. Never cool a key, persist a
  // suspension, or attribute the probe's zero-quota policy to the provider.
  if (isOfficialYouTubeQuotaFenceError(error)) return;
  const dispatchedKey = typeof (error as any)?.providerKey === 'string' ? (error as any).providerKey : key;
  // A rate-limited key is retired for this acquisition, while the bounded
  // outer provider loop may continue with another eligible key. If the whole
  // pool is unavailable, the caller surfaces the governed all-provider cooldown.
  if (isConsumerSuspended(error)) {
    if ((error as any)?.providerFailureRecorded !== true) {
      youtubeProviderCooldown.failed(dispatchedKey, 'CONSUMER_SUSPENDED');
      persistYouTubeKeySuspension(dispatchedKey, 'CONSUMER_SUSPENDED').catch(() => undefined);
    }
    return;
  }
  if (isYouTubeRateLimited(error)) {
    if ((error as any)?.providerFailureRecorded !== true) youtubeProviderCooldown.failed(dispatchedKey, 'RATE_LIMITED');
    return;
  }
  // Dead-key quarantine for callers that record failures outside youtubeFetch.
  // Shares the suspended-key quarantine: the key is unusable until the window
  // lapses, then gets a single probe attempt on next use.
  if (isInvalidApiKey(error)) {
    if ((error as any)?.providerFailureRecorded !== true) {
      youtubeProviderCooldown.failed(dispatchedKey, 'CONSUMER_SUSPENDED');
      bumpInvalidApiKeyQuarantine();
      persistYouTubeKeySuspension(dispatchedKey, 'INVALID_API_KEY').catch(() => undefined);
    }
    return;
  }
  if ((error as any)?.providerFailureRecorded === true) return;
  if (isQuotaExceeded(error)) youtubeProviderCooldown.failed(dispatchedKey, 'DAILY_QUOTA_EXHAUSTED');
}

export function selectYouTubeDispatchProviderIndex(
  providerKeys: string[],
  selectedProviderKey: string | undefined,
  isEligible: (key: string) => boolean = key => youtubeProviderCooldown.eligible(key)
): number {
  if (!providerKeys.length) return -1;
  const selectedIndex = selectedProviderKey ? providerKeys.indexOf(selectedProviderKey) : -1;
  if (selectedIndex >= 0 && isEligible(providerKeys[selectedIndex])) return selectedIndex;
  for (let offset = 0; offset < providerKeys.length; offset++) {
    const index = (activeKeyIndex + offset) % providerKeys.length;
    if (isEligible(providerKeys[index])) return index;
  }
  return -1;
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

export function buildYouTubeProviderRequestId(logicalRequestId: string | undefined, dispatchAttempt: number): string | undefined {
  if (!logicalRequestId) return undefined;
  if (!Number.isSafeInteger(dispatchAttempt) || dispatchAttempt < 1) throw new Error('INVALID_PROVIDER_DISPATCH_ATTEMPT');
  return `${logicalRequestId}:provider-attempt:${dispatchAttempt}`;
}

const youtubeResponseShadowOperations = new WeakMap<Response, string>();

function getYouTubeResponseShadowOperationId(response: Response): string | undefined {
  return youtubeResponseShadowOperations.get(response);
}

/**
 * Joins the optional shadow observation for at most one observation budget,
 * then aborts it. Completed responses never wait on a stalled shadow database;
 * the settlement tombstone prevents an aborted observation from later
 * recreating a lease or a false cap event.
 */
async function joinShadowObservation(
  observation: Promise<unknown>,
  controller: AbortController,
  budgetMs: number = SHADOW_OBSERVATION_BUDGET_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      observation,
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, Math.max(1, budgetMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}

function preDispatchAbortError(signal:AbortSignal):Error{
  const error=Object.assign(new Error('YouTube provider call was cancelled before dispatch.'),{name:'AbortError'});
  if(signal.reason!==undefined)(error as Error & {cause?:unknown}).cause=signal.reason;
  return error;
}

async function youtubeFetch(url:string,operation:string,actualCost:number,attempt=1,acquisition?:YouTubePoolAcquisition,priority:YouTubeRequestPriority='enrichment',providerKey?:string,lifecycle?:YouTubeProviderLifecycle):Promise<Response>{
  // Single choke point for every official YouTube Data API request. Probe
  // work must never reach this line; a missing/unknown origin fails closed.
  assertOfficialYouTubeAllowed(`youtubeFetch:${operation}`);
  const traceId = `${operation}-${attempt}-${++outboundTraceSequence}`;
  let providerDispatchAttempt = 0;
  const trace = (stage: string) => console.log(`[YouTube Outbound Trace] ${traceId} ${stage}`);
  // Gate dispatch on durable-suspension hydration: workers start before DB
  // readiness, so without this wait a restart could reprobe an already-dead
  // key before its cooldown is restored. Resolves immediately once hydrated.
  await ensureYouTubeSuspensionHydration();
  trace('entered youtubeFetch; before timeout-setting-read at server/youtube.ts:119');
  const configuredTimeout=Number(await getAppSetting('youtube_provider_timeout_ms',process.env.YOUTUBE_PROVIDER_TIMEOUT_MS||'30000'));
  trace('after timeout-setting-read at server/youtube.ts:119');
  const timeout=Number.isFinite(configuredTimeout)&&configuredTimeout>0?configuredTimeout:30_000;
  let dispatchedProviderKey=providerKey;
  let shadowObservation:Promise<void>|undefined;
  let shadowOperationId:string|undefined;
  let shadowAbort:AbortController|undefined;
  trace('before scheduler-run at server/youtube.ts:126');
  try {
    const response=await youtubeRequestScheduler.run(()=>{
      const dispatchAttempt = ++providerDispatchAttempt;
      let dispatchedUrl=url;
      if(providerKey){
        const livePool=getYouTubeKeyPool();
        if(!livePool.length)throw new Error('YouTube provider pool became unavailable before request dispatch.');
        const failedProviders=failedDispatchProviders(acquisition);
        let dispatchIndex=selectYouTubeDispatchProviderIndex(livePool,providerKey,key=>youtubeProviderCooldown.eligible(key)&&!failedProviders?.has(key));
        if(dispatchIndex<0) dispatchIndex=selectYouTubeDispatchProviderIndex(livePool,providerKey);
        if(dispatchIndex<0){
          throwIfAllProvidersCoolingDown(livePool);
          throw new Error('No eligible YouTube provider is available at request dispatch.');
        }
        dispatchedProviderKey=livePool[dispatchIndex];
        if(dispatchedProviderKey!==providerKey){
          const rebuiltUrl=new URL(url);
          rebuiltUrl.searchParams.set('key',dispatchedProviderKey);
          dispatchedUrl=rebuiltUrl.toString();
          trace(`reselected provider at dispatch (key #${dispatchIndex+1})`);
        }
      }
      const providerRequestId = buildYouTubeProviderRequestId(lifecycle?.requestId, dispatchAttempt);
      const dispatchedRequest = new URL(dispatchedUrl);
      // Per-call attribution for provider_call_events.request_metadata: the
      // dispatched (not merely preferred) key fingerprint/index/quota group
      // plus the replica identity, so failures can later be correlated with
      // specific keys, projects, and deployments. The fingerprint is the
      // existing non-reversible quota-table hash, never the key itself.
      const livePoolForTelemetry = dispatchedProviderKey ? getYouTubeKeyPool() : [];
      const requestMetadata: Record<string, string | null> = {
        regionCode: dispatchedRequest.searchParams.get('regionCode'),
        relevanceLanguage: dispatchedRequest.searchParams.get('relevanceLanguage'),
        ...buildYouTubeTelemetryMetadata({
          providerKey: dispatchedProviderKey,
          poolKeys: livePoolForTelemetry,
          quotaGroup: dispatchedProviderKey ? (getYouTubeQuotaGroupForKey(dispatchedProviderKey) || null) : null,
          deploymentId: youtubeDeploymentId(),
        }),
      };
      return executeProviderCall({context:{provider:'youtube',operation,requestId:providerRequestId,runId:lifecycle?.runId,jobId:lifecycle?.jobId,requestMetadata,attempt:dispatchAttempt,reservedCost:actualCost,actualCost},timeoutMs:timeout,enabled:true,emit:appendProviderCallEvent,trace,call:async signal=>{
        trace('before first-request-record at server/youtube.ts:128');
        await recordFirstYouTubeRequest(operation);
        trace('after first-request-record at server/youtube.ts:128');
        trace('before HTTP fetch at server/youtube.ts:131');
        // Capture the failure generation BEFORE dispatch: if the key is
        // suspended by a newer in-flight request while this one is on the
        // wire, this response must compare stale (not current) when the
        // reader validates it below.
        const dispatchFailureGeneration=dispatchedProviderKey?youtubeProviderCooldown.failureGeneration(dispatchedProviderKey):undefined;
        // Hard cap ON: reserve before the official HTTP request. Settings,
        // database, lock and capacity failures are fatal here (fail closed).
        // Enforcement OFF keeps the observational shadow path below unchanged.
        let capReservation: KeyCapReservationContext | null = null;
        if(dispatchedProviderKey){
          try {
            if(await resolveKeyCapEnforcement(getAppSetting)){
              const capNow=new Date();
              capReservation=await reserveEnforcedKeyCap(
                {readSetting:getAppSetting,pool:await getDb()},
                {keyFingerprint:fingerprintYouTubeKey(dispatchedProviderKey),operationId:`cap:${operation}:${randomUUID()}`,units:actualCost,now:capNow}
              );
            }
          } catch(error) {
            failedDispatchProviders(acquisition)?.add(dispatchedProviderKey);
            throw error;
          }
        }
        if(capReservation){
          // The reservation transaction may have waited across Pacific
          // midnight. Do not send a new-day request against yesterday's
          // capacity; fail closed and let the caller retry. Release the exact
          // lease first so a refused dispatch cannot hold capacity until reset.
          try{assertKeyCapReservationDayCurrent(capReservation, new Date());}
          catch(error){
            try{const pool=await getDb();await settleKeyCapReservation(pool,capReservation);}catch{/* expiry remains the backstop */}
            throw error;
          }
        }
        if(signal.aborted){
          // Reservation work can outlive the provider deadline. fetch() would
          // abort without dispatching, so release the exact lease instead of
          // leaving admitted capacity stranded until the Pacific reset.
          if(capReservation){
            try{const pool=await getDb();await settleKeyCapReservation(pool,capReservation);}catch{/* expiry remains the backstop */}
          }
          throw preDispatchAbortError(signal);
        }
        if(dispatchedProviderKey && !capReservation){
          // Shadow-only cap observation (never blocks or alters dispatch):          // record an in-flight lease plus any projected WOULD_DEFER/
          // WOULD_REJECT for the 9,000-unit/day per-key cap. Disabled by
          // default; every failure is swallowed inside the helper.
          //
          // Start the observation without awaiting it: the provider deadline
          // starts before this callback runs, and the shadow path can wait on
          // the setting read, pool acquisition, sweep, and advisory lock.
          // The caller joins it for at most SHADOW_OBSERVATION_BUDGET_MS
          // after the provider call, then aborts it. The operation id is
          // carried to quota settlement, which writes a zero-unit tombstone;
          // a cancelled/late observation therefore cannot recreate a lease
          // or record a false cap event. Observation is optional; the real
          // request is not.
          shadowOperationId=`shadow:${operation}:${randomUUID()}`;
          shadowAbort=new AbortController();
          const observationController=shadowAbort;
          const observationOperationId=shadowOperationId;
          shadowObservation=(async()=>{
            try{
              const pool=await getDb();
              await recordShadowDispatchSafe(
                {readSetting:getAppSetting,pool},
                {keyFingerprint:fingerprintYouTubeKey(dispatchedProviderKey),operationId:observationOperationId,units:actualCost,signal:observationController.signal}
              );
            }catch{/* shadow accounting is observational only */}
          })();
        }
        let response: Response;
        try {
          response=await fetch(dispatchedUrl,{signal});
        } catch (error) {
          if(dispatchedProviderKey){
            failedDispatchProviders(acquisition)?.add(dispatchedProviderKey);
            if(error&&typeof error==='object')Object.assign(error,{providerKey:dispatchedProviderKey});
          }
          throw error;
        }
        trace(`after HTTP fetch at server/youtube.ts:131 (status=${response.status})`);
        if(!response.ok){
          trace('before HTTP-error-body-read at server/youtube.ts:135');
          const error=await youtubeHttpError(response,trace);
          trace('after HTTP-error-body-read at server/youtube.ts:135');
          if(dispatchedProviderKey){
            const consumerSuspended=isConsumerSuspended(error);
            const runtimeRateLimited=isYouTubeRateLimited(error);
            // A quota reservation was already written for this dispatch. Do
            // not let the scheduler re-run the whole dispatch closure up to
            // 30 times on raw 429s: each retry would reserve another full
            // request cost while the failed leases remain conservative until
            // reset. Surface it once and let the caller's bounded key
            // failover decide whether another provider is worth trying.
            if(runtimeRateLimited&&capReservation&&error&&typeof error==='object'){
              Object.assign(error,{youtubeQuotaReservationRetryBounded:true});
            }
            if(!runtimeRateLimited)failedDispatchProviders(acquisition)?.add(dispatchedProviderKey);
            if(consumerSuspended)youtubeProviderCooldown.failed(dispatchedProviderKey,'CONSUMER_SUSPENDED');
            // A dead API key is unusable like a suspended one: quarantine it for
            // the same duration so in-loop rotation reaches a healthy key instead
            // of failing every acquisition against the poisoned key.
            else if(isInvalidApiKey(error)){youtubeProviderCooldown.failed(dispatchedProviderKey,'CONSUMER_SUSPENDED');bumpInvalidApiKeyQuarantine();}
            else if(isQuotaExceeded(error))youtubeProviderCooldown.failed(dispatchedProviderKey,'DAILY_QUOTA_EXHAUSTED');
            else if(runtimeRateLimited)youtubeProviderCooldown.failed(dispatchedProviderKey,'RATE_LIMITED');
            if(error&&typeof error==='object')Object.assign(error,{providerKey:dispatchedProviderKey,providerFailureRecorded:true});
            // Failure attribution and durable hardening (best effort, never
            // masks the original error): stamp the HTTP status/API reasons
            // into the emitted event, remember bad inputs instead of
            // retrying them on every rescan, and persist dead keys so a
            // restart cannot reprobe them.
            annotateYouTubeErrorMetadata(requestMetadata, error);
            if(consumerSuspended) await persistYouTubeKeySuspension(dispatchedProviderKey,'CONSUMER_SUSPENDED').catch(()=>undefined);
            else if(isInvalidApiKey(error)) await persistYouTubeKeySuspension(dispatchedProviderKey,'INVALID_API_KEY').catch(()=>undefined);
            else if(isYouTubeInputFailure(error) && !isYouTubePageTokenFailure(error)){
              const input=extractYouTubeQuarantineInput(operation,dispatchedUrl);
              if(input) await recordYouTubeInvalidInput(input.kind,input.value,operation,YOUTUBE_INPUT_QUARANTINE_TTL_MS).catch(()=>undefined);
            }
          }
          throw error;
        }
        youtubeResponseProviderContext.set(response,{providerKey:dispatchedProviderKey,acquisition,providerFailureGeneration:dispatchFailureGeneration,keyCapReservation:capReservation ?? undefined});
        return response;
      }});
    }, trace, priority);
    if(shadowObservation&&shadowAbort&&shadowOperationId){
      // The provider call (and its deadline) is complete and the scheduler
      // slot is already released. The caller receives the operation id so its
      // quota settlement can fence this exact lease. The observation is given
      // one small budget; if it is still stuck in the shadow database, abort
      // and release the response. Settlement's tombstone makes a later insert
      // harmless.
      youtubeResponseShadowOperations.set(response, shadowOperationId);
      await joinShadowObservation(shadowObservation, shadowAbort);
    }
    return response;
  } catch(error) {
    shadowAbort?.abort();
    // executeProviderCall normalizes unknown failures into ProviderCallError.
    // Cap admission failures are control-flow signals, not provider failures:
    // unwrap them so callers can see YOUTUBE_KEY_CAP_EXCEEDED/UNAVAILABLE and
    // never mark the key suspended.
    const capError = isYouTubeKeyCapError(error)
      ? error
      : isYouTubeKeyCapError((error as any)?.cause)
        ? (error as any).cause
        : null;
    if(capError&&typeof capError==='object'){
      if(dispatchedProviderKey)(capError as any).providerKey=dispatchedProviderKey;
      throw capError;
    }
    if(dispatchedProviderKey&&error&&typeof error==='object'){
      const wrappedCause=(error as any).cause;
      const providerFailureRecorded=(error as any).providerFailureRecorded===true||(wrappedCause&&typeof wrappedCause==='object'&&(wrappedCause as any).providerFailureRecorded===true);
      Object.assign(error,{providerKey:dispatchedProviderKey,...(providerFailureRecorded?{providerFailureRecorded:true}:{})});
    }
    throw error;
  }
}

export type YouTubeAdditionalQuotaCallback = (additionalUnits: number) => Promise<void>;

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
export function getYouTubeResponseProviderKey(response: Response): string {
  const providerKey = youtubeResponseProviderContext.get(response)?.providerKey;
  if (!providerKey) throw new Error('YOUTUBE_PROVIDER_KEY_CONTEXT_MISSING');
  return providerKey;
}

export async function readYouTubeJsonObject<T extends Record<string, any> = Record<string, any>>(response: Response, operation: string): Promise<T> {
  const context = youtubeResponseProviderContext.get(response);
  try {
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
    if(context?.providerKey){
      // A rehabilitated key leaves both quarantine layers, but only when this
      // response is still current: an older in-flight success arriving after
      // a newer suspension event must not clear either layer. Candidate-aware:
      // an expired in-memory suspension can still own a durable row, so a
      // genuinely current success clears it; keys with neither stay cheap
      // (no database touch at all).
      const wasSuspended = youtubeProviderCooldown.isSuspended(context.providerKey) || youtubeProviderCooldown.hasSuspensionCandidate(context.providerKey);
      const providerSuccessIsCurrent=youtubeProviderCooldown.succeeded(context.providerKey,context.providerFailureGeneration);
      if(providerSuccessIsCurrent){
        const validatedPool=getYouTubeKeyPool();
        const validatedIndex=validatedPool.indexOf(context.providerKey);
        // Round-robin advance (not sticky): the next call starts at the
        // following eligible key so healthy keys share the workload instead
        // of one key absorbing everything until it fails.
        if(validatedIndex>=0)activeKeyIndex=advanceYouTubeRotation(validatedPool.length,validatedIndex);
      }
      if (shouldClearYouTubeSuspension(providerSuccessIsCurrent, wasSuspended)) {
        // Generation-gated, awaited clear: another request may have
        // suspended this key after this response validated. The gate
        // rechecks the synchronously-bumped failure generation as late as
        // possible so a newer suspension's fresh durable row survives.
        // Best effort: a missed clear only delays rehabilitation.
        await clearYouTubeSuspensionIfCurrent(context.providerKey, context.providerFailureGeneration).catch(() => undefined);
      }
    }
    context?.acquisition?.providerSucceeded();
    return object as T;
  } catch (error) {
    if(context?.providerKey){
      failedDispatchProviders(context.acquisition)?.add(context.providerKey);
      if(error&&typeof error==='object')Object.assign(error,{providerKey:context.providerKey});
    }
    throw error;
  }
}

/** A request-rate limit is common to this runtime; changing project keys cannot clear it. */
export function isYouTubeRateLimited(error: unknown): boolean {
  let current: any = error;
  for (let depth = 0; current && depth < 5; depth++, current = current.cause) {
    if (current.quotaExceeded === true || isConsumerSuspended(current)) return false;
    if (current.status === 429 || current.providerReasons?.some((reason: unknown) => /^rateLimitExceeded$/i.test(String(reason)))) return true;
  }
  return false;
}

/** Detects YouTube API key rejection (HTTP 400 keyInvalid / API_KEY_INVALID). */
export function isInvalidApiKey(error: unknown): boolean {
  let current: any = error;
  for (let depth = 0; current && depth < 5; depth++, current = current.cause) {
    if (current.quotaExceeded === true) return false;
    const is400 = current.status === 400 || /\b400\b/i.test(String(current.message ?? ''));
    if (!is400) continue;
    const hasKeyReason = current.providerReasons?.some((reason: unknown) => /^(key_?invalid|api_?key_?invalid)$/i.test(String(reason)))
      || /\bkey_?invalid\b|\bapi_?key_?invalid\b/i.test(String(current.message ?? ''));
    if (hasKeyReason) return true;
  }
  return false;
}

export function isConsumerSuspended(error: unknown): boolean {
  let current: any = error;
  for (let depth = 0; current && depth < 5; depth++, current = current.cause) {
    if (current.quotaExceeded === true) return false;
    const is403 = current.status === 403 || /\b403\b/i.test(String(current.message ?? ''));
    const isPermissionDenied = /^PERMISSION_DENIED$/i.test(String(current.status ?? '')) || /\bPERMISSION_DENIED\b/i.test(String(current.message ?? ''));
    const hasSuspendedReason = current.providerReasons?.some((reason: unknown) => /^consumer_?suspended$/i.test(String(reason)))
      || /\bconsumer_?suspended\b/i.test(String(current.message ?? ''));
    if ((is403 || isPermissionDenied) && hasSuspendedReason) return true;
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
    const videoId = lane === 'VIDEO' ? item.id?.videoId : undefined;
    if (existing) {
      if (videoTitle && !existing.videoTitles.includes(videoTitle)) existing.videoTitles.push(videoTitle);
      if (videoDescription && !existing.videoDescriptions?.includes(videoDescription)) existing.videoDescriptions?.push(videoDescription);
      // Keep each result's video ID alongside its title: matchedDocument only
      // retains the first result, so without this later titles lose their IDs.
      if (videoId && videoTitle && !(existing.videos || []).some(video => video.id === videoId)) {
        existing.videos = [...(existing.videos || []), { id: videoId, title: videoTitle, description: videoDescription }];
      }
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
      // Query-text fallback removed: the search query is not a video title and
      // must never carry VIDEO_TITLE provenance downstream. Retrieval context
      // is preserved separately on matchedDocument.
      videoTitles: videoTitle ? [videoTitle] : [],
      videoDescriptions: videoDescription ? [videoDescription] : [],
      videos: videoId && videoTitle ? [{ id: videoId, title: videoTitle, description: videoDescription }] : [],
      // VIDEO-search snippets are retrieval-selected, not a recent-channel
      // sample: they must never vote in the aggregated-language country path.
      videoDescriptionsAuthoritative: false,
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
  ordering: SearchOrdering = 'RELEVANCE',
  priority: YouTubeRequestPriority = 'autonomous'
): Promise<DiscoveredChannelRaw[]> {
  return (await searchYouTubeChannelPage(query, countryName, vocab, lane, null, ordering, undefined, priority)).channels;
}

/** Resolve a staged locator only through the official YouTube Data API. Handles use
 * channels.list(forHandle); video IDs use videos.list(snippet). No text-name
 * matching is permitted because ambiguous names are not authoritative identity. */
export async function resolveYouTubeLocatorAuthoritatively(identity: string, type: 'HANDLE' | 'VIDEO_ID' | 'CHANNEL_ID'): Promise<string | null> {
  assertOfficialYouTubeAllowed('resolveYouTubeLocatorAuthoritatively');
  if (type === 'CHANNEL_ID') return /^UC[A-Za-z0-9_-]{22}$/.test(identity) ? identity : null;
  const keys = getYouTubeKeyPool();
  if (!keys.length) throw new Error('YOUTUBE_RESOLUTION_CAPACITY_UNAVAILABLE');
  const acquisition = youtubePoolBackoff.beginAcquisition();
  try {
    for (let attempt = 0; attempt < keys.length; attempt++) {
      const apiKey = keys[attempt];
      const url = type === 'HANDLE'
        ? buildYouTubeApiUrl('channels', apiKey, { part: 'id', forHandle: identity.replace(/^@/, '') })
        : buildYouTubeApiUrl('videos', apiKey, { part: 'snippet', id: identity });
      try {
        const response = await youtubeFetch(url, `resolve-${type.toLowerCase()}`, 1, attempt + 1, acquisition, 'enrichment', apiKey);
        await accountYouTubeQuotaResponse(response, 1);
        const data = await readYouTubeJsonObject(response, `resolve-${type.toLowerCase()}`);
        const channelId = type === 'HANDLE' ? data.items?.[0]?.id : data.items?.[0]?.snippet?.channelId;
        if (typeof channelId === 'string' && /^UC[A-Za-z0-9_-]{22}$/.test(channelId)) return channelId;
        return null;
      } catch (error) {
        if (attempt === keys.length - 1) throw error;
      }
    }
    return null;
  } finally {
    acquisition.release();
  }
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
  ordering: SearchOrdering = 'RELEVANCE',
  onAdditionalQuota?: YouTubeAdditionalQuotaCallback,
  priority: YouTubeRequestPriority = 'autonomous',
  lifecycle?: YouTubeProviderLifecycle,
  /**
   * Opt-in P2 window treatment (validated publishedAfter/Before bounds).
   * Absent means an unwindowed search; existing callers are unaffected.
   */
  searchWindow?: { publishedAfter?: string; publishedBefore?: string } | null
): Promise<YouTubeChannelPage> {
  assertOfficialYouTubeAllowed('searchYouTubeChannelPage');
  const sanitizedQuery = sanitizeSearchQuery(query, countryName);
  if (!sanitizedQuery) return { channels: [], nextPageToken: null, rawResultCount: 0 };
  // Fail fast on a durably quarantined query before touching any key.
  await throwIfYouTubeInputQuarantined('search', { query: sanitizedQuery });
  const searchHints = countrySearchHints(countryName, vocab?.languages || [], lifecycle?.preferredLanguage);

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

      if (attempt > 0) await onAdditionalQuota?.(100);
      try {
        console.log(`[YouTube API Pool] Attempting search with key #${currentIndex + 1}/${keyPool.length} (${apiKey.slice(0, 6)}...)...`);
        console.log(`[YouTube Outbound Trace] search attempt log returned; constructing request for key #${currentIndex + 1}, attempt ${attempt + 1}`);
        const searchType = lane === 'VIDEO' ? 'video' : 'channel';
        const searchUrl = buildYouTubeApiUrl('search', apiKey, {
          part: 'snippet', type: searchType, order: youtubeOrder(ordering),
          q: sanitizedQuery, maxResults, pageToken: pageToken || undefined,
          regionCode: searchHints.regionCode, relevanceLanguage: searchHints.relevanceLanguage,
          ...(searchWindow?.publishedAfter ? { publishedAfter: searchWindow.publishedAfter } : {}),
          ...(searchWindow?.publishedBefore ? { publishedBefore: searchWindow.publishedBefore } : {})
        });

        console.log(`[YouTube Outbound Trace] search-${attempt + 1} before youtubeFetch at server/youtube.ts:255`);
        const res = await youtubeFetch(searchUrl,'search',100,attempt+1,acquisition,priority,apiKey,lifecycle);
        console.log(`[YouTube Outbound Trace] search-${attempt + 1} after youtubeFetch at server/youtube.ts:255`);

        if (res.ok) {
          console.log(`[YouTube Outbound Trace] search-${attempt + 1} before quota-write at server/youtube.ts:261`);
          await accountYouTubeQuotaResponse(res, 100); // 100 units for YouTube Search call
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
        // A successful response that cannot be accounted must not be fetched
        // again with another key; the provider already spent the units.
        if(isYouTubeQuotaAccountingError(e))throw e;
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
export interface RecentVideoDescription {
  /** Search-result video ID; null only when the API response omits it. */
  videoId: string | null;
  description: string;
}
export async function fetchRecentVideoDescriptionsFromAPI(channelId: string): Promise<string[]> {
  return (await fetchRecentVideoDescriptionsWithIds(channelId)).map(item => item.description);
}

/**
 * ID-aware variant of the recent-video description fetch. Returns the same
 * description set as fetchRecentVideoDescriptionsFromAPI, each paired with
 * its source video ID so overlapping acquisitions (API vs keyless scrape of
 * the same uploads) merge by video instead of by exact text. Quota, rotation,
 * retry, and error semantics are identical — this is the same code path.
 */
export async function fetchRecentVideoDescriptionsWithIds(channelId: string): Promise<RecentVideoDescription[]> {
  assertOfficialYouTubeAllowed('fetchRecentVideoDescriptionsWithIds');
  const keyPool = getYouTubeKeyPool();
  if (!channelId) return [];
  if (keyPool.length === 0) throw new Error('Recent-video description API is unavailable because no provider is configured.');
  // Fail fast on a durably quarantined channel before touching any key.
  await throwIfYouTubeInputQuarantined('recent-videos-search', { channelId });
  const acquisition = youtubePoolBackoff.beginAcquisition();
  let quotaExceededCount = 0;

  let acquiredResponse = false;
  try { const providerIndexes=availableKeyIndexes(keyPool); for (let attempt = 0; attempt < providerIndexes.length; attempt++) {
    const currentIndex = providerIndexes[attempt];
    const apiKey = keyPool[currentIndex];

    try {
      const searchUrl = buildYouTubeApiUrl('search',apiKey,{part:'snippet',channelId,order:'date',type:'video',maxResults:10});
      const res = await youtubeFetch(searchUrl,'recent-videos-search',100,attempt+1,acquisition,'enrichment',apiKey);

      if (res.ok) {
        acquiredResponse = true;
        await accountYouTubeQuotaResponse(res, 100);
        const data = await readYouTubeJsonObject(res, 'recent-videos-search');
        const searchItems: RecentVideoDescription[] = [];
        const videoIds: string[] = [];

        for (const item of data.items || []) {
          const vId = item.id?.videoId ?? null;
          if (vId) videoIds.push(vId);
          if (item.snippet?.description) {
            searchItems.push({ videoId: vId, description: item.snippet.description });
          }
        }

        if (videoIds.length > 0) {
          try {
            const videosUrl = buildYouTubeApiUrl('videos',apiKey,{part:'snippet',id:videoIds.join(',')});
            const vRes = await youtubeFetch(videosUrl,'video-details',1,1,acquisition,'enrichment',apiKey);
            await accountYouTubeQuotaResponse(vRes, 1);
            const vData = await readYouTubeJsonObject(vRes, 'video-details');
            const fullItems: RecentVideoDescription[] = [];
            for (const item of vData.items || []) {
              if (item.snippet?.description) {
                fullItems.push({ videoId: item.id ?? null, description: item.snippet.description });
              }
            }
            if (fullItems.length > 0) return fullItems;
          } catch (error) {
            // The 100-unit search above is already paid for and its snippets
            // are usable. A cap rejection or provider failure on the optional
            // 1-unit follow-up must not discard them and repeat the search on
            // another key. Accounting failures still surface: the follow-up
            // call may already have spent units.
            if (isYouTubeQuotaAccountingError(error)) throw error;
            if (!isYouTubeKeyCapError(error)) {
              console.warn(`[YouTube API] Optional video-details fetch failed for ${channelId}; using paid search descriptions:`, error);
            }
          }
        }

        if (searchItems.length > 0) return searchItems;
      }
    } catch (e) {
      if(isYouTubeQuotaAccountingError(e))throw e;
      recordProviderFailure(apiKey,e);
      if (isQuotaExceeded(e)) quotaExceededCount++;
      console.warn(`[YouTube API] Failed to fetch video descriptions for ${channelId}:`, e);
    }
  }

  acquisition.providerFailed(quotaExceededCount === keyPool.length ? 'QUOTA_EXHAUSTED' : 'INDETERMINATE');
  // Preserve a structured provider-capacity error so the community retry worker
  // can defer without consuming a meaningful retry opportunity.
  throwIfAllProvidersCoolingDown(keyPool);

  if(!acquiredResponse)throw new Error('Recent-video description API acquisition failed for every configured provider.');
  return [];
  } finally { acquisition.release(); }
}

/** Accounts one successful provider response: the checkpoint that lets later
 * attempts skip this provider call is assigned by callers only after this
 * resolves, so a consumed unit can never go unaccounted. Each response gets
 * one stable accounting operation ID (stable across this call's internal
 * retries, unique per response) so a retry after an unknown commit outcome
 * cannot charge the same response twice. Exhausted retries throw
 * YouTubeQuotaAccountingError (never a provider error) so the attempt flow
 * surfaces it without key failover or a refetch. */
async function accountYouTubeQuotaResponse(response: Response, units: number): Promise<string> {
  const providerKey = getYouTubeResponseProviderKey(response);
  const operationId = randomUUID();
  const reservation = youtubeResponseProviderContext.get(response)?.keyCapReservation;
  const shadowOperationId = getYouTubeResponseShadowOperationId(response);
  try {
    await retryYouTubeQuotaAccounting(unitsConsumed => incrementQuota(unitsConsumed, providerKey, operationId, reservation ?? shadowOperationId), units);
  } catch (error) {
    // Any accounting/settlement failure after a successful provider response
    // must stop the caller from refetching the same logical request with
    // another key. Preserve the cause for diagnostics, but surface one typed
    // accounting error so every provider loop breaks out before failover.
    throw new YouTubeQuotaAccountingError(units, providerKey, { cause: error });
  }
  return providerKey;
}

/** Adapts a playlistItems.list payload into the search.list item shape the
 * enrichment activity stats consume ({id.videoId, snippet.title,
 * snippet.description, snippet.publishedAt}). Pure and unit-tested.
 * Timestamp fidelity: playlistItem snippet.publishedAt is when the item was
 * added to the playlist, not when the video was published. Prefer
 * contentDetails.videoPublishedAt (callers request the contentDetails part
 * at no extra quota cost), falling back to snippet.publishedAt when absent
 * so older payloads still adapt. */
export function adaptPlaylistItemsToSearchShape(payload: { items?: Array<Record<string, any>> }): { items: Array<{ id: { videoId: string | null }; snippet: Record<string, any> }> } {
  return {
    items: (Array.isArray(payload.items) ? payload.items : []).map(item => {
      const snippet = (item && typeof item.snippet === 'object' ? { ...item.snippet } : {}) as Record<string, any>;
      const contentDetails = item && typeof item.contentDetails === 'object' ? (item.contentDetails as Record<string, any>) : null;
      const videoPublishedAt = contentDetails?.videoPublishedAt;
      if (typeof videoPublishedAt === 'string' && videoPublishedAt && Number.isFinite(Date.parse(videoPublishedAt))) {
        snippet.publishedAt = videoPublishedAt;
      }
      return {
        id: { videoId: item?.snippet?.resourceId?.videoId ?? null },
        snippet,
      };
    }),
  };
}
/**
 * Provider-supplied uploader language from an already-fetched YouTube snippet
 * (videos.list `defaultAudioLanguage` first, then channels/videos.list
 * `defaultLanguage`). Zero extra quota: the snippet is in hand. Never
 * inferred from country; invalid tags are dropped downstream by
 * normalizeLanguageCode, and the language selector stays fail-closed on
 * missing/conflicting signals. Exported for unit testing.
 */
/**
 * Effective channel language snippet: the channels.list snippet plus the
 * channel's configured default from brandingSettings (YouTube exposes the
 * uploader default there, not in the snippet). Snippet fields win on
 * conflict; nothing is inferred from country.
 */
export function channelLanguageSnippet(channel: any): { defaultAudioLanguage?: unknown; defaultLanguage?: unknown } {
  const snippetDefault = channel?.snippet?.defaultLanguage;
  const brandingDefault = channel?.brandingSettings?.channel?.defaultLanguage;
  // Validate before choosing: an invalid snippet default must not suppress a
  // valid branding default (validated downstream by snippetLanguage).
  const validSnippetDefault =
    typeof snippetDefault === 'string' && normalizeLanguageCode(snippetDefault) !== '' ? snippetDefault : undefined;
  return {
    defaultAudioLanguage: channel?.snippet?.defaultAudioLanguage,
    defaultLanguage: validSnippetDefault ?? brandingDefault,
  };
}

export function snippetLanguage(snippet: any): string | undefined {
  // First VALID tag wins: an invalid audio tag must never suppress a valid
  // default. The raw tag is returned (region preserved for explicitLocale);
  // validity is judged by the shared normalizer.
  for (const tag of [snippet?.defaultAudioLanguage, snippet?.defaultLanguage]) {
    if (typeof tag === 'string' && tag.trim() !== '' && normalizeLanguageCode(tag) !== '') return tag;
  }
  return undefined;
}

/**
 * Usable video-language signals: raw tags that survive normalization. Only
 * these count when deciding whether the channel fallback applies — invalid
 * tags are ignored instead of suppressing the fallback.
 */
export function usableVideoLanguages(videos: Array<{ language?: unknown }>): string[] {
  return videos
    .map(video => video.language)
    .filter((tag): tag is string => typeof tag === 'string' && normalizeLanguageCode(tag) !== '');
}

/**
 * Channel-fallback selection for enrichment: usable video languages always
 * win (even conflicting ones — the selector then fail-closes); the channel
 * default applies only when no video carries a usable signal; a stale
 * fallback survives only when nothing newer exists. A valid transcript
 * language disagreeing with the selected context vetoes it: transcripts
 * describe actual spoken content, so disagreement fails closed instead of
 * trusting one signal. `dissented` tells callers to also suppress transcript
 * languages — otherwise the vetoed transcript would become the selector's
 * only document signal and classify anyway.
 */
export interface EnrichmentLanguageResolution {
  detectedLanguages: Array<{ language: string }> | undefined;
  dissented: boolean;
}

export function resolveEnrichmentDetectedLanguages(
  channelSnippet: any,
  videos: Array<{ language?: unknown }>,
  fallbackDetectedLanguages: Array<{ language: string; confidence?: number }> | undefined,
  transcripts: Array<{ language?: unknown }> = []
): EnrichmentLanguageResolution {
  if (usableVideoLanguages(videos).length > 0) return { detectedLanguages: undefined, dissented: false };
  // Resolve the same confidence winner the terminology selector will use:
  // highest-confidence entries must agree on one language, or no selection
  // exists to keep or veto (mirrors the selector's fail-closed rule).
  const channelTag = snippetLanguage(channelSnippet);
  const pool: Array<{ language: string; confidence?: number }> =
    channelTag !== undefined ? [{ language: channelTag }] : (fallbackDetectedLanguages ?? []);
  const scored = pool
    .map(item => ({
      language: item.language,
      confidence: Number.isFinite(item.confidence) ? Number(item.confidence) : 0,
    }))
    .filter(item => normalizeLanguageCode(item.language) !== '');
  if (!scored.length) return { detectedLanguages: undefined, dissented: false };
  const top = Math.max(...scored.map(item => item.confidence));
  const winners = [
    ...new Set(
      scored.filter(item => item.confidence === top).map(item => normalizeLanguageCode(item.language))
    ),
  ];
  if (winners.length !== 1) return { detectedLanguages: undefined, dissented: false };
  const dissent = usableVideoLanguages(transcripts)
    .map(tag => normalizeLanguageCode(tag))
    .some(lang => lang !== '' && lang !== winners[0]);
  if (dissent) return { detectedLanguages: undefined, dissented: true };
  return {
    detectedLanguages: channelTag !== undefined ? [{ language: channelTag }] : fallbackDetectedLanguages,
    dissented: false,
  };
}

/**
 * Transcript-language suppression for vetoed selections: drops language keys
 * so a dissenting transcript cannot become the terminology selector's only
 * document-language signal. Text is untouched.
 */
export function withoutTranscriptLanguages(
  excerpts: Array<{ video_id?: string; text: string; language?: string }>
): Array<{ video_id?: string; text: string }> {
  return excerpts.map(({ language: _terminologyOnly, ...rest }) => rest);
}

/**
 * Trading-classification isolation: provider video language is a
 * terminology-selection signal only. Classifier inputs keep their
 * pre-existing shape (no language key); everything else is identical.
 */
/** Video shape shared with trading-classification inputs (superset kept local so youtube.ts gains no new imports). */
export interface ClassifiableVideo {
  id?: string;
  title: string;
  description?: string;
  published_at?: string;
  content_type?: string;
  script?: string;
  source_family_id?: string;
  source_entity_id?: string;
  language?: string;
}

/**
 * Terminology-isolation boundary for classifier inputs. Provider-declared
 * language (uploader metadata flagged by YouTube enrichment/metadata
 * hydration) is a terminology-selection signal only and must not reach the
 * trading classifier — on ANY pass, since hydration can attach it outside
 * enrichment. Unflagged candidate hints (content-analyzed or future
 * legitimate producers) are preserved untouched. The terminology selector
 * reads the same signals from the candidate object, which is never modified
 * here. The enrichment pass flag remains as defense in depth.
 */
export function classifierLanguageInputs(
  candidate: Pick<DiscoveredChannelRaw, 'detectedLanguages' | 'providerDeclaredLanguage'>,
  structuredVideos: ClassifiableVideo[],
  isEnrichmentPass: boolean
): {
  videos: Array<ClassifiableVideo> | Array<Omit<ClassifiableVideo, 'language'>>;
  detected_languages: Array<{ language: string; confidence?: number }> | undefined;
} {
  if (!isEnrichmentPass && candidate.providerDeclaredLanguage !== true) {
    return { videos: structuredVideos, detected_languages: candidate.detectedLanguages };
  }
  return { videos: withoutVideoLanguages(structuredVideos), detected_languages: undefined };
}

export function withoutVideoLanguages(videos: Array<ClassifiableVideo>): Array<Omit<ClassifiableVideo, 'language'>> {
  return videos.map(({ language: _terminologyOnly, ...rest }) => rest);
}

/**
 * Fetches richer official channel metadata and recent uploads for a borderline
 * creator. Unlike discovery search, this is only called by a durable enrichment
 * job and throws when all configured keys fail so queue retry/backoff applies.
 */
export async function fetchYouTubeChannelEnrichment(
  channelId: string,
  fallback: DiscoveredChannelRaw,
  stage:1|2|3=1,
  onAdditionalQuota?: YouTubeAdditionalQuotaCallback,
  priority:YouTubeRequestPriority='enrichment'
): Promise<DiscoveredChannelRaw> {
  assertOfficialYouTubeAllowed('fetchYouTubeChannelEnrichment');
  const keyPool = getYouTubeKeyPool();
  if (keyPool.length === 0) {
    throw new Error('YouTube enrichment requires at least one configured YouTube API key.');
  }
  // Fail fast on a durably quarantined channel before touching any key.
  await throwIfYouTubeInputQuarantined('channel-uploads', { channelId });
  const acquisition = youtubePoolBackoff.beginAcquisition();

  let lastError: Error | null = null;
  let quotaExceededCount = 0;
  let uploadsCheckpoint:Record<string,any>|null=null;
  let channelCheckpoint:Record<string,any>|null=null;
  let playlistsCheckpoint:Record<string,any>|null=null;
  let videoDetailsCheckpoint:Record<string,any>|null=null;
  let quotaAdmissionError:unknown;
  const topUp=async(units:number):Promise<void>=>{
    try{await onAdditionalQuota?.(units);}catch(error){quotaAdmissionError=error;throw error;}
  };
  try { const providerIndexes=availableKeyIndexes(keyPool); for (let attempt = 0; attempt < providerIndexes.length; attempt++) {
    const currentIndex = providerIndexes[attempt];
    const apiKey = keyPool[currentIndex];
    try {
      const channelUrl = buildYouTubeApiUrl('channels',apiKey,{part:'snippet,brandingSettings,statistics,contentDetails',id:channelId});
      if(!uploadsCheckpoint){
        // Failover top-up covers what this key is actually about to spend:
        // both requests (2) when the channel checkpoint is still missing,
        // only the uploads request (1) when it can be reused.
        if(attempt>0)await topUp(channelCheckpoint?1:2);
        // Resolve recent uploads through the channel's uploads playlist
        // (channels.list 1 unit + playlistItems.list 1 unit) instead of a
        // 100-unit search.list scoped to the channel. The uploads playlist
        // returns the same snippet fields in reverse-chronological order, so
        // every activity stat below is preserved while quota burn drops 50x.
        if(!channelCheckpoint){
          const channelFirstResponse = await youtubeFetch(channelUrl,'channel-details',1,attempt+1,acquisition,priority,apiKey);
          // Account the provider call before parsing: a malformed successful
          // body must still settle its reservation, otherwise the lease holds
          // capacity until the Pacific reset and the loop rotates keys.
          await accountYouTubeQuotaResponse(channelFirstResponse, 1);
          const channelFirstPayload = await readYouTubeJsonObject(channelFirstResponse, 'channel-details');
          channelCheckpoint = channelFirstPayload;
        }
        const uploadsPlaylistId = channelCheckpoint.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
        if (uploadsPlaylistId) {
          const recentResponse = await youtubeFetch(buildYouTubeApiUrl('playlistItems',apiKey,{part:'snippet,contentDetails',playlistId:String(uploadsPlaylistId),maxResults:10}),'channel-uploads',1,attempt+1,acquisition,priority,apiKey);
          await accountYouTubeQuotaResponse(recentResponse, 1);
          uploadsCheckpoint = adaptPlaylistItemsToSearchShape(await readYouTubeJsonObject(recentResponse, 'channel-uploads'));
        } else {
          uploadsCheckpoint = { items: [] };
        }
      }
      if(!channelCheckpoint){
        if(attempt>0)await topUp(1);
        const channelResponse = await youtubeFetch(channelUrl,'channel-details',1,attempt+1,acquisition,priority,apiKey);
        await accountYouTubeQuotaResponse(channelResponse, 1);
        const channelPayload = await readYouTubeJsonObject(channelResponse, 'channel-details');
        channelCheckpoint = channelPayload;
      }
      const recentData=uploadsCheckpoint;
      const channelData=channelCheckpoint;
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
      let videos: Array<{id?:string;title:string;description?:string;published_at?:string;content_type?:string;language?:string}>=recentItems.map((item:any)=>({id:item.id?.videoId,title:String(item.snippet?.title||''),description:String(item.snippet?.description||''),published_at:item.snippet?.publishedAt,content_type:'youtube_video'})).filter((video:any)=>video.title);
      let playlists=fallback.playlists||[];
      if(stage>=2){
        const ids=videos.map(video=>video.id).filter(Boolean).join(',');
        if(!playlistsCheckpoint){
          if(attempt>0)await topUp(100);
          const playlistResponse=await youtubeFetch(buildYouTubeApiUrl('search',apiKey,{part:'snippet',channelId,type:'playlist',maxResults:10}),'enrichment-playlists',100,attempt+1,acquisition,priority,apiKey);
          await accountYouTubeQuotaResponse(playlistResponse, 100);
          const playlistPayload=await readYouTubeJsonObject(playlistResponse,'enrichment-playlists');
          playlistsCheckpoint=playlistPayload;
        }
        const playlistPayload=playlistsCheckpoint;
        playlists=playlistPayload.items.map((item:any)=>({id:item.id?.playlistId,name:String(item.snippet?.title||''),description:String(item.snippet?.description||'')})).filter((item:any)=>item.name);
        if(ids){if(!videoDetailsCheckpoint){if(attempt>0)await topUp(1);const videoResponse=await youtubeFetch(buildYouTubeApiUrl('videos',apiKey,{part:'snippet',id:ids}),'enrichment-video-details',1,attempt+1,acquisition,priority,apiKey);await accountYouTubeQuotaResponse(videoResponse, 1);const videoDetailsPayload=await readYouTubeJsonObject(videoResponse,'enrichment-video-details');videoDetailsCheckpoint=videoDetailsPayload;}const byId=new Map(videoDetailsCheckpoint.items?.map((item:any)=>[item.id,item.snippet])||[]);videos=videos.map(video=>({...video,description:String((byId.get(video.id) as any)?.description||video.description||''),language:snippetLanguage(byId.get(video.id))}));}
      }

      // Channel-level provider language as fallback only, resolved through
      // resolveEnrichmentDetectedLanguages: usable video languages suppress
      // every fallback (even each other — the selector fail-closes); the
      // channel default applies solely when no video carries a usable
      // signal; a stale fallback survives only when nothing newer exists.
      // A transcript veto additionally suppresses transcript languages so
      // the vetoed transcript cannot classify alone. Provider-asserted,
      // never country-derived.
      const languageResolution = resolveEnrichmentDetectedLanguages(
        channelLanguageSnippet(channel), videos, fallback.detectedLanguages, fallback.transcriptExcerpts ?? []
      );
      const channelFallbackLangs = languageResolution.detectedLanguages;
      // Provenance marker: any language below came from provider metadata
      // (videos.list/channel.list uploader tags), so the trading classifier
      // strips it while terminology selection keeps it.
      const providerDeclaredLanguage =
        channelFallbackLangs !== undefined ||
        videos.some(video => typeof video.language === 'string') ||
        fallback.providerDeclaredLanguage || undefined;
      const transcriptExcerpts = languageResolution.dissented && fallback.transcriptExcerpts
        ? withoutTranscriptLanguages(fallback.transcriptExcerpts)
        : fallback.transcriptExcerpts;

      return {
        ...fallback,
        channelId,
        channelName: channel.snippet?.title || fallback.channelName,
        youtubeUrl: `https://www.youtube.com/channel/${channelId}`,
        description,
        videoTitles: recentItems.map((item: any) => item.snippet?.title || ''),
        videos,playlists,videoDescriptions:videos.map(video=>video.description||''),
        detectedLanguages:channelFallbackLangs,transcriptExcerpts,providerDeclaredLanguage,
        // Authoritative recent-channel sample (order=date recent uploads):
        // the only discovery-side descriptions permitted to vote in the
        // aggregated-content-language country path.
        videoDescriptionsAuthoritative: true,
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
      if(error===quotaAdmissionError)throw error;
      // Accounting already succeeded at the provider: failing over to
      // another key would burn a second provider call while the first
      // call's units stay unrecorded. Surface immediately instead.
      if(isYouTubeQuotaAccountingError(error))throw error;
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


/** One-unit basic metadata hydration used when country or subscriber evidence is missing. */
export async function fetchYouTubeChannelCountryMetadata(channelId: string, fallback: DiscoveredChannelRaw): Promise<DiscoveredChannelRaw> {
  const checkedAt = new Date().toISOString();
  // Probe-origin ingestion must degrade to public-page evidence rather than
  // spend a channels.list unit. This path never throws, so return an explicit
  // not-requested status instead of pretending provider capacity was absent.
  if (!isOfficialYouTubeQuotaAllowed()) {
    return { ...fallback, countryMetadataStatus: 'NOT_REQUESTED', countryMetadataCheckedAt: checkedAt };
  }
  const keys = getYouTubeKeyPool();
  if (!keys.length) return { ...fallback, countryMetadataStatus: 'UNAVAILABLE', countryMetadataCheckedAt: checkedAt };
  let acquisition; try { acquisition=youtubePoolBackoff.beginAcquisition(); }
  catch { return { ...fallback, countryMetadataStatus: 'UNAVAILABLE', countryMetadataCheckedAt: checkedAt }; }
  // A quarantined channel degrades to the fallback (this path never throws);
  // a gate read failure proceeds best-effort since the call below records it.
  try {
    await throwIfYouTubeInputQuarantined('channel-country-metadata', { channelId });
  } catch (error) {
    if (isYouTubeQuarantinedInput(error)) return { ...fallback, countryMetadataStatus: 'UNAVAILABLE', countryMetadataCheckedAt: checkedAt };
  }
  let quotaExceededCount = 0;
  try { const providerIndexes=availableKeyIndexes(keys); for (let attempt = 0; attempt < providerIndexes.length; attempt++) {
    const index = providerIndexes[attempt];
    try {
      const url = buildYouTubeApiUrl('channels',keys[index],{part:'snippet,brandingSettings,statistics',id:channelId});
      const response = await youtubeFetch(url, 'channel-country-metadata', 1, attempt + 1, acquisition, 'enrichment', keys[index]);
      // A successful channels.list response consumed one unit even when the
      // payload has no items[0] or later fails validation. Account before
      // inspecting the body so not-found/invalid bodies cannot hide spend.
      await accountYouTubeQuotaResponse(response, 1);
      const data = await readYouTubeJsonObject(response, 'channel-country-metadata');
      const channel = data.items?.[0];
      if (!channel) throw new Error(`YouTube channel '${channelId}' was not found.`);
      const officialCountry = channel.brandingSettings?.channel?.country;
      const subscriberCount = channel.statistics?.hiddenSubscriberCount === true ? fallback.subscriberCount : (channel.statistics?.subscriberCount || fallback.subscriberCount);
      // Same validated fallback rules as enrichment: already-fetched
      // snippet/branding language is retained so later extraction passes
      // without a full enrichment round. A transcript veto additionally
      // suppresses transcript languages (see enrichment return).
      const metadataLanguage = resolveEnrichmentDetectedLanguages(
        channelLanguageSnippet(channel), fallback.videos ?? [], fallback.detectedLanguages,
        fallback.transcriptExcerpts ?? []
      );
      // Provenance marker (see enrichment return): provider-declared hints
      // are stripped from trading-classifier inputs on every pass.
      const metadataProviderLanguage =
        metadataLanguage.detectedLanguages !== undefined ||
        (fallback.videos ?? []).some(video => typeof video.language === 'string') ||
        fallback.providerDeclaredLanguage || undefined;
      return { ...fallback, description: channel.snippet?.description || fallback.description,
        locationTag: officialCountry || fallback.locationTag,
        subscriberCount,
        detectedLanguages: metadataLanguage.detectedLanguages,
        providerDeclaredLanguage: metadataProviderLanguage,
        transcriptExcerpts: metadataLanguage.dissented && fallback.transcriptExcerpts
          ? withoutTranscriptLanguages(fallback.transcriptExcerpts)
          : fallback.transcriptExcerpts,
        countryMetadataStatus: officialCountry ? 'AVAILABLE_DECLARED' : 'AVAILABLE_NOT_DECLARED', countryMetadataCheckedAt: checkedAt };
    } catch (error) {
      if(isYouTubeQuotaAccountingError(error))throw error;
      recordProviderFailure(keys[index],error);if (isQuotaExceeded(error)) quotaExceededCount++;
    }
  }
  acquisition.providerFailed(quotaExceededCount === keys.length ? 'QUOTA_EXHAUSTED' : 'INDETERMINATE');
  return { ...fallback, countryMetadataStatus: 'UNAVAILABLE', countryMetadataCheckedAt: checkedAt };
  } finally { acquisition.release(); }
}