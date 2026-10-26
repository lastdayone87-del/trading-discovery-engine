import { getDb } from './db';
import { canonicalCountry } from './countryInference';
import { countrySearchLanguageCandidates } from './countrySearchHints';

/**
 * Free query signals (Wikipedia/Wikidata) are candidate vocabulary only.
 * They never create terminology observations, never set promotion_eligible,
 * and never change lifecycle state. The planner may use a stored alias/entity
 * as a query atom with explicit source attribution.
 */
export type FreeSignalType =
  | 'ALIAS' | 'INSTRUMENT' | 'ENTITY' | 'MARKET' | 'METHOD' | 'FORMAT' | 'REGULATOR' | 'EXCHANGE';
export type FreeSignalProvider = 'WIKIPEDIA' | 'WIKIDATA';

export interface FreeQuerySignal {
  country: string;
  language: string;
  surface: string;
  normalizedSurface: string;
  signalType: FreeSignalType;
  provider: FreeSignalProvider;
  providerSignalId?: string | null;
  sourceUrl?: string | null;
  metadata?: Record<string, unknown>;
  fetchedAt?: string;
  expiresAt?: string | null;
}

export interface FreeSignalQueryCandidate {
  surface: string;
  signalType: FreeSignalType;
  country: string;
  language: string;
  provider: FreeSignalProvider;
  sourceIds: string[];
  sourceUrl?: string | null;
}

export interface FreeSignalFetchResult {
  signals: FreeQuerySignal[];
  degraded: boolean;
  error?: string;
  fromCache?: boolean;
}

const GENERIC_SURFACES = new Set([
  'trading', 'stock market', 'stock exchange', 'finance', 'financial market',
  'investment', 'investor', 'market', 'bourse', 'exchange', 'broker',
  'trader', 'day trading', 'forex', 'futures', 'options', 'cryptocurrency',
  'trading strategy', 'technical analysis', 'fundamental analysis',
]);

export function normalizeFreeSignalSurface(value: string): string {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLocaleLowerCase('en');
}

function isUsableSurface(value: string): boolean {
  const normalized = normalizeFreeSignalSurface(value);
  if (normalized.length < 2 || normalized.length > 80) return false;
  if (GENERIC_SURFACES.has(normalized)) return false;
  // Avoid prose fragments and sentences; page titles/aliases are short noun
  // surfaces. A long title with sentence punctuation is not a query atom.
  if (/[.!?;:]\s/.test(value) || normalized.split(/\s+/u).length > 5) return false;
  return true;
}

function classifySurface(surface: string): FreeSignalType {
  const normalized = normalizeFreeSignalSurface(surface);
  if (/(exchange|börse|bourse|bolsa|beurs| بورصة)/iu.test(surface)) return 'EXCHANGE';
  if (/(regulator|commission|authority|regulier|regulador|aufsicht)/iu.test(surface)) return 'REGULATOR';
  if (/(futures|options|forex|index|indices|aktie|acao|ação|action|titre|anleihe|obligation|etf)/iu.test(surface)) return 'INSTRUMENT';
  if (/(market|marché|markt|mercado|mercat|session)/iu.test(surface)) return 'MARKET';
  if (/(strategy|analyse|analysis|analysis|methode|méthode|método|scalping|swing)/iu.test(surface)) return 'METHOD';
  if (/(format|journal|podcast|live|webinar|newsletter)/iu.test(surface)) return 'FORMAT';
  if (/\b(alias|aka|also known as)\b/iu.test(surface)) return 'ALIAS';
  return 'ENTITY';
}

function providerSignalId(provider: FreeSignalProvider, value: unknown): string | null {
  // Wikipedia returns `pageid` as a JSON number; Wikidata returns a string id.
  // Both are stable provider identities, so accept either scalar form.
  if (typeof value === 'number') return Number.isFinite(value) ? `${provider.toLowerCase()}:${value}` : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  return `${provider.toLowerCase()}:${value.trim()}`;
}

/**
 * Parse a Wikipedia Action API `list=search` response. Only real page titles
 * and snippets supplied by the provider are considered; no alias is invented.
 */
