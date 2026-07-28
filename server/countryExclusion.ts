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

export async function getCountryExclusion(country: string): Promise<CountryExclusionMatch | null> {
  return findCountryExclusion(country, await getExcludedCountries());
}

/**
 * The resource-boundary gate for any country-targeted operation. Call this before
 * creating jobs, selecting/generating queries, or invoking an external provider.
 */
export async function assertCountryAllowed(country: string, context: string): Promise<void> {
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
