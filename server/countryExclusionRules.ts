import type { ExcludedCountry } from '../src/types';

export interface CountryExclusionMatch {
  country: string;
  reason: string;
}

export function normalizeCountryName(country: string | null | undefined): string {
  // Null/unknown country is a legitimate state (e.g. channels whose creator
  // country is not yet resolved). It must never throw: it normalizes to the
  // empty string, which matches no exclusion entry.
  if (typeof country !== 'string') return '';
  return country.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');
}

export function findCountryExclusion(
  country: string | null | undefined,
  exclusions: ExcludedCountry[]
): CountryExclusionMatch | null {
  const normalized = normalizeCountryName(country);
  if (!normalized) return null;
  const match = exclusions.find(item => normalizeCountryName(item.country_name) === normalized);
  return match ? { country: match.country_name, reason: match.reason } : null;
}
