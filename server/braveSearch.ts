import { createHash } from 'node:crypto';
import { getAppSetting, getDb } from './db';
import {
  registerRetrievalExecutor,
  providerSnapshot,
  type ProviderAllocation,
  type RetrievalRequest,
  type RetrievalPage
} from './providerAwareRetrieval';
import type { DiscoveredChannelRaw } from './youtube';

export const BRAVE_SEARCH_PROVIDER_KEY = 'brave-search';

export const BRAVE_DIRECT_PROVIDER: ProviderAllocation = Object.freeze({
  providerKey: BRAVE_SEARCH_PROVIDER_KEY,
  retrievalSurface: 'BRAVE_NATIVE',
  capability: 'SEARCH_BRAVE_DIRECT',
  costDomain: 'BRAVE_SEARCH_API',
  continuationOwner: 'PHASE_9'
});

export const BRAVE_OSINT_PROVIDER: ProviderAllocation = Object.freeze({
  providerKey: BRAVE_SEARCH_PROVIDER_KEY,
  retrievalSurface: 'BRAVE_EXTERNAL_OSINT',
  capability: 'SEARCH_BRAVE_EXTERNAL_OSINT',
  costDomain: 'BRAVE_SEARCH_API',
  continuationOwner: 'PHASE_9'
});

export interface BraveSearchResultItem {
  title: string;
  url: string;
  description?: string;
  published_time?: string;
  page_age?: string;
}

export interface BraveSearchResponse {
  type?: string;
  web?: {
    results?: BraveSearchResultItem[];
    total?: number;
  };
  query?: {
    original?: string;
    show_strict_warning?: boolean;
    more_results_available?: boolean;
  };
}

export interface NormalizedBraveCandidate {
  candidateType: 'CHANNEL_ID' | 'HANDLE' | 'VIDEO_ID' | 'EXTERNAL_EVIDENCE';
  normalizedIdentity: string;
  rawLocator: string;
  title: string;
  snippet?: string;
  discoveryMode: 'DIRECT_YOUTUBE' | 'EXTERNAL_OSINT';
  confidence: number;
  isNoise: boolean;
  noiseReason?: string;
}

export interface BraveControlPlaneStatus {
  allowed: boolean;
  reason?: string;
  killSwitchActive: boolean;
  mode: string;
  dailyCapReached: boolean;
  backlogThresholdExceeded: boolean;
  cooldownActive?: boolean;
}

