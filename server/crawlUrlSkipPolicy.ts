import { getDb } from './db';

/**
 * Deterministic terminal failure classes whose repeat is provably futile:
 * measured same-URL recovery is 0–1.6% (UNSUPPORTED 0.0%, NETWORK 0.2%,
 * HTTP 1.1%, NO_PAGE 1.6% over 7 days). Everything else — budget/timeout/
 * rate-limit/transient and any future class — stays retryable under existing
 * semantics.
 */
export const CAPPED_DETERMINISTIC_FAILURE_CLASSES = [
  'UNSUPPORTED_CONTENT_TYPE',
  'NETWORK_FAILURE',
  'HTTP_ERROR',
  'NO_PAGE_PROCESSED',
] as const;

/** Consecutive identical capped failures on one channel+URL before it is skipped. */
export const URL_SKIP_CONSECUTIVE_FAILURE_THRESHOLD = 5;

export interface UrlFailureRow {
  requestedUrl: string;
  failureClass: string | null;
  outcome: string;
  observedAt: string;
}

/**
 * Normalizes a candidate URL exactly the way crawlExternalLinks normalizes
 * seed URLs before recording them (trim + https:// prefix), so skip lookups
 * match ledger keys. URL variants that differ beyond this (e.g. trailing
 * slash) are treated as distinct targets.
 */
export function normalizeSkipUrl(rawUrl: string): string {
  const url = String(rawUrl || '').trim();
  if (!url) return '';
  return url.startsWith('http://') || url.startsWith('https://') ? url : `https://${url}`;
}

/**
 * Newest-first trailing run of identical ACQUISITION_FAILED for one URL.
 * NO_PAGE_PROCESSED rows are transparent zero-evidence markers (a rendered
 * zero-page echo carries no independent failure information beyond the static
 * outcome it accompanies), so they neither extend nor break a run — except a
 * run consisting solely of them, which still counts as its own streak.
 * Any other outcome, or a different failure class, breaks the run: recovery
 * or drift resets it.
 */
export function trailingIdenticalFailure(rows: UrlFailureRow[]): { failureClass: string; count: number } | undefined {
  const ordered = [...rows].sort(
    (a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt)
  );
  const informative = ordered.filter(
    row => row.outcome !== 'ACQUISITION_FAILED' || String(row.failureClass || '') !== 'NO_PAGE_PROCESSED'
  );
  const effective = informative.length > 0 ? informative : ordered;
  const first = effective[0];
  if (!first || first.outcome !== 'ACQUISITION_FAILED') return undefined;
  const failureClass = String(first.failureClass || '');
  if (!failureClass) return undefined;
  let count = 0;
  for (const row of effective) {
    if (row.outcome === 'ACQUISITION_FAILED' && String(row.failureClass || '') === failureClass) count += 1;
    else break;
  }
  return { failureClass, count };
}

/**
 * URLs to skip: trailing run is a capped deterministic class at or past the
 * threshold. Keys are normalized exactly like crawl seeds so lookups match
 * ledger keys. Pure and unit-testable; the single caller passes ledger rows.
 */
export function skippedUrlsFromHistory(rows: UrlFailureRow[]): Set<string> {
  const capped = CAPPED_DETERMINISTIC_FAILURE_CLASSES as readonly string[];
  const byUrl = new Map<string, UrlFailureRow[]>();
  for (const row of rows) {
    const key = normalizeSkipUrl(row.requestedUrl);
    if (!key) continue;
    const list = byUrl.get(key) || [];
    list.push(row);
    byUrl.set(key, list);
  }
  const skipped = new Set<string>();
  for (const [url, urlRows] of byUrl) {
    const trailing = trailingIdenticalFailure(urlRows);
    if (
      trailing &&
      capped.includes(trailing.failureClass) &&
      trailing.count >= URL_SKIP_CONSECUTIVE_FAILURE_THRESHOLD
    ) {
      skipped.add(url);
    }
  }
  return skipped;
}

/**
 * Bounded per-channel failure history for skip evaluation (fail-open:
 * throws). Reads the latest rows per requested URL via a window function so
 * a busy channel's recent volume can never push a candidate's streak outside
 * the window. When `urls` is omitted, falls back to the latest channel-wide
 * rows (legacy behavior for callers without a candidate list).
 */
export async function fetchUrlFailureHistory(
  channelId: string,
  urls?: string[],
  limit = 500,
  perUrlLimit = 12,
): Promise<UrlFailureRow[]> {
  const db = await getDb();
  const cleanUrls = [...new Set((urls || []).map(url => String(url || '').trim()).filter(Boolean))];
  if (cleanUrls.length > 0) {
    const res = await db.query(
      `SELECT requested_url AS "requestedUrl", failure_class AS "failureClass",
              outcome, observed_at AS "observedAt"
       FROM (SELECT requested_url, failure_class, outcome, observed_at,
                    ROW_NUMBER() OVER (PARTITION BY requested_url ORDER BY observed_at DESC, id DESC) AS rn
             FROM external_acquisition_observations
             WHERE channel_id = $1 AND requested_url = ANY($2::text[])) ranked
       WHERE rn <= $3
       ORDER BY requested_url, observed_at DESC`,
      [channelId, cleanUrls, Math.min(100, Math.max(1, Math.floor(perUrlLimit) || 12))]
    );
    return res.rows as UrlFailureRow[];
  }
  const res = await db.query(
    `SELECT requested_url AS "requestedUrl", failure_class AS "failureClass",
            outcome, observed_at AS "observedAt"
     FROM external_acquisition_observations
     WHERE channel_id = $1
     ORDER BY observed_at DESC, id DESC
     LIMIT $2`,
    [channelId, Math.min(2000, Math.max(1, Math.floor(limit) || 500))]
  );
  return res.rows as UrlFailureRow[];
}
