/**
 * One-time recovery for search-query quarantines created by a provider
 * parameter defect, not by an invalid query.
 *
 * The original quarantine table stores only a SHA-256 of the query text and
 * has no provider/parameter signature. This script therefore limits deletion
 * to countries whose language set requires a verified YouTube fallback
 * (`lb -> fr`, `mi -> en`, `ga -> en`) and whose query hash matches an active
 * quarantine. Other countries/queries are never touched.
 *
 * Dry-run by default. `--apply` requires
 * CONFIRM_UNSUPPORTED_LANGUAGE_QUARANTINE_CLEANUP=true.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/clearUnsupportedLanguageQuarantines.ts
 *   DATABASE_URL=... CONFIRM_UNSUPPORTED_LANGUAGE_QUARANTINE_CLEANUP=true \
 *     npx tsx scripts/clearUnsupportedLanguageQuarantines.ts --apply
 */
import { createHash } from 'node:crypto';
import pg from 'pg';
import { usesProviderLanguageFallback } from '../server/youtubeLanguageSupport';

interface QuarantineRow { input_value: string; expires_at: Date }
interface QueryRow { id: number; country: string; normalized_query: string; next_eligible_at: Date | null }

const apply = process.argv.includes('--apply');
const confirmed = process.env.CONFIRM_UNSUPPORTED_LANGUAGE_QUARANTINE_CLEANUP === 'true';
if (apply && !confirmed) {
  throw new Error('Refusing to modify production: set CONFIRM_UNSUPPORTED_LANGUAGE_QUARANTINE_CLEANUP=true');
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const hashNormalizedQuery = (value: string): string =>
  createHash('sha256')
    .update(value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en'))
    .digest('hex');

const pool = new pg.Pool({
  connectionString: databaseUrl,
  ssl: process.env.PGSSL === 'disable' ? false : process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
  max: 1,
});

const client = await pool.connect();
try {
  await client.query(apply ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const [quarantine, queries] = await Promise.all([
    client.query(
      `SELECT input_value, expires_at
         FROM youtube_invalid_input_quarantine
        WHERE input_kind='searchQuery' AND expires_at > now()`,
    ) as Promise<{ rows: QuarantineRow[] }>,
    client.query(
      `SELECT id, country, normalized_query, next_eligible_at
         FROM query_library
        WHERE country IS NOT NULL`,
    ) as Promise<{ rows: QueryRow[] }>,
  ]);

  const hashes = new Set(quarantine.rows.map(row => row.input_value));
  const matched = queries.rows.filter(row =>
    hashes.has(hashNormalizedQuery(row.normalized_query))
    && usesProviderLanguageFallback(row.country),
  );
  const matchedHashes = new Set(matched.map(row => hashNormalizedQuery(row.normalized_query)));
  const queryIds = matched.map(row => row.id);

  console.log(JSON.stringify({
    mode: apply ? 'APPLY' : 'DRY_RUN',
    activeSearchQueryQuarantines: quarantine.rows.length,
    affectedQueries: matched.length,
    countries: [...new Set(matched.map(row => row.country))].sort(),
    rows: matched.map(row => ({ id: row.id, country: row.country, nextEligibleAt: row.next_eligible_at })),
  }, null, 2));

  if (apply && matched.length) {
    await client.query(
      `DELETE FROM youtube_invalid_input_quarantine
        WHERE input_kind='searchQuery' AND input_value = ANY($1::text[])`,
      [[...matchedHashes]],
    );
    await client.query(
      `UPDATE query_library
          SET next_eligible_at = now()
        WHERE id = ANY($1::int[]) AND (next_eligible_at IS NULL OR next_eligible_at > now())`,
      [queryIds],
    );
  }

  await client.query(apply ? 'COMMIT' : 'ROLLBACK');
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
