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
  // Store the trimmed identity: matchers normalize with normalizeCountryName()
  // (NFKC + Unicode trim + collapse + lowercase), so storing raw input would
  // let ' Germany' become a second, differently-spelled row that exact-name
  // removal can miss. readExcludedCountries() classifies a blank country_name
  // as a malformed row and throws, failing every guarded lifecycle/planner/
  // OSINT check closed until an operator removes the row - reject that write
  // before the row can exist; an unreadable identity needs no advisory lock.
  const trimmedName = typeof country?.country_name === 'string' ? country.country_name.trim() : '';
  if (!normalizeCountryName(trimmedName)) throw new Error('EXCLUDED_COUNTRY_NAME_REQUIRED');
  await runner.query('SELECT pg_advisory_xact_lock(hashtext($1))', [COUNTRY_EXCLUSION_POLICY_LOCK]);
  await runner.query('INSERT INTO excluded_countries(country_name,reason) VALUES($1,$2) ON CONFLICT(country_name) DO UPDATE SET reason=excluded.reason', [trimmedName, country.reason]);
}

export async function removeExcludedCountryGuarded(
  runner: { query: (sql: string, params?: any[]) => Promise<any> },
  countryName: string
): Promise<void> {
  await runner.query('SELECT pg_advisory_xact_lock(hashtext($1))', [COUNTRY_EXCLUSION_POLICY_LOCK]);
  // Identity-aware delete, mirroring the matchers: exact-name removal missed
  // legacy/operator rows stored in a padded or compatibility spelling
  // (' Germany', NBSP padding, fullwidth forms) and reported success while the
  // country stayed excluded. The shared normalization removes every spelling
  // of the same identity in one statement.
  await runner.query(
    `DELETE FROM excluded_countries WHERE ${countryNameNormSql('country_name')} = ${countryNameNormSql('$1')}`,
    [countryName]
  );
}

export function normalizeCountryName(country: string | null | undefined): string {
  // Null/unknown country is a legitimate state (e.g. channels whose creator
  // country is not yet resolved). It must never throw: it normalizes to the
  // empty string, which matches no exclusion entry.
  if (typeof country !== 'string') return '';
  return country.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');
}

// JS-trim characters (String.prototype.trim = WhiteSpace + LineTerminator):
// ASCII whitespace, NBSP, Ogham space, en/em spaces, line/paragraph
// separators, narrow/medium spaces, ideographic space, BOM.
const COUNTRY_NAME_TRIM_CHARS = ` \\x09\\x0A\\x0B\\x0C\\x0D\\u00A0\\u1680\\u2000\\u2001\\u2002\\u2003\\u2004\\u2005\\u2006\\u2007\\u2008\\u2009\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF`;

/**
 * SQL mirror of `normalizeCountryName()`, shared by the live exclusion
 * prefilters and by identity-aware removal so SQL and JavaScript cannot drift:
 *
 *   - `normalize(expr, NFKC)` folds compatibility forms (fullwidth letters,
 *     NBSP and the other compatibility spaces fold to ASCII space);
 *   - `btrim(..., E'...')` trims the full JavaScript whitespace set, not just
 *     the ASCII space PostgreSQL `trim()` handles;
 *   - `regexp_replace(..., '\s+', ' ', 'g')` collapses internal runs - the
 *     pattern must carry a SINGLE backslash (the TypeScript escape `\\s+`
 *     emits `'\s+'`, which PostgreSQL reads as the `\s` class; emitting two
 *     would match a literal backslash);
 *   - `lower(...)` matches `toLocaleLowerCase('en')`.
 */
export function countryNameNormSql(expr: string): string {
  return `lower(regexp_replace(btrim(normalize(${expr}, NFKC), E'${COUNTRY_NAME_TRIM_CHARS}'), '\\s+', ' ', 'g'))`;
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
