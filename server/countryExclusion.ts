import type { ExcludedCountry } from '../src/types';
import { getExcludedCountries } from './db';
import { COUNTRY_EXCLUSION_POLICY_LOCK, CountryExclusionMatch, countryNameNormSql, findCountryExclusion, normalizeCountryName } from './countryExclusionRules';
import { resolveCountryIdentity } from './countryInference';

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
 *
 * A malformed result is a read failure too: a missing/non-array `rows` or a
 * row without a country_name must never be interpreted as "no exclusions".
 * A legitimate empty row set ({ rows: [] }) is the only valid empty result.
 */
export async function readExcludedCountries(
  runner: { query: (sql: string, params?: any[]) => Promise<any> }
): Promise<ExcludedCountry[]> {
  const result = await runner.query('SELECT country_name, reason FROM excluded_countries');
  const rows = result?.rows;
  if (!Array.isArray(rows)) throw new Error('EXCLUDED_COUNTRIES_READ_MALFORMED');
  for (const row of rows) {
    if (!row || typeof row.country_name !== 'string' || !row.country_name.trim() || typeof row.reason !== 'string') {
      throw new Error('EXCLUDED_COUNTRIES_READ_MALFORMED');
    }
  }
  return rows as ExcludedCountry[];
}

/**
 * Takes the SHARED exclusion-policy advisory lock on the runner. Call this on
 * the same transaction-bound runner that will perform the protected write,
 * before reading the exclusion list: exclusion-list writers take the
 * EXCLUSIVE variant of the same lock, so a policy change cannot commit
 * between the guarded check and the protected write. A pool runner cannot
 * hold an xact lock across statements — guarded writers wrap the check and
 * the mutation in one transaction-bound client (the Pool-discipline pattern
 * used by this codebase) before calling this.
 */
export async function lockExclusionPolicyForGuardedWrite(
  runner: { query: (sql: string, params?: any[]) => Promise<any> }
): Promise<void> {
  await runner.query(`SELECT pg_advisory_xact_lock_shared(hashtext($1))`, [COUNTRY_EXCLUSION_POLICY_LOCK]);
}

/**
 * Alias-aware exclusion matcher. Resolves BOTH sides through the shared
 * identity table: the candidate country AND each stored exclusion row, so
 * ISO/alias forms on either side (candidate 'DE' vs stored 'Germany', stored
 * 'DE' vs candidate 'Germany', localized variants like "Côte d'Ivoire" vs
 * 'Ivory Coast') cannot bypass or hide an exclusion. Unknown countries
 * normalize to themselves and match nothing unless literally listed.
 */
export function findCountryExclusionWithAliases(
  country: string | null | undefined,
  exclusions: ExcludedCountry[]
): CountryExclusionMatch | null {
  const raw = findCountryExclusion(country, exclusions);
  if (raw) return raw;
  if (typeof country !== 'string' || !country.trim()) return null;
  // resolveCountryIdentity covers the full modeled universe: ISO codes and
  // COUNTRY_ALIASES keys plus the localized/exonym variants modeled in
  // BARE_COUNTRY_NAME_VARIANTS (e.g. "Côte d'Ivoire" -> 'Ivory Coast',
  // "Česká republika" -> 'Czechia'). Canonical-vs-canonical comparison
  // subsumes the raw and candidate-resolved checks; it is the only form that
  // also matches legacy/operator rows written in an alias or localized form.
  // The SQL-side counterpart (excludedCountrySqlPredicate) applies the same
  // map to the stored column (countryAliasResolutionJson), so code and
  // database share one identity universe for exclusion matching.
  const candidate = normalizeCountryName(resolveCountryIdentity(country));
  const match = exclusions.find(item => normalizeCountryName(resolveCountryIdentity(item.country_name)) === candidate);
  return match ? { country: match.country_name, reason: match.reason } : null;
}

/**
 * Live-table SQL predicate mirroring findCountryExclusionWithAliases inside
 * the database. `columnSql` is the stored country expression and `mapParam`
 * is the JSONB alias-resolution parameter (countryAliasResolutionJson()).
 * Both the stored policy row and the candidate column are resolved through
 * that map before comparison:
 *
 *   resolve(excluded.country_name) = resolve(column)
 *   where resolve(x) = COALESCE(map ->> norm(x), x)
 *
 * `norm` is countryNameNormSql(), the SQL mirror of normalizeCountryName()
 * (NFKC, Unicode-whitespace trim, whitespace collapse, lowercase), so the
 * map keys (built with the JavaScript normalization) and the columns agree
 * even for compatibility-form or NBSP-padded spellings.
 *
 * Because it reads `excluded_countries` in the same statement:
 *   - a policy commit that lands between an earlier read and this query is
 *     still honored (statement snapshot), closing the check-then-serve race
 *     without requiring a transaction;
 *   - excluded rows — including ISO/alias forms like 'DE' against 'Germany'
 *     and modeled localized variants like "Côte d'Ivoire" against
 *     'Ivory Coast', on either side of the comparison — are rejected before
 *     LIMIT/OFFSET, so they can never consume batch slots;
 *   - a NULL column stays allowed, matching the in-code matcher.
 */
export function excludedCountrySqlPredicate(columnSql: string, mapParam: string): string {
  const norm = countryNameNormSql;
  const resolved = (expr: string) => `COALESCE(${mapParam}::jsonb ->> ${norm(expr)}, ${expr})`;
  return `NOT EXISTS (SELECT 1 FROM excluded_countries excluded WHERE ${norm(resolved('excluded.country_name'))} = ${norm(resolved(columnSql))})`;
}
