import { getDb } from './db';

export interface GeneratedSurfaceHistoryRow {
  queryId: number;
  query: string;
  primaryTerm: string;
  timesExecuted: number;
  distinctResults: number;
  newChannels: number;
}

const STOP_WORDS = new Set([
  'a','an','and','de','der','des','du','el','en','et','for','für','in','la','le','les','of','on','para','pour','the','to','und','voor','with','y',
]);

// Combining marks are part of a word in Indic and other scripts. Splitting on
// them would turn one word into disconnected vowel signs and viramas.
const WORD_SPLIT = /[^\p{L}\p{N}\p{M}]+/u;
// Scripts written without spaces still use single-character words. Dropping
// them would collapse unrelated surfaces into an identical token set.
const SINGLE_CHAR_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function surfaceTokens(text: string): string[] {
  return [...new Set(
    text.normalize('NFKC').toLocaleLowerCase('en')
      .split(WORD_SPLIT)
      .map(token => token.trim())
      .filter(token => !STOP_WORDS.has(token))
      .filter(token => token.length > 1 || SINGLE_CHAR_SCRIPT.test(token)),
  )];
}

export function surfaceSimilarity(a: string, b: string): number {
  const left = new Set(surfaceTokens(a));
  const right = new Set(surfaceTokens(b));
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection++;
  return intersection / (left.size + right.size - intersection);
}

export type GeneratedSurfaceDisposition =
  | { allowed: true }
  | { allowed: false; reason: 'NEAR_DUPLICATE_EMPTY' | 'NEAR_DUPLICATE_ZERO_YIELD' | 'BATCH_DUPLICATE' | 'UNUSABLE_TEXT' };

/**
 * Generated surfaces are gated on actual history, not query-family labels.
 * A lexically similar prior query that already returned no new creators or no
 * results is not worth another query-library row. This is deliberately
 * reversible: only the proposal is deferred, never deleted.
 */
export function assessGeneratedSurface(
  text: string,
  history: GeneratedSurfaceHistoryRow[],
  batchTexts: string[] = [],
): GeneratedSurfaceDisposition {
  const tokens = surfaceTokens(text);
  if (tokens.length === 0) return { allowed: false, reason: 'UNUSABLE_TEXT' };
  for (const prior of history) {
    if (prior.timesExecuted <= 0) continue;
    if (surfaceSimilarity(text, `${prior.query} ${prior.primaryTerm}`) < 0.7) continue;
    if (prior.distinctResults <= 0) return { allowed: false, reason: 'NEAR_DUPLICATE_EMPTY' };
    if (prior.newChannels <= 0) return { allowed: false, reason: 'NEAR_DUPLICATE_ZERO_YIELD' };
  }
  for (const existing of batchTexts) {
    if (surfaceSimilarity(text, existing) >= 0.75) return { allowed: false, reason: 'BATCH_DUPLICATE' };
  }
  return { allowed: true };
}

export async function loadGeneratedSurfaceHistory(
  country: string,
  dbOverride?: { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> },
): Promise<GeneratedSurfaceHistoryRow[]> {
  const db = dbOverride || await getDb();
  const result = await db.query(
    `SELECT ql.id AS query_id,ql.query,COALESCE(ql.primary_term,'') AS primary_term,
            ql.times_executed,
            COALESCE(SUM(qr.distinct_results),0)::int AS distinct_results,
            COALESCE(SUM(qr.new_channels),0)::int AS new_channels
       FROM query_library ql
       LEFT JOIN query_runs qr ON qr.query_id=ql.id AND qr.status='COMPLETED'
      WHERE LOWER(ql.country)=LOWER($1)
      GROUP BY ql.id,ql.query,ql.primary_term,ql.times_executed`,
    [country],
  );
  return result.rows.map(row => ({
    queryId: Number(row.query_id),
    query: String(row.query || ''),
    primaryTerm: String(row.primary_term || ''),
    timesExecuted: Number(row.times_executed || 0),
    distinctResults: Number(row.distinct_results || 0),
    newChannels: Number(row.new_channels || 0),
  }));
}

/**
 * SQL predicate for a proposal whose surface is not currently deferred.
 * BATCH_DUPLICATE is a transient same-batch collision, so it only holds for an
 * hour. Empty/zero-yield history is held for 30 days but remains reversible.
 */
export function surfaceDeferralEligibleSql(alias = 'supporting_evidence', nowExpression = 'now()'): string {
  return `((${alias}->>'surfaceDeferredAt') IS NULL
    OR ((${alias}->>'surfaceDeferredReason') = 'BATCH_DUPLICATE'
        AND (${alias}->>'surfaceDeferredAt')::timestamptz < ${nowExpression} - interval '1 hour')
    OR (${alias}->>'surfaceDeferredAt')::timestamptz < ${nowExpression} - interval '30 days')`;
}

export function surfaceDeferralActiveSql(alias = 'supporting_evidence', nowExpression = 'now()'): string {
  return `NOT ${surfaceDeferralEligibleSql(alias, nowExpression)}`;
}
