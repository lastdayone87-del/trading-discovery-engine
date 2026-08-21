import { createHash } from 'node:crypto';
import { getDb } from './db';
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
  retrievalSurface: 'BRAVE_YOUTUBE_DIRECT',
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
 */
export async function checkBraveControlPlane(clientOverride?: any): Promise<BraveControlPlaneStatus> {
  // Emergency env kill switch check
  if (process.env.BRAVE_KILL_SWITCH === 'true') {
    return { allowed: false, reason: 'EMERGENCY_ENV_KILL_SWITCH', killSwitchActive: true, mode: 'OFF', dailyCapReached: false, backlogThresholdExceeded: false };
  }

  const db = clientOverride || (process.env.DATABASE_URL ? await getDb() : null);
  if (!db) {
    return { allowed: false, reason: 'CONTROL_PLANE_UNAVAILABLE_FAIL_CLOSED', killSwitchActive: false, mode: 'OFF', dailyCapReached: false, backlogThresholdExceeded: false };
  }

  try {
    const [settingsRes, regRes, backlogRes, dailyReqRes] = await Promise.all([
      db.query(`SELECT setting_key, setting_value FROM app_settings WHERE setting_key LIKE 'brave_%'`),
      db.query(`SELECT mode FROM discovery_provider_registry WHERE provider_key = $1`, [BRAVE_SEARCH_PROVIDER_KEY]),
      db.query(`SELECT COUNT(*)::int AS backlog_count FROM discovery_candidate_staging WHERE resolution_status = 'PENDING'`),
      db.query(`SELECT COUNT(*)::int AS daily_requests FROM query_runs WHERE provider_key = $1 AND created_at >= CURRENT_DATE`, [BRAVE_SEARCH_PROVIDER_KEY])
    ]);

    const settingsMap = new Map<string, string>(settingsRes.rows.map((r: any) => [r.setting_key, r.setting_value]));
    const regMode = regRes.rows[0]?.mode || 'OFF';

    if (settingsMap.get('brave_kill_switch') === 'true' || regMode === 'OFF' || regMode === 'PAUSED' || regMode === 'RETIRED') {
      return { allowed: false, reason: 'KILL_SWITCH_OR_DISABLED_MODE', killSwitchActive: true, mode: regMode, dailyCapReached: false, backlogThresholdExceeded: false };
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
  const searchLang = (language || 'en').toLowerCase().trim();
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
      'X-Subscription-Token': apiKey
    }
  };
}

/**
 * Executes a single Brave Search API request with resilience, error handling, and accounting.
 */
export async function fetchBraveSearchResults(
  query: string,
  country: string,
  language: string | null | undefined,
  mode: 'DIRECT_YOUTUBE' | 'EXTERNAL_OSINT',
  offset = 0,
  count = 20,
  fetchFn: typeof fetch = globalThis.fetch
): Promise<{ response: BraveSearchResponse; status: number; cost: number | null }> {
  const req = buildBraveSearchRequest(query, country, language, mode, offset, count);
  const configuredCostStr = process.env.BRAVE_COST_PER_REQUEST_USD;
  const costPerReqUsd = configuredCostStr ? Number(configuredCostStr) : null;

  const res = await fetchFn(req.url, {
    method: 'GET',
    headers: req.headers
  });

  if (res.status === 429) {
    throw new Error('BRAVE_API_RATE_LIMIT_429');
  }

  if (!res.ok) {
    throw new Error(`BRAVE_API_ERROR_HTTP_${res.status}`);
  }

  const json = (await res.json()) as BraveSearchResponse;
  return {
    response: json,
    status: res.status,
    cost: costPerReqUsd && Number.isFinite(costPerReqUsd) ? costPerReqUsd : null
  };
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
    const stagingKey = createHash('sha256')
      .update(`${context.providerKey}:${cand.candidateType}:${cand.normalizedIdentity}:${context.country}`)
      .digest('hex')
      .slice(0, 32);

    try {
      const res = await db.query(
        `INSERT INTO discovery_candidate_staging(
           staging_key, provider_key, retrieval_surface, provider_capability, candidate_type,
           normalized_identity, raw_locator, query_run_id, opportunity_key, country, language,
           neighborhood_key, discovery_mode, provenance, resolution_status, validation_status, metadata
         )
         VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         ON CONFLICT (staging_key) DO NOTHING
         RETURNING id`,
        [
          stagingKey,
          context.providerKey,
          context.retrievalSurface,
          context.providerCapability,
          cand.candidateType,
          cand.normalizedIdentity,
          cand.rawLocator,
          context.queryRunId || null,
          context.opportunityKey || null,
          context.country,
          context.language || null,
          context.neighborhoodKey || null,
          cand.discoveryMode,
          JSON.stringify({ confidence: cand.confidence }),
          cand.candidateType === 'CHANNEL_ID' ? 'RESOLVED' : 'PENDING',
          'UNVALIDATED', // Always staged as UNVALIDATED until trading/country validation
          JSON.stringify({ title: cand.title })
        ]
      );

      if (res.rowCount) {
        stagedCount++;
      } else {
        duplicateCount++;
      }
    } catch (err) {
      console.warn('[BraveSearch] Staging insert error:', err);
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
    const { response } = await fetchBraveSearchResults(
      request.query,
      request.country,
      request.vocabulary?.language,
      mode,
      offset,
      count
    );

    const candidates = extractCandidatesFromBraveResponse(response, mode);

    await stageDiscoveredCandidates(candidates, {
      providerKey: request.provider.providerKey,
      retrievalSurface: request.provider.retrievalSurface,
      providerCapability: request.provider.capability,
      country: request.country,
      language: request.vocabulary?.language,
      neighborhoodKey: null,
      client: clientOverride
    });

    const channels: DiscoveredChannelRaw[] = candidates
      .filter((c) => c.candidateType === 'CHANNEL_ID')
      .map((c) => ({
        channelId: c.normalizedIdentity,
        title: c.title || c.normalizedIdentity,
        description: c.snippet || '',
        publishedAt: new Date().toISOString(),
        thumbnailUrl: '',
        country: request.country
      }));

    const nextOffset = offset + count;
    const totalResults = response.web?.total || 0;
    const nextPageToken = nextOffset < totalResults && candidates.length > 0 ? String(nextOffset) : null;

    return {
      channels,
      rawResultCount: response.web?.results?.length || 0,
      nextPageToken
    };
  } catch (err) {
    console.error('[BraveSearch] Retrieval execution error:', err);
    throw err;
  }
}

// Register default executors for Brave search provider capabilities
registerRetrievalExecutor(BRAVE_DIRECT_PROVIDER, executeBraveSearchRetrieval);
registerRetrievalExecutor(BRAVE_OSINT_PROVIDER, executeBraveSearchRetrieval);