export class BraveProviderError extends Error {
  code: string;
  status?: number;
  retryAfterMs?: number;
  retryable: boolean;
  constructor(code: string, message = code, options: { status?: number; retryAfterMs?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = 'BraveProviderError';
    this.code = code;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.retryable = options.retryable ?? false;
  }
}

// Low quality / noise patterns for Brave web search filtering
const NOISE_DOMAIN_PATTERNS = [
  /pinterest\./i,
  /facebook\./i,
  /instagram\./i,
  /tiktok\./i,
  /reddit\./i,
  /twitter\./i,
  /x\.com/i,
  /linkedin\./i,
  /quora\./i,
  /wikipedia\./i,
  /medium\./i,
  /ebay\./i,
  /amazon\./i
];

const NOISE_TITLE_SNIPPET_PATTERNS = [
  /top \d+ trading tools/i,
  /best \d+ brokers/i,
  /affiliate/i,
  /coupon code/i,
  /promo code/i,
  /casino/i,
  /betting/i,
  /lottery/i,
  /crypto giveaway/i,
  /free signals/i
];

/**
 * Enforces runtime control plane rules fail-closed: kill switch, rollout mode, daily request caps, and backlog threshold backpressure.
 * The discovery_provider_registry table is the sole authoritative store for provider mode.
 */
export async function checkBraveControlPlane(clientOverride?: any): Promise<BraveControlPlaneStatus> {
  // Emergency env kill switch check
  if (process.env.BRAVE_KILL_SWITCH === 'true') {
    return { allowed: false, reason: 'EMERGENCY_ENV_KILL_SWITCH', killSwitchActive: true, mode: 'OFF', dailyCapReached: false, backlogThresholdExceeded: false };
  }

  const db = clientOverride === null ? null : (clientOverride || (process.env.DATABASE_URL ? await getDb() : null));
  if (!db) {
    return { allowed: false, reason: 'CONTROL_PLANE_UNAVAILABLE_FAIL_CLOSED', killSwitchActive: false, mode: 'OFF', dailyCapReached: false, backlogThresholdExceeded: false };
  }

  try {
    const [settingsRes, regRes, backlogRes, dailyReqRes] = await Promise.all([
      db.query(`SELECT setting_key, setting_value FROM app_settings WHERE setting_key LIKE 'brave_%'`),
      db.query(`SELECT mode FROM discovery_provider_registry WHERE provider_key = $1`, [BRAVE_SEARCH_PROVIDER_KEY]),
      db.query(`SELECT COUNT(*)::int AS backlog_count FROM discovery_candidate_staging WHERE resolution_status = 'PENDING'`),
      db.query(`SELECT COALESCE(SUM(requests_attempted),0)::int AS daily_requests FROM provider_budget_ledger WHERE provider_key = $1 AND budget_day = CURRENT_DATE`, [BRAVE_SEARCH_PROVIDER_KEY])
    ]);

    const settingsMap = new Map<string, string>(settingsRes.rows.map((r: any) => [r.setting_key, r.setting_value]));
    const regMode = regRes.rows[0]?.mode || 'OFF';

    if (settingsMap.get('brave_kill_switch') === 'true' || regMode === 'OFF' || regMode === 'PAUSED' || regMode === 'RETIRED') {
      return { allowed: false, reason: settingsMap.get('brave_kill_switch') === 'true' ? 'KILL_SWITCH_OR_DISABLED_MODE' : 'PROVIDER_MODE_DISABLED', killSwitchActive: settingsMap.get('brave_kill_switch') === 'true', mode: regMode, dailyCapReached: false, backlogThresholdExceeded: false };
    }

    const cooldownUntil = Date.parse(settingsMap.get('brave_cooldown_until') || '');
    if (Number.isFinite(cooldownUntil) && cooldownUntil > Date.now()) {
      return { allowed: false, reason: 'PROVIDER_COOLDOWN', killSwitchActive: false, mode: regMode, dailyCapReached: false, backlogThresholdExceeded: false, cooldownActive: true };
    }

    const dailyRequests = Number(dailyReqRes.rows[0]?.daily_requests || 0);
    const dailyCap = Number(settingsMap.get('brave_daily_request_cap') || 1000);
    if (dailyCap > 0 && dailyRequests >= dailyCap) {
      return { allowed: false, reason: 'DAILY_REQUEST_CAP_EXCEEDED', killSwitchActive: false, mode: regMode, dailyCapReached: true, backlogThresholdExceeded: false };
    }

    const backlogCount = Number(backlogRes.rows[0]?.backlog_count || 0);
    const maxBacklog = Number(settingsMap.get('brave_staging_backlog_threshold') || 500);
    if (maxBacklog > 0 && backlogCount >= maxBacklog) {
      return { allowed: false, reason: 'STAGING_BACKLOG_THRESHOLD_EXCEEDED', killSwitchActive: false, mode: regMode, dailyCapReached: false, backlogThresholdExceeded: true };
    }

    return { allowed: true, killSwitchActive: false, mode: regMode, dailyCapReached: false, backlogThresholdExceeded: false };
  } catch (err) {
    console.warn('[BraveControlPlane] Check error fail-closed:', err);
    return { allowed: false, reason: 'CONTROL_PLANE_CHECK_FAILED', killSwitchActive: false, mode: 'OFF', dailyCapReached: false, backlogThresholdExceeded: false };
  }
}

/**
 * Parses and normalizes YouTube identities from URLs or text references.
 */
export function normalizeYouTubeLocator(urlStr: string): NormalizedBraveCandidate | null {
  if (!urlStr || typeof urlStr !== 'string') return null;
  const trimmed = urlStr.trim();

  // 1. Check for canonical channel ID: youtube.com/channel/UC...
  const channelMatch = trimmed.match(/(?:youtube\.com|m\.youtube\.com)\/channel\/(UC[a-zA-Z0-9_-]{22})/i);
  if (channelMatch) {
    return {
      candidateType: 'CHANNEL_ID',
      normalizedIdentity: channelMatch[1],
      rawLocator: trimmed,
      title: '',
      discoveryMode: 'DIRECT_YOUTUBE',
      confidence: 1.0,
      isNoise: false
    };
  }

  // 2. Check for handle: youtube.com/@handle or @handle
  const handleMatch = trimmed.match(/(?:youtube\.com|m\.youtube\.com)\/@([a-zA-Z0-9_\.-]+)/i);
  if (handleMatch) {
    const handleName = handleMatch[1].toLowerCase();
    return {
      candidateType: 'HANDLE',
      normalizedIdentity: `@${handleName}`,
      rawLocator: trimmed,
      title: '',
      discoveryMode: 'DIRECT_YOUTUBE',
      confidence: 0.9,
      isNoise: false
    };
  }

  // 3. Check for video ID: youtube.com/watch?v=... or youtu.be/...
  const videoMatch = trimmed.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/i);
  if (videoMatch) {
    return {
      candidateType: 'VIDEO_ID',
      normalizedIdentity: videoMatch[1],
      rawLocator: trimmed,
      title: '',
      discoveryMode: 'DIRECT_YOUTUBE',
      confidence: 0.95,
      isNoise: false
    };
  }

