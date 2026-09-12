import { SUPPORTED_PRODUCTION_COUNTRIES } from '../src/data/initial_countries';

export type ScopeEligibility = 'IN_SCOPE' | 'OUT_OF_SCOPE' | 'UNRESOLVED';

const SUPPORTED = new Set(
  (SUPPORTED_PRODUCTION_COUNTRIES as readonly string[]).map(country =>
    country.normalize('NFKC').trim().toLocaleLowerCase('en'),
  ),
);

/**
 * Derives catalog scope validity from an attributed country only. Never reads
 * confidence, status, or gate dispositions: UNCERTAIN-with-country stays
 * IN_SCOPE when the country is supported (evidence may still arrive), and
 * only a missing country is UNRESOLVED. Dormant supported countries are
 * IN_SCOPE (dormancy governs autonomous scheduling, not validity).
 */
export function resolveScopeEligibility(country: string | null | undefined): ScopeEligibility {
  const normalized = String(country || '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en');
  if (!normalized) return 'UNRESOLVED';
  return SUPPORTED.has(normalized) ? 'IN_SCOPE' : 'OUT_OF_SCOPE';
}