export function parseWikipediaSearchSignals(
  payload: unknown,
  args: { country: string; language: string; limit?: number },
): FreeQuerySignal[] {
  const rows = (payload as { query?: { search?: unknown } } | null)?.query?.search;
  if (!Array.isArray(rows)) return [];
  const country = canonicalCountry(args.country);
  const language = String(args.language || 'en').split('-')[0].toLowerCase();
  const limit = Math.max(1, Math.min(50, Math.trunc(args.limit || 10)));
  const out: FreeQuerySignal[] = [];
  for (const row of rows.slice(0, limit)) {
    if (!row || typeof row !== 'object') continue;
    const title = (row as { title?: unknown }).title;
    if (typeof title !== 'string' || !isUsableSurface(title)) continue;
    const pageId = (row as { pageid?: unknown }).pageid;
    out.push({
      country,
      language,
      surface: title.normalize('NFKC').trim().replace(/\s+/gu, ' '),
      normalizedSurface: normalizeFreeSignalSurface(title),
      signalType: classifySurface(title),
      provider: 'WIKIPEDIA',
      providerSignalId: providerSignalId('WIKIPEDIA', pageId),
      sourceUrl: `https://${language}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/\s+/gu, '_'))}`,
      metadata: { snippet: typeof (row as { snippet?: unknown }).snippet === 'string' ? (row as { snippet: string }).snippet : null },
    });
  }
  return out;
}

/**
 * Parse a Wikidata `wbsearchentities` response. Labels and aliases are
 * accepted only when literally present; descriptions are metadata, never a
 * query surface. A translated/English description cannot create a local term.
 */
export function parseWikidataSearchSignals(
  payload: unknown,
  args: { country: string; language: string; limit?: number },
): FreeQuerySignal[] {
  const rows = (payload as { search?: unknown } | null)?.search;
  if (!Array.isArray(rows)) return [];
  const country = canonicalCountry(args.country);
  const language = String(args.language || 'en').split('-')[0].toLowerCase();
  const limit = Math.max(1, Math.min(50, Math.trunc(args.limit || 10)));
  const out: FreeQuerySignal[] = [];
  for (const row of rows.slice(0, limit)) {
    if (!row || typeof row !== 'object') continue;
    const id = (row as { id?: unknown }).id;
    const label = (row as { label?: unknown }).label;
    const aliases = (row as { aliases?: unknown }).aliases;
    const surfaces: string[] = [];
    if (typeof label === 'string' && isUsableSurface(label)) surfaces.push(label);
    if (Array.isArray(aliases)) {
      for (const alias of aliases) {
        const value = typeof alias === 'string' ? alias : (alias as { value?: unknown } | null)?.value;
        if (typeof value === 'string' && isUsableSurface(value)) surfaces.push(value);
      }
    }
    for (const surface of [...new Set(surfaces.map(s => s.normalize('NFKC').trim().replace(/\s+/gu, ' ')))]) {
      out.push({
        country,
        language,
        surface,
        normalizedSurface: normalizeFreeSignalSurface(surface),
        signalType: classifySurface(surface),
        provider: 'WIKIDATA',
        providerSignalId: providerSignalId('WIKIDATA', id),
        sourceUrl: typeof id === 'string' ? `https://www.wikidata.org/wiki/${encodeURIComponent(id)}` : null,
        metadata: {
          description: typeof (row as { description?: unknown }).description === 'string' ? (row as { description: string }).description : null,
        },
      });
    }
  }
  return out;
}

/** Idempotent identity: provider signal id when present, otherwise the
 * normalized surface + type. Syndicated/reposted copies collapse. */
export function dedupeFreeQuerySignals(signals: FreeQuerySignal[]): FreeQuerySignal[] {
  const seen = new Set<string>();
  const out: FreeQuerySignal[] = [];
  for (const signal of signals) {
    const key = [
      canonicalCountry(signal.country),
      normalizeFreeSignalSurface(signal.surface),
      signal.signalType,
      signal.provider,
      signal.providerSignalId || '',
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...signal, country: canonicalCountry(signal.country) });
  }
  return out;
}

/**
 * Ranking cap: free-signal-only candidates may never crowd out creator-
 * observed/learned terminology. At most one third of the requested portfolio
 * (minimum one) is reserved for free signals; creator-observed candidates
 * keep priority by construction.
 */
export function capFreeSignalCandidates<T>(
  freeSignals: T[],
  count: number,
  creatorObservedCount: number,
): T[] {
  if (!freeSignals.length) return [];
  const requested = Math.max(1, Math.trunc(count) || 1);
  const cap = Math.max(1, Math.floor(requested / 3));
  const creatorReserve = creatorObservedCount > 0 ? Math.min(creatorObservedCount, requested - cap) : 0;
  const available = Math.max(0, requested - creatorReserve);
  return freeSignals.slice(0, Math.min(cap, available || cap));
}

export function freeSignalToQueryCandidates(signals: FreeQuerySignal[]): FreeSignalQueryCandidate[] {
  return signals.map(signal => ({
    surface: signal.surface,
    signalType: signal.signalType,
    country: canonicalCountry(signal.country),
    language: signal.language,
    provider: signal.provider,
    sourceIds: signal.providerSignalId ? [signal.providerSignalId] : [`${signal.provider}:${signal.normalizedSurface}`],
    sourceUrl: signal.sourceUrl || null,
  }));
}

