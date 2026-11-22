import { normalizeLanguageCode } from './languageCodes';
import { countryDiscoveryLanguageCandidates } from './countryDiscoveryProfile';

/**
 * YouTube Data API `relevanceLanguage` values verified against the live
 * provider on 2026-11-22. The provider rejects codes that are valid ISO 639-1
 * with HTTP 400 INVALID_ARGUMENT (`lb`, `mi`, and `ga` were verified failing),
 * so query generation may retain those languages while the provider request
 * must use a supported fallback.
 *
 * Keep this list explicit: `normalizeLanguageCode` validates language identity,
 * not provider capability. A single invalid code fails every search for that
 * country and must never be reintroduced silently.
 */
export const YOUTUBE_SUPPORTED_RELEVANCE_LANGUAGES: ReadonlySet<string> = new Set([
  'ar', 'da', 'de', 'en', 'es', 'fr', 'it', 'ja', 'ms', 'nl', 'no', 'sv', 'ta', 'zh',
]);

/**
 * Provider-safe fallbacks for languages used by country generation but not
 * accepted by YouTube's relevanceLanguage parameter. The fallback preserves
 * the country's market signal; it does not change query text or evidence.
 */
export const YOUTUBE_RELEVANCE_LANGUAGE_FALLBACKS: Readonly<Record<string, string>> = {
  lb: 'fr',
  mi: 'en',
  ga: 'en',
};

export interface ResolvedYouTubeRelevanceLanguage {
  language?: string;
  source?: string;
  fallback?: boolean;
}

/**
 * Resolve the first provider-supported language from an ordered candidate
 * list. An unsupported code is replaced only when an explicit fallback exists;
 * otherwise it is skipped. No candidate means the parameter is omitted rather
 * than sending an invalid value.
 */
export function resolveYouTubeRelevanceLanguage(
  candidates: Array<string | null | undefined>,
): ResolvedYouTubeRelevanceLanguage {
  for (const raw of candidates) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const normalized = normalizeLanguageCode(raw);
    if (!normalized) continue;
    if (YOUTUBE_SUPPORTED_RELEVANCE_LANGUAGES.has(normalized)) {
      return { language: normalized, source: raw };
    }
    const fallback = YOUTUBE_RELEVANCE_LANGUAGE_FALLBACKS[normalized];
    if (fallback && YOUTUBE_SUPPORTED_RELEVANCE_LANGUAGES.has(fallback)) {
      return { language: fallback, source: raw, fallback: true };
    }
  }
  return {};
}

/**
 * Whether any language this country may generate requires a provider fallback.
 * Used only by the one-time quarantine-recovery audit: a country whose entire
 * language set is provider-safe must never be touched by that cleanup.
 */
export function usesProviderLanguageFallback(country: string): boolean {
  return countryDiscoveryLanguageCandidates(country).some((candidate) => {
    const normalized = normalizeLanguageCode(candidate);
    return Boolean(normalized)
      && !YOUTUBE_SUPPORTED_RELEVANCE_LANGUAGES.has(normalized)
      && Boolean(YOUTUBE_RELEVANCE_LANGUAGE_FALLBACKS[normalized]);
  });
}

/** Fail closed at the dispatch boundary if a caller bypasses the resolver. */
export function assertYouTubeRelevanceLanguage(language: string | null | undefined): string | undefined {
  if (language === undefined || language === null || String(language).trim() === '') return undefined;
  const normalized = normalizeLanguageCode(String(language));
  if (!normalized || !YOUTUBE_SUPPORTED_RELEVANCE_LANGUAGES.has(normalized)) {
    throw new Error(`UNSUPPORTED_YOUTUBE_RELEVANCE_LANGUAGE:${String(language).slice(0, 16)}`);
  }
  return normalized;
}
