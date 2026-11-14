import { getAppSetting, getCountryVocabularies, getDb, getQueriesByCountry, setAppSetting } from './db';
import { countryDiscoveryLanguagesByWeight, countryDiscoveryRegionCode } from './countryDiscoveryProfile';
import { assertCountryAllowed } from './countryExclusion';
import { assessGeneratedNativeQuery, type NativeQueryCandidate } from './nativeQueryGeneration';
import { getCandidateMemory, getGenerationBatch, queryGenerationBatchKey, rememberQueryCandidates, upsertGenerationBatch } from './queryGenerationMemory';
import { dedupeCandidateBatch, normalizeCandidateText, type CandidateHistoryItem } from './queryDuplicateGuard';

export const YOUTUBE_AUTOCOMPLETE_PROVIDER = 'youtube-autocomplete';
export const YOUTUBE_AUTOCOMPLETE_TTL_DAYS = 7;
export const YOUTUBE_AUTOCOMPLETE_MAX_PREFIXES = 20;

export interface AutocompleteSuggestion {
  query: string;
  rank: number;
}

function parseAutocompleteJson(text: string): string[] {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed) || !Array.isArray(parsed[1])) return [];
    return parsed[1].map(String).filter(Boolean);
  } catch {
    return [];
  }
}

/** One bounded Google/YouTube autocomplete request. No retries; failures are cache misses. */
export async function fetchYouTubeAutocomplete(
  prefix: string,
  options: { language: string; regionCode?: string; timeoutMs?: number; fetchImpl?: typeof fetch },
): Promise<string[]> {
  const clean = prefix.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (!clean) return [];
  const url = new URL('https://suggestqueries.google.com/complete/search');
  url.searchParams.set('client', 'firefox');
  url.searchParams.set('ds', 'yt');
  url.searchParams.set('q', clean);
  url.searchParams.set('ie', 'utf-8');
  url.searchParams.set('oe', 'utf-8');
  url.searchParams.set('hl', options.language);
  if (options.regionCode) url.searchParams.set('gl', options.regionCode);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, options.timeoutMs ?? 5000));
  try {
    const response = await (options.fetchImpl || fetch)(url.toString(), {
      signal: controller.signal,
      headers: { 'User-Agent': 'TradingDiscoveryEngine/1.0 (+https://github.com/lastdayone87-del/trading-discovery-engine)' },
    });
    if (!response.ok) return [];
    // `response.text()` always decodes as UTF-8. The suggest endpoint can
    // return another declared charset for some locales, so honor the response
    // charset and fall back to UTF-8 when it is absent or unsupported.
    const bytes = await response.arrayBuffer();
    const charset = /charset=([^;]+)/i.exec(response.headers.get('content-type') || '')?.[1]?.trim().toLowerCase();
    let text: string;
    try {
      text = new TextDecoder(charset || 'utf-8').decode(bytes);
    } catch {
      text = new TextDecoder('utf-8').decode(bytes);
    }
    return parseAutocompleteJson(text);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function prefixPlan(country: string, language: string, existing: CandidateHistoryItem[], vocabulary: string[]): string[] {
  const candidates = [
    ...vocabulary,
    ...existing.map(item => item.query),
  ]
    .map(normalizeCandidateText)
    .filter(prefix => prefix.length >= 2 && prefix.length <= 60)
    .filter(prefix => /[\p{L}\p{N}]/u.test(prefix));
  return [...new Set(candidates)];
}

async function localVocabulary(country: string): Promise<string[]> {
  try {
    const vocabularies = await getCountryVocabularies();
    const vocabulary = vocabularies.find(item => item.country.toLowerCase() === country.toLowerCase());
    if (!vocabulary) return [];
    return [...new Set([
      ...(vocabulary.native_trading_terminology || []),
      ...(vocabulary.popular_instruments || []),
      ...(vocabulary.local_market_phrases || []),
      ...(vocabulary.common_content_format_names || []),
    ].map(String).filter(Boolean))];
  } catch {
    return [];
  }
}

/** Cached real suggestions used as context for grounded/open-world LLM prompts. */
export async function getCachedAutocompleteSuggestions(country: string, language: string, limit = 100): Promise<string[]> {
  try {
    const db = await getDb();
    const result = await db.query(
      `SELECT payload->'suggestions' AS suggestions
       FROM query_generation_batches
       WHERE LOWER(country)=LOWER($1) AND language=$2 AND source='AUTOCOMPLETE'
         AND expires_at > now()
       ORDER BY generated_at DESC LIMIT 40`,
      [country, language],
    );
    const out = new Set<string>();
    for (const row of result.rows) {
      if (!Array.isArray(row.suggestions)) continue;
      for (const suggestion of row.suggestions) {
        const value = String(suggestion || '').trim();
        if (value) out.add(value);
        if (out.size >= Math.max(1, Math.min(200, limit))) break;
      }
      if (out.size >= Math.max(1, Math.min(200, limit))) break;
    }
    return [...out];
  } catch {
    return [];
  }
}

export interface AutocompleteGenerationResult {
  candidates: NativeQueryCandidate[];
  prefixesAttempted: number;
  cacheHits: number;
}

/**
 * Real YouTube autocomplete discovery. Suggestions are cached per prefix and
 * only validated, normalized, de-duplicated candidates leave this module.
 * They become COUNTRY_NATIVE proposals; this function never writes query_library.
 */
export async function generateAutocompleteQueries(input: {
  country: string;
  limit?: number;
  fetchAutocomplete?: typeof fetchYouTubeAutocomplete;
}): Promise<AutocompleteGenerationResult> {
  const country = input.country;
  await assertCountryAllowed(country, 'youtube_autocomplete');
  const enabled = await getAppSetting(
    'youtube_autocomplete_enabled',
    process.env.NODE_ENV === 'production' ? 'true' : 'false',
  );
  if (String(enabled).trim().toLowerCase() !== 'true') {
    return { candidates: [], prefixesAttempted: 0, cacheHits: 0 };
  }
  const languages = countryDiscoveryLanguagesByWeight(country);
  if (!languages.length) return { candidates: [], prefixesAttempted: 0, cacheHits: 0 };
  const cursorKey = `youtube_autocomplete_cursor:${country}`;
  const cursor = Math.max(0, Number(await getAppSetting(cursorKey, '0')) || 0);
  const language = languages[cursor % languages.length];
  const lastAttemptKey = `youtube_autocomplete_last_attempt:${country}`;
  const lastAttempt = Date.parse(await getAppSetting(lastAttemptKey, ''));
  if (Number.isFinite(lastAttempt) && Date.now() - lastAttempt < 6 * 60 * 60 * 1000) {
    return { candidates: [], prefixesAttempted: 0, cacheHits: 0 };
  }
  // Advance the language turn only when generation is actually attempted.
  await setAppSetting(cursorKey, String(cursor + 1)).catch(() => undefined);
  await setAppSetting(lastAttemptKey, new Date().toISOString()).catch(() => undefined);

  const existing = (await getQueriesByCountry(country)).map(query => ({
    query: query.query,
    country: query.country,
    intent: query.intent,
  }));
  const memory = await getCandidateMemory(country, language.code).catch(() => []);
  const acceptedHistory: CandidateHistoryItem[] = [];
  const allPrefixes = prefixPlan(country, language.code, existing, await localVocabulary(country));
  const prefixCursorKey = `youtube_autocomplete_prefix_cursor:${country}`;
  const prefixCursor = Math.max(0, Number(await getAppSetting(prefixCursorKey, '0')) || 0);
  const rotated = allPrefixes.length > YOUTUBE_AUTOCOMPLETE_MAX_PREFIXES
    ? [...allPrefixes.slice(prefixCursor % allPrefixes.length), ...allPrefixes.slice(0, prefixCursor % allPrefixes.length)]
    : allPrefixes;
  const prefixes = rotated.slice(0, YOUTUBE_AUTOCOMPLETE_MAX_PREFIXES);
  const regionCode = countryDiscoveryRegionCode(country);
  const fetchAutocomplete = input.fetchAutocomplete || fetchYouTubeAutocomplete;
  const accepted: NativeQueryCandidate[] = [];
  let cacheHits = 0;
  let prefixesAttempted = 0;

  for (const prefix of prefixes) {
    prefixesAttempted += 1;
    const prefixDigest = JSON.stringify({ country, language: language.code, regionCode: regionCode || null, prefix });
    const batchKey = queryGenerationBatchKey({
      country,
      language: language.code,
      source: 'AUTOCOMPLETE',
      mode: 'REAL_SIGNAL',
      promptVersion: 'youtube-autocomplete-v1',
      contextDigest: prefixDigest,
    });
    let suggestions: string[] = [];
    let cachedGeneratedAt: string | null = null;
    const cached = await getGenerationBatch(batchKey).catch(() => null);
    if (cached && Array.isArray(cached.suggestions)) {
      suggestions = cached.suggestions.map(String);
      cachedGeneratedAt = typeof cached.generatedAt === 'string' ? cached.generatedAt : null;
      cacheHits += 1;
    } else {
      suggestions = await fetchAutocomplete(prefix, { language: language.code, regionCode });
      // Do not cache a provider/network failure as a seven-day empty result.
      // A successful empty response is left uncached until the negative-cache
      // path has an explicit success/failure signal.
      if (suggestions.length > 0) {
        await upsertGenerationBatch({
          batchKey,
          country,
          language: language.code,
          source: 'AUTOCOMPLETE',
          mode: 'REAL_SIGNAL',
          provider: YOUTUBE_AUTOCOMPLETE_PROVIDER,
          model: null,
          promptVersion: 'youtube-autocomplete-v1',
          inputFingerprint: prefixDigest,
          payload: { suggestions, prefix, regionCode: regionCode || null, generatedAt: new Date().toISOString() },
          acceptedCount: 0,
          expiresAt: new Date(Date.now() + YOUTUBE_AUTOCOMPLETE_TTL_DAYS * 86_400_000).toISOString(),
          status: 'COMPLETED',
        }).catch(() => undefined);
      }
    }
    const assessed: NativeQueryCandidate[] = [];
    for (const suggestion of suggestions) {
      const candidate = assessGeneratedNativeQuery({
        query: suggestion,
        country,
        language: language.code,
        intent: 'strategy',
        confidence: 0.7,
        source: 'AUTOCOMPLETE',
        mode: 'REAL_SIGNAL',
        provider: YOUTUBE_AUTOCOMPLETE_PROVIDER,
        model: null,
        batchId: batchKey,
        persona: null,
        scenario: `autocomplete prefix: ${prefix}`,
        prefix,
        promptVersion: 'youtube-autocomplete-v1',
        generatedAt: cachedGeneratedAt,
      });
      if (candidate) assessed.push(candidate);
    }
    const prefixHistory: CandidateHistoryItem[] = [
      ...existing,
      ...memory
        .filter(row => row.batchKey !== batchKey)
        .map(row => ({ query: row.normalizedQuery, country, intent: null })),
      ...acceptedHistory,
    ];
    const deduped = dedupeCandidateBatch(assessed, prefixHistory);
    for (const candidate of deduped.accepted) {
      accepted.push(candidate);
      acceptedHistory.push({ query: candidate.query, country, intent: candidate.intent });
    }
    await rememberQueryCandidates([
      ...deduped.accepted.map(candidate => ({
        country,
        language: language.code,
        source: 'AUTOCOMPLETE' as const,
        mode: 'REAL_SIGNAL' as const,
        query: candidate.query,
        status: 'PROPOSED' as const,
        batchKey,
        metadata: { prefix, regionCode: regionCode || null },
      })),
      ...deduped.rejected.map(item => ({
        country,
        language: language.code,
        source: 'AUTOCOMPLETE' as const,
        mode: 'REAL_SIGNAL' as const,
        query: item.candidate.query,
        status: 'REJECTED' as const,
        reasonCodes: [item.decision.class || 'DUPLICATE'],
        batchKey,
        metadata: { prefix, regionCode: regionCode || null },
      })),
    ]).catch(() => 0);
    if (accepted.length >= Math.max(1, input.limit ?? 20)) break;
  }

  if (prefixesAttempted > 0) {
    await setAppSetting(prefixCursorKey, String(prefixCursor + prefixesAttempted)).catch(() => undefined);
  }
  return {
    candidates: accepted.slice(0, Math.max(1, input.limit ?? 20)),
    prefixesAttempted,
    cacheHits,
  };
}
