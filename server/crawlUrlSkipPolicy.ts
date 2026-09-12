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
 * Newest-first trailing run of identical ACQUISITION_FAILED for one URL. Any
 * other outcome (FOUND, INSPECTED_NO_MATCH, PARTIALLY_INSPECTED) or a
 * different failure class breaks the run — recovery or drift resets it.
 */
export function trailingIdenticalFailure(rows: UrlFailureRow[]): { failureClass: string; count: number } | undefined {
  const ordered = [...rows].sort(
    (a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt)
  );
  const first = ordered[0];
  if (!first || first.outcome !== 'ACQUISITION_FAILED') return undefined;
  const failureClass = String(first.failureClass || '');
  if (!failureClass) return undefined;
  let count = 0;
  for (const row of ordered) {
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

/** Bounded per-channel failure history for skip evaluation (fail-open: throws). */
export async function fetchUrlFailureHistory(channelId: string, limit = 500): Promise<UrlFailureRow[]> {
  const db = await getDb();
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
