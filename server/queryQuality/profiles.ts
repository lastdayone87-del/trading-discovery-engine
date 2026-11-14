import {
  INITIAL_COUNTRY_VOCABULARIES,
  SUPPORTED_DORMANT_COUNTRIES,
  SUPPORTED_PRODUCTION_COUNTRIES,
} from '../../src/data/initial_countries';
import { getCountryDiscoveryProfile } from '../countryDiscoveryProfile';
import type { CountryMarketProfile } from './types';

/**
 * Production-configured active-country fixture.
 *
 * This is deliberately a code fixture, not a production `app_settings` read:
 * tests must detect scope drift and must never silently expand to all 20
 * supported countries. Norway is dormant in the registry but explicitly
 * selected in production, so it is present here. UAE is registry-dormant but
 * explicitly selected in the current production scope (verified 2026-11-13),
 * so it is included for the same reason.
 */
export const PRODUCTION_CONFIGURED_ACTIVE_COUNTRIES = [
  'France',
  'Canada',
  'Netherlands',
  'Belgium',
  'Germany',
  'Denmark',
  'Australia',
  'Sweden',
  'Switzerland',
  'United States',
  'United Kingdom',
  'Norway',
  'Ireland',
  'Singapore',
  'New Zealand',
  'Luxembourg',
  'United Arab Emirates',
] as const;

export const DEFAULT_NON_DORMANT_COUNTRIES = SUPPORTED_PRODUCTION_COUNTRIES.filter(
  country => !SUPPORTED_DORMANT_COUNTRIES.includes(country),
);

function discoveryLanguages(country: string): string[] {
  return getCountryDiscoveryProfile(country)?.languages.map(language => language.code) || [];
}

const SCRIPT_BY_LANGUAGE: Record<string, string> = {
  en: 'Latn', fr: 'Latn', de: 'Latn', nl: 'Latn', lb: 'Latn', da: 'Latn', sv: 'Latn',
  no: 'Latn', it: 'Latn', es: 'Latn', ms: 'Latn', ga: 'Latn', mi: 'Latn',
  ja: 'Jpan', zh: 'Hani', ar: 'Arab', ta: 'Taml',
};

const PRIMARY_MARKET: Record<string, string> = {
  'United States': 'US_EQUITIES_FUTURES',
  'United Kingdom': 'UK_EQUITIES',
  Ireland: 'IE_EQUITIES',
  Canada: 'CA_EQUITIES',
  Australia: 'AU_EQUITIES',
  'New Zealand': 'NZ_EQUITIES',
  France: 'FR_EQUITIES',
  Belgium: 'BE_EQUITIES',
  Netherlands: 'NL_EQUITIES',
  Luxembourg: 'LU_EQUITIES',
  Germany: 'DE_EQUITIES',
  Switzerland: 'CH_EQUITIES',
  Denmark: 'DK_EQUITIES',
  Sweden: 'SE_EQUITIES',
  Norway: 'NO_EQUITIES',
  Singapore: 'SG_EQUITIES',
  Italy: 'IT_EQUITIES',
  Japan: 'JP_EQUITIES',
  Spain: 'ES_EQUITIES',
  'United Arab Emirates': 'AE_EQUITIES',
};

const vocabularyByCountry = new Map(INITIAL_COUNTRY_VOCABULARIES.map(vocabulary => [vocabulary.country, vocabulary]));

export const COUNTRY_MARKET_PROFILES: Record<string, CountryMarketProfile> = Object.fromEntries(
  SUPPORTED_PRODUCTION_COUNTRIES.map(country => {
    const vocabulary = vocabularyByCountry.get(country);
    const languages = discoveryLanguages(country);
    return [country, {
      country,
      languages,
      scripts: [...new Set(languages.map(language => SCRIPT_BY_LANGUAGE[language] || 'Latn'))],
      markets: [PRIMARY_MARKET[country] || `${country.toUpperCase().replace(/\s+/g, '_')}_EQUITIES`],
      instruments: [...(vocabulary?.popular_instruments || [])],
      primaryMarket: PRIMARY_MARKET[country] || `${country.toUpperCase().replace(/\s+/g, '_')}_EQUITIES`,
      productionConfigured: (PRODUCTION_CONFIGURED_ACTIVE_COUNTRIES as readonly string[]).includes(country),
    }];
  }),
);

export function getCountryMarketProfile(country: string): CountryMarketProfile {
  // Unknown countries must fail closed. An English/Latn fallback would let a
  // country outside the production registry pass language and market checks.
  // `Object.hasOwn` also prevents prototype keys such as "constructor" from
  // resolving to inherited Object.prototype members.
  return Object.hasOwn(COUNTRY_MARKET_PROFILES, country) ? COUNTRY_MARKET_PROFILES[country] : {
    country,
    languages: [],
    scripts: [],
    markets: [],
    instruments: [],
    primaryMarket: 'UNKNOWN',
    productionConfigured: false,
  };
}

export function isRegisteredCountry(country: string): boolean {
  return Object.prototype.hasOwnProperty.call(COUNTRY_MARKET_PROFILES, country);
}

export function isProductionConfiguredCountry(country: string): boolean {
  return (PRODUCTION_CONFIGURED_ACTIVE_COUNTRIES as readonly string[]).includes(country);
}
