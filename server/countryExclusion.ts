import type { ExcludedCountry } from '../src/types';
import { getExcludedCountries } from './db';
import { CountryExclusionMatch, findCountryExclusion, normalizeCountryName } from './countryExclusionRules';

export { findCountryExclusion, normalizeCountryName } from './countryExclusionRules';

export class ExcludedCountryError extends Error {
  readonly code = 'COUNTRY_EXCLUDED';

  constructor(
    readonly country: string,
    readonly reason: string,
    readonly context: string
  ) {
    super(`Country '${country}' is excluded: ${reason}`);
    this.name = 'ExcludedCountryError';
  }
}

export async function getCountryExclusion(country: string | null | undefined): Promise<CountryExclusionMatch | null> {
  // Unknown country short-circuits before the exclusion-list read: it can
  // never match an entry, so no database round-trip is needed and the null
  // path stays free of any I/O failure mode.
  if (typeof country !== 'string' || !country.trim()) return null;
  return findCountryExclusion(country, await getExcludedCountries());
}

/**
 * ENRICH-claim creator-country gate predicate (pure). A stored CONFIRMED
 * creator country matching the exclusion list blocks enrichment. LIKELY and
 * below stay fail-open, matching the existing Gate-1 authority semantics
 * where only confirmed-level evidence rejects. Returns the matched
 * exclusion, or null when the claim may proceed.
 */
export function shouldBlockEnrichClaimForCountry(
  countryStatus: string | null | undefined,
  country: string | null | undefined,
  exclusion: CountryExclusionMatch | null
): CountryExclusionMatch | null {
  if (countryStatus !== 'CONFIRMED') return null;
  if (typeof country !== 'string' || !country.trim()) return null;
  if (!exclusion) return null;
  // Defense in depth: the match must belong to this country. A stale or
  // mismatched lookup result must never block the wrong country.
  if (normalizeCountryName(exclusion.country) !== normalizeCountryName(country)) return null;
  return exclusion;
}

/**
 * The resource-boundary gate for any country-targeted operation. Call this before
 * creating jobs, selecting/generating queries, or invoking an external provider.
 * A null/unknown country is legitimate (e.g. unresolved creator country) and
 * resolves as allowed so enrichment can proceed to evidence collection.
 */
export async function assertCountryAllowed(country: string | null | undefined, context: string): Promise<void> {
  const exclusion = await getCountryExclusion(country);
  if (!exclusion) return;

  console.warn(JSON.stringify({
    event: 'excluded_country_blocked',
    country: exclusion.country,
    reason: exclusion.reason,
    context,
    timestamp: new Date().toISOString()
  }));
  throw new ExcludedCountryError(exclusion.country, exclusion.reason, context);
}

/**
 * Reads the exclusion list through a caller-supplied runner so guardrails can
 * read the same authority as the guarded write (a transaction-bound client
 * stays on that transaction; a pool stays on the pool). Throws on read
 * failure: guardrails fail closed at the caller, never silently open.
 */
export async function readExcludedCountries(
  runner: { query: (sql: string, params?: any[]) => Promise<any> }
): Promise<ExcludedCountry[]> {
  const result = await runner.query('SELECT country_name, reason FROM excluded_countries');
  return (result.rows || []) as ExcludedCountry[];
}
