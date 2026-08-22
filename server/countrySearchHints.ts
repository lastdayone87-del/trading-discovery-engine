export interface CountrySearchHints {
  regionCode?: string;
  relevanceLanguage?: string;
}

interface CountrySearchHintConfig extends CountrySearchHints {
  relevanceLanguages?: string[];
}

/**
 * Retrieval hints only. They bias YouTube search toward the market we are
 * researching but MUST NOT be consumed as creator-country evidence.
 */
const COUNTRY_SEARCH_HINTS: Record<string, CountrySearchHintConfig> = {
  'united states': { regionCode: 'US', relevanceLanguage: 'en' },
  'united kingdom': { regionCode: 'GB', relevanceLanguage: 'en' },
  germany: { regionCode: 'DE', relevanceLanguage: 'de' },
  france: { regionCode: 'FR', relevanceLanguage: 'fr' },
  spain: { regionCode: 'ES', relevanceLanguage: 'es' },
  netherlands: { regionCode: 'NL', relevanceLanguage: 'nl' },
  italy: { regionCode: 'IT', relevanceLanguage: 'it' },
  switzerland: { regionCode: 'CH', relevanceLanguage: 'de', relevanceLanguages: ['de', 'fr', 'it'] },
  austria: { regionCode: 'AT', relevanceLanguage: 'de' },
  belgium: { regionCode: 'BE', relevanceLanguage: 'nl', relevanceLanguages: ['nl', 'fr', 'de'] },
  australia: { regionCode: 'AU', relevanceLanguage: 'en' },
  canada: { regionCode: 'CA', relevanceLanguage: 'en', relevanceLanguages: ['en', 'fr'] },
  luxembourg: { regionCode: 'LU', relevanceLanguage: 'lb', relevanceLanguages: ['lb', 'fr', 'de'] },
  japan: { regionCode: 'JP', relevanceLanguage: 'ja' },
  'south korea': { regionCode: 'KR', relevanceLanguage: 'ko' },
  singapore: { regionCode: 'SG', relevanceLanguage: 'en' },
  'united arab emirates': { regionCode: 'AE', relevanceLanguage: 'ar', relevanceLanguages: ['ar', 'en'] },
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

const LANGUAGE_CODES: Record<string, string> = {
  english: 'en', french: 'fr', german: 'de', dutch: 'nl', italian: 'it',
  danish: 'da', swedish: 'sv', norwegian: 'no', finnish: 'fi', portuguese: 'pt',
  spanish: 'es', japanese: 'ja', korean: 'ko', arabic: 'ar', hindi: 'hi',
  'mandarin chinese': 'zh', chinese: 'zh', malay: 'ms', tamil: 'ta', irish: 'ga',
  maori: 'mi', 'māori': 'mi', luxembourgish: 'lb'
};

const normalizeCountry = (country: string) => country.normalize('NFKC').trim().toLocaleLowerCase('en');
const normalizeLanguage = (language: string) => language.trim().toLocaleLowerCase('en').split(/[-_]/)[0];

export function normalizeLanguageCode(value: string): string {
  const normalized = normalizeLanguage(value);
  return LANGUAGE_CODES[normalized] || (/^[a-z]{2}$/.test(normalized) ? normalized : '');
}

export function countrySearchLanguageCandidates(countryName: string, declaredLanguages: string[] = []): string[] {
  const configured = COUNTRY_SEARCH_HINTS[normalizeCountry(countryName)];
  if (!configured) return [];
  const configuredLanguages = configured.relevanceLanguages || (configured.relevanceLanguage ? [configured.relevanceLanguage] : []);
  const declared = declaredLanguages.map(normalizeLanguageCode).filter(Boolean);
  return [...new Set([...configuredLanguages, ...declared.filter(code => configuredLanguages.includes(code))])];
}

export function countrySearchHints(countryName: string, declaredLanguages: string[] = [], preferredLanguage?: string): CountrySearchHints {
  const configured = COUNTRY_SEARCH_HINTS[normalizeCountry(countryName)];
  if (!configured) return {};

  const fallbackLanguage = declaredLanguages
    .map(normalizeLanguageCode)
    .find(language => /^[a-z]{2}$/.test(language));
  const candidates = countrySearchLanguageCandidates(countryName, declaredLanguages);
  const preferred = preferredLanguage ? normalizeLanguageCode(preferredLanguage) : '';
  const relevanceLanguage = preferred && candidates.includes(preferred)
    ? preferred
    : candidates[0] || configured.relevanceLanguage || fallbackLanguage;

  return {
    regionCode: configured.regionCode,
    relevanceLanguage
  };
}

export function hasCountrySearchHint(countryName: string): boolean {
  return !!COUNTRY_SEARCH_HINTS[normalizeCountry(countryName)];
}