interface CacheEntry { at: number; result: FreeSignalFetchResult }
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
let nextRequestAtMs = 0;
const MIN_INTERVAL_MS = 1000;

/**
 * Wikimedia's User-Agent policy requires a descriptive agent with a real
 * contact URL or email. The deployment must provide one via the environment;
 * the fallback deliberately names the missing prerequisite instead of using a
 * fake address that would violate the policy.
 */
export const WIKIMEDIA_USER_AGENT_ENV = 'WIKIMEDIA_USER_AGENT';
export const WIKIMEDIA_USER_AGENT_FALLBACK =
  'CountryDiscoveryLoop/1.0 (Wikimedia API client; set WIKIMEDIA_USER_AGENT to a real contact URL or email before enabling free_query_signals_enabled)';

export function configuredWikimediaUserAgent(explicit?: string): string | null {
  const configured = String(explicit || process.env[WIKIMEDIA_USER_AGENT_ENV] || '').trim();
  return configured || null;
}

export function resolveWikimediaUserAgent(explicit?: string): string {
  return configuredWikimediaUserAgent(explicit) || WIKIMEDIA_USER_AGENT_FALLBACK;
}

export function resetFreeQuerySignalCacheForTests(): void {
  cache.clear();
  nextRequestAtMs = 0;
}

async function pace(): Promise<void> {
  // Reserve the slot synchronously, before any await: concurrent callers must
  // queue behind each other instead of all reading the same stale timestamp
  // and firing their requests at once.
  const slotMs = Math.max(Date.now(), nextRequestAtMs);
  nextRequestAtMs = slotMs + MIN_INTERVAL_MS;
  const waitMs = slotMs - Date.now();
  if (waitMs > 0) await new Promise<void>(resolve => setTimeout(resolve, waitMs));
}

function wikipediaSearchTerm(country: string, language: string): string {
  const local: Record<string, string> = {
    de: 'Börse Handel', fr: 'bourse trading', es: 'bolsa trading', it: 'borsa trading',
    nl: 'beurs handel', sv: 'börs handel', da: 'børs handel', no: 'børs handel',
    ja: '株式 トレード', zh: '股票 交易', ko: '주식 거래', ar: 'تداول الأسهم',
  };
  return local[language] || `${country} trading`;
}

