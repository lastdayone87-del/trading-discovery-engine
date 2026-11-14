import { INITIAL_COUNTRY_VOCABULARIES } from '../src/data/initial_countries';
import { normalizeLanguageCode } from './languageCodes';

/**
 * Canonical country discovery profile.
 *
 * The supported-country registry and declared languages are authoritative.
 * Region codes are the only additional YouTube-specific fact. Discovery
 * language order is preserved for rotation, while weights are used only by
 * generation so a low-volume secondary language cannot crowd out the primary
 * market language.
 */
export interface CountryDiscoveryLanguage {
  code: string;
  weight: number;
}

export interface CountryDiscoveryProfile {
  country: string;
  regionCode: string;
  languages: ReadonlyArray<CountryDiscoveryLanguage>;
  primaryLanguage: string;
}

const REGION_CODE_BY_COUNTRY: Record<string, string> = {
  'United States': 'US',
  'United Kingdom': 'GB',
  Germany: 'DE',
  France: 'FR',
  Spain: 'ES',
  Netherlands: 'NL',
  Italy: 'IT',
  Australia: 'AU',
  Canada: 'CA',
  Japan: 'JP',
  Switzerland: 'CH',
  Denmark: 'DK',
  Sweden: 'SE',
  'United Arab Emirates': 'AE',
  Singapore: 'SG',
  'New Zealand': 'NZ',
  Belgium: 'BE',
  Luxembourg: 'LU',
  Ireland: 'IE',
  Norway: 'NO',
};

/**
 * Ordered languages and generation weights. The first language remains the
 * default YouTube `hl` value, matching the existing retrieval behavior.
 */
const LANGUAGE_WEIGHTS_BY_COUNTRY: Record<string, Array<[string, number]>> = {
  'United States': [['en', 1]],
  'United Kingdom': [['en', 1]],
  Germany: [['de', 1]],
  France: [['fr', 1]],
  Spain: [['es', 1]],
  Netherlands: [['nl', 1]],
  Italy: [['it', 1]],
  Australia: [['en', 1]],
  Canada: [['en', 0.75], ['fr', 0.25]],
  Japan: [['ja', 1]],
  Switzerland: [['de', 0.6], ['fr', 0.25], ['it', 0.15]],
  Denmark: [['da', 1]],
  Sweden: [['sv', 1]],
  'United Arab Emirates': [['ar', 0.7], ['en', 0.3]],
  Singapore: [['en', 0.7], ['ms', 0.1], ['zh', 0.15], ['ta', 0.05]],
  'New Zealand': [['en', 0.9], ['mi', 0.1]],
  Belgium: [['nl', 0.55], ['fr', 0.35], ['de', 0.1]],
  Luxembourg: [['lb', 0.4], ['fr', 0.35], ['de', 0.25]],
  Ireland: [['en', 0.9], ['ga', 0.1]],
  Norway: [['no', 1]],
};

function buildProfiles(): Record<string, CountryDiscoveryProfile> {
  const profiles: Record<string, CountryDiscoveryProfile> = {};
  for (const vocabulary of INITIAL_COUNTRY_VOCABULARIES) {
    const regionCode = REGION_CODE_BY_COUNTRY[vocabulary.country];
    if (!regionCode) continue;
    const declared = [...new Set(
      (vocabulary.languages || [])
        .map(normalizeLanguageCode)
        .filter(Boolean),
    )];
    const configured = LANGUAGE_WEIGHTS_BY_COUNTRY[vocabulary.country] || declared.map(code => [code, 1] as [string, number]);
    const byCode = new Map(configured.map(([code, weight]) => [code, weight]));
    // Declared languages are authoritative. If a new declared language is
    // added to the registry without a weight, include it at a conservative
    // secondary weight instead of silently dropping it.
    const orderedCodes = [...new Set([...configured.map(([code]) => code), ...declared])];
    const languages = orderedCodes.map((code, index) => ({
      code,
      weight: byCode.get(code) ?? (index === 0 ? 1 : 0.1),
    }));
    if (!languages.length) continue;
    profiles[vocabulary.country] = Object.freeze({
      country: vocabulary.country,
      regionCode,
      languages: Object.freeze(languages),
      primaryLanguage: languages[0].code,
    });
  }
  return profiles;
}

export const COUNTRY_DISCOVERY_PROFILES: Readonly<Record<string, CountryDiscoveryProfile>> =
  Object.freeze(buildProfiles());

const COUNTRY_DISCOVERY_PROFILE_BY_KEY = new Map(
  Object.values(COUNTRY_DISCOVERY_PROFILES).map(profile => [
    profile.country.normalize('NFKC').trim().toLocaleLowerCase('en'),
    profile,
  ]),
);

export function getCountryDiscoveryProfile(country: string): CountryDiscoveryProfile | null {
  const normalized = String(country || '').normalize('NFKC').trim();
  if (!normalized) return null;
  return Object.hasOwn(COUNTRY_DISCOVERY_PROFILES, normalized)
    ? COUNTRY_DISCOVERY_PROFILES[normalized]
    : COUNTRY_DISCOVERY_PROFILE_BY_KEY.get(normalized.toLocaleLowerCase('en')) || null;
}

/** All retrieval languages for a supported country, in rotation order. */
export function countryDiscoveryLanguageCandidates(country: string): string[] {
  return getCountryDiscoveryProfile(country)?.languages.map(language => language.code) || [];
}

/** Prompts for country-native generation, ordered by generation weight. */
export function countryDiscoveryLanguagesByWeight(country: string): CountryDiscoveryLanguage[] {
  const profile = getCountryDiscoveryProfile(country);
  if (!profile) return [];
  return [...profile.languages].sort((a, b) => b.weight - a.weight || a.code.localeCompare(b.code));
}

export function countryDiscoveryRegionCode(country: string): string | undefined {
  return getCountryDiscoveryProfile(country)?.regionCode;
}
