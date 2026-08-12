export interface CountrySearchHints {
  regionCode?: string;
  relevanceLanguage?: string;
}

/**
 * Retrieval hints only. They bias YouTube search toward the market we are
 * researching but MUST NOT be consumed as creator-country evidence.
 */
const COUNTRY_SEARCH_HINTS: Record<string, CountrySearchHints> = {
  'united states': { regionCode: 'US', relevanceLanguage: 'en' },
  'united kingdom': { regionCode: 'GB', relevanceLanguage: 'en' },
  germany: { regionCode: 'DE', relevanceLanguage: 'de' },
  france: { regionCode: 'FR', relevanceLanguage: 'fr' },
  spain: { regionCode: 'ES', relevanceLanguage: 'es' },
  netherlands: { regionCode: 'NL', relevanceLanguage: 'nl' },
  italy: { regionCode: 'IT', relevanceLanguage: 'it' },
  switzerland: { regionCode: 'CH', relevanceLanguage: 'de' },
  austria: { regionCode: 'AT', relevanceLanguage: 'de' },
  belgium: { regionCode: 'BE', relevanceLanguage: 'nl' },
  australia: { regionCode: 'AU', relevanceLanguage: 'en' },
  canada: { regionCode: 'CA', relevanceLanguage: 'en' },
  japan: { regionCode: 'JP', relevanceLanguage: 'ja' },
  'south korea': { regionCode: 'KR', relevanceLanguage: 'ko' },
  singapore: { regionCode: 'SG', relevanceLanguage: 'en' },
  denmark: { regionCode: 'DK', relevanceLanguage: 'da' },
  sweden: { regionCode: 'SE', relevanceLanguage: 'sv' },
  norway: { regionCode: 'NO', relevanceLanguage: 'no' },
  finland: { regionCode: 'FI', relevanceLanguage: 'fi' },
  portugal: { regionCode: 'PT', relevanceLanguage: 'pt' },
  ireland: { regionCode: 'IE', relevanceLanguage: 'en' },
  'new zealand': { regionCode: 'NZ', relevanceLanguage: 'en' },
  brazil: { regionCode: 'BR', relevanceLanguage: 'pt' },
  mexico: { regionCode: 'MX', relevanceLanguage: 'es' },
  turkey: { regionCode: 'TR', relevanceLanguage: 'tr' },
  'south africa': { regionCode: 'ZA', relevanceLanguage: 'en' },
  india: { regionCode: 'IN', relevanceLanguage: 'en' }
};

const normalizeCountry = (country: string) => country.normalize('NFKC').trim().toLocaleLowerCase('en');

export function countrySearchHints(countryName: string, declaredLanguages: string[] = []): CountrySearchHints {
  const configured = COUNTRY_SEARCH_HINTS[normalizeCountry(countryName)];
  if (!configured) return {};

  // The curated country hint is authoritative for retrieval. Vocabulary
  // languages are intentionally not converted into country evidence; they are
  // only a fallback when the country mapping has no language preference.
  const fallbackLanguage = declaredLanguages
    .map(language => language.trim().toLocaleLowerCase('en'))
    .find(language => /^[a-z]{2}$/.test(language));

  return {
    regionCode: configured.regionCode,
    relevanceLanguage: configured.relevanceLanguage || fallbackLanguage
  };
}

export function hasCountrySearchHint(countryName: string): boolean {
  return !!COUNTRY_SEARCH_HINTS[normalizeCountry(countryName)];
}