async function fetchJson(url: string, fetchImpl: typeof fetch, timeoutMs: number, userAgent: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { 'User-Agent': userAgent, Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchFreeQuerySignals(args: {
  country: string;
  language?: string;
  limit?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
  now?: Date;
}): Promise<FreeSignalFetchResult> {
  const country = canonicalCountry(args.country);
  const language = String(args.language || countrySearchLanguageCandidates(country, [])[0] || 'en')
    .split('-')[0]
    .toLowerCase();
  const cacheKey = `${country}|${language}`;
  const now = args.now || new Date();
  const cached = cache.get(cacheKey);
  if (cached && now.getTime() - cached.at < CACHE_TTL_MS) {
    return { ...cached.result, fromCache: true };
  }
  const fetchImpl = args.fetchImpl || fetch;
  const userAgent = configuredWikimediaUserAgent(args.userAgent);
  // Wikimedia's User-Agent policy requires a real contact URL or email. Never
  // send a placeholder agent: without an operator-configured identity the
  // remote fetches are skipped and the caller falls back to terminology and
  // seeds. The health endpoint surfaces the missing prerequisite as a warning.
  if (!userAgent) {
    return {
      signals: [],
      degraded: true,
      error: `${WIKIMEDIA_USER_AGENT_ENV} is not configured; remote Wikimedia fetches are skipped to respect the User-Agent policy.`,
    };
  }
  const timeoutMs = Math.max(500, Math.min(10_000, args.timeoutMs || 5000));
  const limit = Math.max(1, Math.min(25, Math.trunc(args.limit || 8)));
  const signals: FreeQuerySignal[] = [];
  const errors: string[] = [];
  try {
    await pace();
    const wikiUrl = `https://${language}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(wikipediaSearchTerm(country, language))}&srlimit=${limit}&format=json&origin=*`;
    const payload = await fetchJson(wikiUrl, fetchImpl, timeoutMs, userAgent);
    signals.push(...parseWikipediaSearchSignals(payload, { country, language, limit }));
  } catch (error) {
    errors.push(`WIKIPEDIA:${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    await pace();
    const wikidataUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(`${country} trading`)}&language=${encodeURIComponent(language)}&uselang=${encodeURIComponent(language)}&limit=${limit}&format=json&origin=*`;
    const payload = await fetchJson(wikidataUrl, fetchImpl, timeoutMs, userAgent);
    signals.push(...parseWikidataSearchSignals(payload, { country, language, limit }));
  } catch (error) {
    errors.push(`WIKIDATA:${error instanceof Error ? error.message : String(error)}`);
  }
  const deduped = dedupeFreeQuerySignals(signals).map(signal => ({
    ...signal,
    fetchedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + CACHE_TTL_MS).toISOString(),
  }));
  const result: FreeSignalFetchResult = {
    signals: deduped,
    degraded: errors.length === 2,
    ...(errors.length ? { error: errors.join('; ') } : {}),
  };
  // A fully degraded fetch is not cached: caching it for 24h would suppress
  // recovery on the next cycle after a transient outage. A partially failed
  // fetch with usable signals is cached, but a partially failed fetch with an
  // empty result is not: the successful provider may simply have had no
  // matches while the failed one could recover on the next cycle.
  if (!result.degraded && (deduped.length > 0 || errors.length === 0)) {
    cache.set(cacheKey, { at: now.getTime(), result });
  }
  return result;
}

/** Persist free signals as candidate vocabulary. Never writes terminology
 * evidence; idempotent on (country, surface, type, provider, provider id). */
export async function persistFreeQuerySignals(signals: FreeQuerySignal[]): Promise<number> {
  if (!signals.length) return 0;
  const db = await getDb();
  let inserted = 0;
  for (const signal of dedupeFreeQuerySignals(signals)) {
    const result = await db.query(
      `INSERT INTO free_query_signals(country,language,signal_surface,normalized_surface,signal_type,provider,provider_signal_id,source_url,metadata,fetched_at,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (country, normalized_surface, signal_type, provider, (COALESCE(provider_signal_id, '')))
       DO UPDATE SET
         language=EXCLUDED.language,
         signal_surface=EXCLUDED.signal_surface,
         source_url=EXCLUDED.source_url,
         metadata=EXCLUDED.metadata,
         fetched_at=EXCLUDED.fetched_at,
         expires_at=EXCLUDED.expires_at
       RETURNING (xmax = 0) AS inserted`,
      [
        canonicalCountry(signal.country), signal.language, signal.surface, signal.normalizedSurface,
        signal.signalType, signal.provider, signal.providerSignalId || null, signal.sourceUrl || null,
        JSON.stringify(signal.metadata || {}), signal.fetchedAt || new Date().toISOString(),
        signal.expiresAt || null,
      ],
    );
    // Refresh existing signals in place (a stale signal must not stay stale for
    // its whole TTL), but report only rows this call actually inserted.
    inserted += (result.rows || []).filter(row => row.inserted === true).length;
  }
  return inserted;
}

export async function getStoredFreeQuerySignals(country: string, options: { freshOnly?: boolean } = {}): Promise<FreeQuerySignal[]> {
  const db = await getDb();
  const result = await db.query(
    `SELECT country,language,signal_surface,normalized_surface,signal_type,provider,provider_signal_id,source_url,metadata,fetched_at,expires_at
     FROM free_query_signals
     WHERE country=$1 AND ($2::boolean IS NOT TRUE OR expires_at IS NULL OR expires_at > now())
     ORDER BY fetched_at DESC, id DESC`,
    [canonicalCountry(country), options.freshOnly === true],
  );
  return result.rows.map((row: Record<string, unknown>) => ({
    country: String(row.country),
    language: String(row.language || 'und'),
    surface: String(row.signal_surface),
    normalizedSurface: String(row.normalized_surface),
    signalType: String(row.signal_type) as FreeSignalType,
    provider: String(row.provider) as FreeSignalProvider,
    providerSignalId: row.provider_signal_id ? String(row.provider_signal_id) : null,
    sourceUrl: row.source_url ? String(row.source_url) : null,
    metadata: (row.metadata && typeof row.metadata === 'object' ? row.metadata : {}) as Record<string, unknown>,
    fetchedAt: row.fetched_at ? new Date(row.fetched_at as string).toISOString() : undefined,
    expiresAt: row.expires_at ? new Date(row.expires_at as string).toISOString() : null,
  }));
}

/** Refresh one country's free signals, swallowing provider failure so the
 * discovery cycle always falls back to terminology + seeds. */
export async function refreshFreeQuerySignalsForCountry(country: string, options: {
  language?: string;
  limit?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
} = {}): Promise<FreeSignalFetchResult> {
  const result = await fetchFreeQuerySignals({ country, ...options });
  if (result.signals.length) await persistFreeQuerySignals(result.signals).catch(() => 0);
  return result;
}
