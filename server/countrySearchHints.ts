import { normalizeLanguageCode } from './languageCodes';
import {
  countryDiscoveryLanguageCandidates,
  countryDiscoveryRegionCode,
  getCountryDiscoveryProfile,
} from './countryDiscoveryProfile';
import { resolveYouTubeRelevanceLanguage } from './youtubeLanguageSupport';

export { normalizeLanguageCode } from './languageCodes';

export interface CountrySearchHints {
  regionCode?: string;
  relevanceLanguage?: string;
}

/**
 * Retrieval hints only. They bias YouTube search toward the market we are
 * researching but MUST NOT be consumed as creator-country evidence.
 *
 * Country/language identity lives in `countryDiscoveryProfile.ts`. This module
 * is a compatibility surface for the existing search and planner callers.
 */
export function countrySearchLanguageCandidates(countryName: string, _declaredLanguages: string[] = []): string[] {
  return countryDiscoveryLanguageCandidates(countryName);
}

export function countrySearchHints(
  countryName: string,
  declaredLanguages: string[] = [],
  preferredLanguage?: string,
): CountrySearchHints {
  const profile = getCountryDiscoveryProfile(countryName);
  if (!profile) return {};

  const candidates = countryDiscoveryLanguageCandidates(countryName);
  const preferred = preferredLanguage ? normalizeLanguageCode(preferredLanguage) : '';
  const fallbackLanguage = declaredLanguages
    .map(normalizeLanguageCode)
    .find(language => candidates.includes(language));
  const primaryCandidate = preferred && candidates.includes(preferred)
    ? preferred
    : candidates[0] || fallbackLanguage || profile.primaryLanguage;
  // Query generation keeps the country's full language set; the provider
  // request is restricted to values YouTube actually accepts. A provider
  // rejection here previously quarantined a valid query for seven days.
  const relevanceLanguage = resolveYouTubeRelevanceLanguage([
    primaryCandidate,
    ...candidates,
    fallbackLanguage,
    profile.primaryLanguage,
  ]).language;

  return {
    regionCode: countryDiscoveryRegionCode(countryName),
    ...(relevanceLanguage ? { relevanceLanguage } : {}),
  };
}

export function hasCountrySearchHint(countryName: string): boolean {
  return getCountryDiscoveryProfile(countryName) !== null;
}