  // 4. External webpage containing potential creator footprint
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      const parsed = new URL(trimmed);
      for (const pattern of NOISE_DOMAIN_PATTERNS) {
        if (pattern.test(parsed.hostname)) {
          return {
            candidateType: 'EXTERNAL_EVIDENCE',
            normalizedIdentity: parsed.href,
            rawLocator: trimmed,
            title: '',
            discoveryMode: 'EXTERNAL_OSINT',
            confidence: 0.1,
            isNoise: true,
            noiseReason: 'EXCLUDED_SOCIAL_OR_AGGREGATOR_DOMAIN'
          };
        }
      }
      return {
        candidateType: 'EXTERNAL_EVIDENCE',
        normalizedIdentity: `${parsed.hostname}${parsed.pathname}`,
        rawLocator: trimmed,
        title: '',
        discoveryMode: 'EXTERNAL_OSINT',
        confidence: 0.6,
        isNoise: false
      };
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Checks if a search result item represents noise or low-quality farm content.
 */
export function evaluateBraveCandidateNoise(item: BraveSearchResultItem): { isNoise: boolean; reason?: string } {
  if (!item.url || !item.title) {
    return { isNoise: true, reason: 'MISSING_TITLE_OR_URL' };
  }

  const combinedText = `${item.title} ${item.description || ''}`;
  for (const pattern of NOISE_TITLE_SNIPPET_PATTERNS) {
    if (pattern.test(combinedText)) {
      return { isNoise: true, reason: `NOISE_PATTERN_MATCHED: ${pattern.source}` };
    }
  }

  return { isNoise: false };
}

/**
 * Maps country code (2-letter ISO) to Brave Search country parameter where supported.
 */
export function mapCountryToBraveParam(country: string): string {
  if (!country) return 'us';
  return country.toLowerCase().trim();
}

/**
 * Converts repository vocabulary labels into Brave's supported search_lang codes.
 * Unknown values fail closed to English rather than sending an invalid full name.
 */
export function mapLanguageToBraveParam(language: string | null | undefined): string {
  const normalized = (language || '').toLowerCase().trim();
  if (/^[a-z]{2}(?:-[a-z]{2,4})?$/.test(normalized)) return normalized.split('-')[0];
  const languageCodes: Record<string, string> = {
    arabic: 'ar', basque: 'eu', bengali: 'bn', bulgarian: 'bg', catalan: 'ca',
    chinese: 'zh-hans', croatian: 'hr', czech: 'cs', danish: 'da', dutch: 'nl',
    estonian: 'et', finnish: 'fi', french: 'fr', galician: 'gl', german: 'de',
    greek: 'el', gujarati: 'gu', hebrew: 'he', hindi: 'hi', hungarian: 'hu',
    icelandic: 'is', indonesian: 'id', italian: 'it', japanese: 'ja', kannada: 'kn',
    korean: 'ko', latvian: 'lv', lithuanian: 'lt', malay: 'ms', malayalam: 'ml',
    marathi: 'mr', norwegian: 'nb', polish: 'pl', portuguese: 'pt', punjabi: 'pa',
    romanian: 'ro', russian: 'ru', serbian: 'sr', slovak: 'sk', slovenian: 'sl',
    spanish: 'es', swahili: 'sw', swedish: 'sv', tamil: 'ta', telugu: 'te',
    thai: 'th', turkish: 'tr', ukrainian: 'uk', vietnamese: 'vi', english: 'en'
  };
  return languageCodes[normalized] || 'en';
}

/**
 * Constructs a Brave API search request URL and headers, deriving search language dynamically from lineage context.
 */
export function buildBraveSearchRequest(
  query: string,
  country: string,
  language: string | null | undefined,
  mode: 'DIRECT_YOUTUBE' | 'EXTERNAL_OSINT',
  offset = 0,
  count = 20,
  apiKeyOverride?: string
): { url: string; headers: Record<string, string> } {
  const apiKey = apiKeyOverride || process.env.BRAVE_SEARCH_API_KEY || process.env.BRAVE_API_KEY || '';
  if (!apiKey) {
    throw new Error('BRAVE_API_KEY_MISSING');
  }

  let finalQuery = query;
  if (mode === 'DIRECT_YOUTUBE' && !query.includes('site:youtube.com')) {
    finalQuery = `site:youtube.com ${query}`;
  }

  const braveCountry = mapCountryToBraveParam(country);
  const searchLang = mapLanguageToBraveParam(language);
  const searchUrl = new URL('https://api.search.brave.com/res/v1/web/search');
  searchUrl.searchParams.set('q', finalQuery);
  searchUrl.searchParams.set('country', braveCountry);
  searchUrl.searchParams.set('search_lang', searchLang);
  searchUrl.searchParams.set('count', String(Math.min(20, Math.max(1, count))));
  searchUrl.searchParams.set('offset', String(Math.max(0, offset)));
  searchUrl.searchParams.set('safesearch', 'off');

  return {
    url: searchUrl.toString(),
    headers: {
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'Cache-Control': 'no-cache',
      'X-Subscription-Token': apiKey
    }
  };
}

/**
 * Executes a single Brave Search API request with resilience, bounded deadline timeout (AbortController), and error handling.
 */
export async function fetchBraveSearchResults(
  query: string,
  country: string,
  language: string | null | undefined,
  mode: 'DIRECT_YOUTUBE' | 'EXTERNAL_OSINT',
  offset = 0,
  count = 20,
  fetchFn: typeof fetch = globalThis.fetch,
  parentSignal?: AbortSignal
): Promise<{ response: BraveSearchResponse; status: number; cost: number | null }> {
  const req = buildBraveSearchRequest(query, country, language, mode, offset, count);
  const configuredCostStr = process.env.BRAVE_COST_PER_REQUEST_USD || (process.env.DATABASE_URL ? await getAppSetting('brave_cost_per_request_usd', '') : '');
  const costPerReqUsd = configuredCostStr.trim() ? Number(configuredCostStr) : null;
  const controller = new AbortController();
  const timeoutMs = Math.max(1, Number(process.env.BRAVE_TIMEOUT_MS || 10000));
  const deadline = new Promise<never>((_, reject) => setTimeout(() => {
    controller.abort();
    reject(new BraveProviderError('BRAVE_API_TIMEOUT', 'Brave Search API deadline exceeded', { retryable: true }));
  }, timeoutMs));
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  try {
    const res = await Promise.race([
      fetchFn(req.url, { method: 'GET', headers: req.headers, signal: controller.signal }),
      deadline
    ]);
    if (res.status === 429) {
      const reset = Number(res.headers.get('X-RateLimit-Reset') || 0);
      throw new BraveProviderError('BRAVE_API_RATE_LIMIT_429', 'BRAVE_API_RATE_LIMIT_429: Brave Search API rate limit', { status: 429, retryAfterMs: Number.isFinite(reset) && reset > 0 ? reset * 1000 : 1000, retryable: true });
    }
    if (res.status === 401 || res.status === 403) throw new BraveProviderError('BRAVE_API_AUTHENTICATION_FAILURE', `Brave Search API authentication failed: ${res.status}`, { status: res.status });
    if (res.status >= 500) throw new BraveProviderError(`BRAVE_API_HTTP_${res.status}`, `Brave Search API server failure: ${res.status}`, { status: res.status, retryable: true });
    if (!res.ok) throw new BraveProviderError(`BRAVE_API_HTTP_${res.status}`, `Brave Search API HTTP failure: ${res.status}`, { status: res.status });
    let json: BraveSearchResponse;
    try { json = (await res.json()) as BraveSearchResponse; }
    catch { throw new BraveProviderError('BRAVE_API_MALFORMED_RESPONSE', 'Brave Search API returned malformed JSON'); }
    if (!json || typeof json !== 'object' || (json.web?.results !== undefined && !Array.isArray(json.web.results))) throw new BraveProviderError('BRAVE_API_MALFORMED_RESPONSE', 'Brave Search API response shape is invalid');
    return { response: json, status: res.status, cost: costPerReqUsd !== null && Number.isFinite(costPerReqUsd) ? costPerReqUsd : null };
  } catch (error: any) {
    if (error instanceof BraveProviderError) throw error;
    if (error?.name === 'AbortError') throw new BraveProviderError('BRAVE_API_TIMEOUT', 'Brave Search API aborted', { retryable: true });
    throw new BraveProviderError('BRAVE_API_NETWORK_FAILURE', String(error?.message || error), { retryable: true });
  }
}

/**
 * Staging logic: converts raw Brave Search items into staged candidates.
 */
export function extractCandidatesFromBraveResponse(
  response: BraveSearchResponse,
  mode: 'DIRECT_YOUTUBE' | 'EXTERNAL_OSINT'
): NormalizedBraveCandidate[] {
  const results = response.web?.results || [];
  const candidates: NormalizedBraveCandidate[] = [];

  for (const item of results) {
    const noiseEval = evaluateBraveCandidateNoise(item);
    if (noiseEval.isNoise) {
      continue;
    }

    const loc = normalizeYouTubeLocator(item.url);
    if (!loc || loc.isNoise) {
      continue;
    }

    // Direct mode must filter out non-YouTube URLs
    if (mode === 'DIRECT_YOUTUBE' && loc.candidateType === 'EXTERNAL_EVIDENCE') {
      continue;
    }

    loc.title = item.title;
    loc.snippet = item.description;
    loc.discoveryMode = mode;
    candidates.push(loc);
  }

  return candidates;
}

/**
 * Persists candidates to discovery_candidate_staging table.
 */
export async function stageDiscoveredCandidates(
  candidates: NormalizedBraveCandidate[],
  context: {
    providerKey: string;
    retrievalSurface: string;
    providerCapability: string;
    queryRunId?: string | null;
    opportunityKey?: string | null;
    country: string;
    language?: string | null;
    neighborhoodKey?: string | null;
    client?: any;
  }
): Promise<{ stagedCount: number; duplicateCount: number }> {
  if (candidates.length === 0) return { stagedCount: 0, duplicateCount: 0 };

  const db = context.client || (process.env.DATABASE_URL ? await getDb() : null);
  if (!db) return { stagedCount: candidates.length, duplicateCount: 0 };

  let stagedCount = 0;
  let duplicateCount = 0;

  for (const cand of candidates) {
    const canonicalIdentity = cand.candidateType === 'CHANNEL_ID'
      ? `YOUTUBE_CHANNEL:${cand.normalizedIdentity}`
      : `${cand.candidateType}:${cand.normalizedIdentity.toLowerCase()}`;
    const canonicalCandidateKey = createHash('sha256').update(canonicalIdentity).digest('hex');
    const observationKey = createHash('sha256').update([
      canonicalCandidateKey, context.providerKey, context.retrievalSurface,
      context.queryRunId || '', context.opportunityKey || '', context.country,
      context.language || '', context.neighborhoodKey || '', cand.rawLocator
    ].join('|')).digest('hex');
    const derivedMetadata = {
      confidence: cand.confidence,
      titleDigest: cand.title ? createHash('sha256').update(cand.title).digest('hex') : null,
      snippetDigest: cand.snippet ? createHash('sha256').update(cand.snippet).digest('hex') : null,
      rawLocatorDigest: createHash('sha256').update(cand.rawLocator).digest('hex')
    };

    try {
      const res = await db.query(
        `INSERT INTO discovery_candidate_staging(
           staging_key, canonical_candidate_key, provider_key, retrieval_surface, provider_capability, candidate_type,
           normalized_identity, raw_locator, query_run_id, opportunity_key, country, language,
           neighborhood_key, discovery_mode, provenance, resolution_status, validation_status, metadata
         )
         VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
         ON CONFLICT (staging_key) DO UPDATE SET updated_at=now()
         RETURNING id, (xmax=0) AS inserted`,
        [
          canonicalCandidateKey,
          canonicalCandidateKey,
          context.providerKey,
          context.retrievalSurface,
          context.providerCapability,
          cand.candidateType,
          cand.normalizedIdentity,
          cand.candidateType === 'EXTERNAL_EVIDENCE' ? cand.normalizedIdentity : cand.rawLocator,
          context.queryRunId || null,
          context.opportunityKey || null,
          context.country,
          context.language || null,
          context.neighborhoodKey || null,
          cand.discoveryMode,
          JSON.stringify({ confidence: cand.confidence, canonicalIdentity }),
          cand.candidateType === 'CHANNEL_ID' ? 'RESOLVED' : 'PENDING',
          'UNVALIDATED',
          JSON.stringify(derivedMetadata)
        ]
      );
      const stagingId = res.rows?.[0]?.id;
      if (!stagingId) throw new Error('CANDIDATE_STAGING_ID_MISSING');
      await db.query(
        `INSERT INTO discovery_candidate_observations(
           observation_key, staging_id, canonical_candidate_key, provider_key, retrieval_surface,
           provider_capability, candidate_type, normalized_identity, raw_locator, query_run_id,
           opportunity_key, country, language, neighborhood_key, discovery_mode, provenance, metadata
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT(observation_key) DO NOTHING`,
        [observationKey, stagingId, canonicalCandidateKey, context.providerKey, context.retrievalSurface,
          context.providerCapability, cand.candidateType, cand.normalizedIdentity,
          cand.candidateType === 'EXTERNAL_EVIDENCE' ? cand.normalizedIdentity : cand.rawLocator,
          context.queryRunId || null, context.opportunityKey || null, context.country,
          context.language || null, context.neighborhoodKey || null, cand.discoveryMode,
          JSON.stringify({ provider: context.providerKey, confidence: cand.confidence, canonicalIdentity }),
          JSON.stringify(derivedMetadata)]
      );
      if (res.rows?.[0]?.inserted === true || res.rows?.[0]?.inserted === 'true') stagedCount++;
      else duplicateCount++;
    } catch (err) {
      console.error('[BraveSearch] Critical staging insert failure:', err);
      throw err;
    }
  }

  return { stagedCount, duplicateCount };
}

/**
 * Adapter executor function registered with registerRetrievalExecutor.
 */
export async function executeBraveSearchRetrieval(
  request: RetrievalRequest,
  clientOverride?: any
): Promise<RetrievalPage> {
  const ctrl = await checkBraveControlPlane(clientOverride);
  if (!ctrl.allowed) {
    throw new Error(`BRAVE_PROVIDER_DISABLED: ${ctrl.reason}`);
  }

  const mode: 'DIRECT_YOUTUBE' | 'EXTERNAL_OSINT' =
    request.provider.retrievalSurface === 'BRAVE_EXTERNAL_OSINT' ? 'EXTERNAL_OSINT' : 'DIRECT_YOUTUBE';

  const offset = request.cursor ? Number(request.cursor) : 0;
  const count = 20;

  try {
    const { response, cost } = await fetchBraveSearchResults(
      request.query,
      request.country,
      request.vocabulary?.languages?.[0],
      mode,
      offset,
      count
    );

    const candidates = extractCandidatesFromBraveResponse(response, mode);

    await stageDiscoveredCandidates(candidates, {
      providerKey: request.provider.providerKey,
      retrievalSurface: request.provider.retrievalSurface,
      providerCapability: request.provider.capability,
      queryRunId: request.queryRunId || null,
      country: request.country,
      language: request.vocabulary?.languages?.[0],
      neighborhoodKey: null,
      client: clientOverride
    });

    // Brave documents page-style offset semantics and exposes an explicit continuation flag.
    // Never infer continuation from candidate count or run unbounded offsets.
    const nextOffset = offset + 1;
    const maxOffset = Math.max(0, Number(process.env.BRAVE_MAX_OFFSET || 9));
    const nextPageToken = response.query?.more_results_available === true && nextOffset <= maxOffset ? String(nextOffset) : null;

    // SHADOW mode: records observations & stages candidates without returning active channels
    if (ctrl.mode === 'SHADOW') {
      return {
        channels: [],
        rawResultCount: response.web?.results?.length || 0,
        nextPageToken,
        providerCostUsd: cost,
        providerRequestId: request.queryRunId ? `${request.queryRunId}:${offset}` : undefined
      };
    }

    const channels: DiscoveredChannelRaw[] = candidates
      .filter((c) => c.candidateType === 'CHANNEL_ID')
      .map((c) => ({
        channelId: c.normalizedIdentity,
        channelName: c.title || c.normalizedIdentity,
        youtubeUrl: `https://www.youtube.com/channel/${c.normalizedIdentity}`,
        description: c.snippet || '',
        videoTitles: [],
        publishedAt: new Date().toISOString(),
        thumbnailUrl: '',
        country: request.country
      }));

    return {
      channels,
      rawResultCount: response.web?.results?.length || 0,
      nextPageToken,
      providerCostUsd: cost,
      providerRequestId: request.queryRunId ? `${request.queryRunId}:${offset}` : undefined
    };
  } catch (err) {
    console.error('[BraveSearch] Retrieval execution error:', err);
    throw err;
  }
}

// Register default executors for Brave search provider capabilities
registerRetrievalExecutor(BRAVE_DIRECT_PROVIDER, executeBraveSearchRetrieval);
registerRetrievalExecutor(BRAVE_OSINT_PROVIDER, executeBraveSearchRetrieval);
