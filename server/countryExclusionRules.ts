import type { ExcludedCountry } from '../src/types';
import { countryAliasTarget } from './countryAliases';

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

/**
 * Identity key for exclusion comparison. Alias spellings (ISO codes and
 * common exonyms) resolve to the same canonical country as their full name,
 * so a `DE` exclusion applies to a `Germany` run and vice versa. Values
 * outside the alias vocabulary fall back to their normalized spelling and
 * therefore keep exact-match semantics.
 */
export function countryIdentityKey(country: string | null | undefined): string {
  const normalized = normalizeCountryName(country);
  if (!normalized) return '';
  const canonical = countryAliasTarget(normalized);
  return canonical ? normalizeCountryName(canonical) : normalized;
}

export function findCountryExclusion(
  country: string | null | undefined,
  exclusions: ExcludedCountry[]
): CountryExclusionMatch | null {
  const identity = countryIdentityKey(country);
  if (!identity) return null;
  const match = exclusions.find(item => countryIdentityKey(item.country_name) === identity);
  return match ? { country: match.country_name, reason: match.reason } : null;
}
