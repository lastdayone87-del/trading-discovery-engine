import type { ExcludedCountry } from '../src/types';

export interface CountryExclusionMatch {
  country: string;
  reason: string;
}

export function normalizeCountryName(country: string): string {
  return country.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');
}

export function findCountryExclusion(
  country: string,
  exclusions: ExcludedCountry[]
): CountryExclusionMatch | null {
  const normalized = normalizeCountryName(country);
  const match = exclusions.find(item => normalizeCountryName(item.country_name) === normalized);
  return match ? { country: match.country_name, reason: match.reason } : null;
}
