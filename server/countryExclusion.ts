import { getExcludedCountries } from './db';
import { CountryExclusionMatch, findCountryExclusion } from './countryExclusionRules';

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
