import { INITIAL_COUNTRY_VOCABULARIES, SUPPORTED_PRODUCTION_COUNTRIES } from '../src/data/initial_countries';
import { canonicalCountry } from './countryInference';
import { COUNTRY_KNOWLEDGE_PACKS, LANGUAGE_KNOWLEDGE_PACKS } from './evidenceEngine/knowledgePacks';
import { SUPPORTED_CLASSIFICATION_COUNTRIES } from './evidenceEngine/multilingualTerminology';
import { getCuratedQueryCountries } from './queryPlanner';

const PRODUCTION_COUNTRY_ISO_CODES: Readonly<Record<string, string>> = Object.freeze({
  US: 'United States', GB: 'United Kingdom', DE: 'Germany', FR: 'France', ES: 'Spain',
  NL: 'Netherlands', IT: 'Italy', AU: 'Australia', CA: 'Canada', JP: 'Japan', CH: 'Switzerland',
  DK: 'Denmark', SE: 'Sweden', AE: 'United Arab Emirates', SG: 'Singapore', NZ: 'New Zealand',
  BE: 'Belgium', LU: 'Luxembourg', IE: 'Ireland'
});

function duplicates(values: readonly string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) !== index);
}

function missing(expected: readonly string[], actual: readonly string[]): string[] {
  const available = new Set(actual);
  return expected.filter(value => !available.has(value));
}

/** Fail startup when a production country is only partially registered. */
export function assertProductionCountryArchitecture(): void {
  const countries = [...SUPPORTED_PRODUCTION_COUNTRIES];
  const errors: string[] = [];
  const duplicateCountries = duplicates(countries);
  if (duplicateCountries.length) errors.push(`duplicate vocabularies: ${duplicateCountries.join(', ')}`);
  if (new Set(countries).size !== Object.keys(PRODUCTION_COUNTRY_ISO_CODES).length) errors.push('ISO registry does not match production-country count');

  for (const [layer, registered] of [
    ['query planner', getCuratedQueryCountries()],
    ['classification', [...SUPPORTED_CLASSIFICATION_COUNTRIES]],
    ['country knowledge', Object.keys(COUNTRY_KNOWLEDGE_PACKS)]
  ] as const) {
    const absent = missing(countries, registered);
    const unexpected = missing(registered, countries);
    if (absent.length) errors.push(`${layer} missing: ${absent.join(', ')}`);
    if (unexpected.length) errors.push(`${layer} has unsupported registrations: ${unexpected.join(', ')}`);
  }

  for (const vocabulary of INITIAL_COUNTRY_VOCABULARIES) {
    if (!vocabulary.languages.length || !vocabulary.native_trading_terminology.length || !vocabulary.popular_instruments.length || !vocabulary.local_market_phrases.length || !vocabulary.common_content_format_names.length) errors.push(`${vocabulary.country} vocabulary is incomplete`);
    const pack = COUNTRY_KNOWLEDGE_PACKS[vocabulary.country];
    for (const languageCode of pack?.languageCodes || [pack?.primaryLanguage]) {
      if (!languageCode || !LANGUAGE_KNOWLEDGE_PACKS[languageCode]) errors.push(`${vocabulary.country} lacks language pack ${languageCode || '(unset)'}`);
    }
  }
  for (const [iso, country] of Object.entries(PRODUCTION_COUNTRY_ISO_CODES)) {
    if (canonicalCountry(iso) !== country) errors.push(`country inference does not canonicalize ${iso} to ${country}`);
  }
  if (errors.length) throw new Error(`Production country architecture is inconsistent: ${errors.join('; ')}`);
}
