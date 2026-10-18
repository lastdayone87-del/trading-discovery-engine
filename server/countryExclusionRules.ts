import type { ExcludedCountry } from '../src/types';

export interface CountryExclusionMatch {
  country: string;
  reason: string;
}

/**
 * Advisory-lock key serializing the exclusion list against guarded writes.
 * Readers of the list that protect a mutation take the SHARED variant inside
 * the same transaction that performs the protected write; exclusion-list
 * writers (addExcludedCountry/removeExcludedCountry) take the EXCLUSIVE
 * variant in their transaction. PostgreSQL xact advisory locks make the two
 * mutually exclusive, so a policy change cannot commit between a guard's
 * check and its protected write.
 */
export const COUNTRY_EXCLUSION_POLICY_LOCK = 'country-exclusion-policy';

/**
 * Writer half of the exclusion-policy lock protocol: takes the EXCLUSIVE
 * policy lock, then writes. Callers must be inside a transaction (dbCore
 * opens one around these helpers), so the lock is held until the change
 * commits and guarded writes that hold the shared variant can never observe
 * the list before/after a half-applied change.
 */
export async function addExcludedCountryGuarded(
  runner: { query: (sql: string, params?: any[]) => Promise<any> },
  country: ExcludedCountry
): Promise<void> {
  // readExcludedCountries() classifies a blank country_name as a malformed row
  // and throws, failing every guarded lifecycle/planner/OSINT check closed
  // until an operator removes the row. Reject the write before the row can
  // exist; an unreadable identity needs no advisory lock to be rejected.
  if (!normalizeCountryName(country?.country_name)) throw new Error('EXCLUDED_COUNTRY_NAME_REQUIRED');
  await runner.query('SELECT pg_advisory_xact_lock(hashtext($1))', [COUNTRY_EXCLUSION_POLICY_LOCK]);
  await runner.query('INSERT INTO excluded_countries(country_name,reason) VALUES($1,$2) ON CONFLICT(country_name) DO UPDATE SET reason=excluded.reason', [country.country_name, country.reason]);
}

export async function removeExcludedCountryGuarded(
  runner: { query: (sql: string, params?: any[]) => Promise<any> },
  countryName: string
): Promise<void> {
  await runner.query('SELECT pg_advisory_xact_lock(hashtext($1))', [COUNTRY_EXCLUSION_POLICY_LOCK]);
  await runner.query('DELETE FROM excluded_countries WHERE country_name=$1', [countryName]);
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
