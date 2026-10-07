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
  /** Additive R6 fields for permanent-block establishment (nullable for
   * legacy callers/rows; absent → rule fails closed to retryable). */
  httpStatus?: number | null;
  finalUrl?: string | null;
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
 *
 * A leading run of NO_PAGE_PROCESSED echoes is its own streak: zero-page
 * rows are transparent companions only when they follow real failure
 * evidence, so a qualifying newest zero-page run counts directly instead of
 * being filtered away. Otherwise NO_PAGE rows are skipped over and the run
 * is evaluated on the remaining informative rows; a run consisting solely
 * of echoes falls back to the raw order. Any other outcome, or a different
 * failure class, breaks the run — recovery or drift resets it.
 */
export function trailingIdenticalFailure(rows: UrlFailureRow[]): { failureClass: string; count: number } | undefined {
  const ordered = [...rows].sort(
    (a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt)
  );
  const isNoPageEcho = (row: UrlFailureRow): boolean =>
    row.outcome === 'ACQUISITION_FAILED' && String(row.failureClass || '') === 'NO_PAGE_PROCESSED';
  let zeroPageRun = 0;
  for (const row of ordered) {
    if (isNoPageEcho(row)) zeroPageRun += 1;
    else break;
  }
  if (zeroPageRun >= URL_SKIP_CONSECUTIVE_FAILURE_THRESHOLD) {
    return { failureClass: 'NO_PAGE_PROCESSED', count: zeroPageRun };
  }
  const informative = ordered.filter(row => !isNoPageEcho(row));
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
 * Consecutive identical RENDERED_TIMEOUT runs before a seed stops owning
 * community retries. Production 7d: 65 URL targets reached 3+ consecutive
 * rendered timeouts with 0 recoveries, so the third identical run owns no
 * new information. Two priors still retry (transient load can genuinely
 * recover); the suppression only fires on the deterministic tail.
 */
export const CONSECUTIVE_TIMEOUT_SUPPRESSION_THRESHOLD = 2;

/**
 * Failure classes sharing one consecutive-tail budget for retry suppression.
 * Rendered wall-clock timeouts and rendered required-unvisited budget gaps
 * are the same deterministic phenomenon (bounded traversal stopped with work
 * remaining); a mixed tail of the two still proves futility. Defaults to the
 * timeout class alone so existing callers keep exact behavior.
 */
const DEFAULT_TIMEOUT_TAIL_CLASSES = ['RENDERED_TIMEOUT'];

/**
 * Whether prior ledger history already holds `threshold` consecutive
 * tail-class runs for one normalized URL. Newest-first trailing run over
 * ACQUISITION_FAILED/PARTIALLY_INSPECTED rows whose failureClass is in
 * `classes` (default timeout-only; callers pass the mixed budget/timeout set
 * to count deterministic budget exhaustion together — a mixed tail of those
 * classes still proves futility). Any other outcome or class breaks the run,
 * except same-attempt companions (a static row sharing an exact acquisition
 * timestamp with a counted tail row never breaks it); a FOUND row always
 * breaks, since invite discovery is a recovery signal no companion rule may
 * swallow. Pure and unit-testable.
 */
export function hasConsecutiveTimeoutExhaustion(
  rows: UrlFailureRow[],
  requestedUrl: string,
  threshold: number = CONSECUTIVE_TIMEOUT_SUPPRESSION_THRESHOLD,
  classes: string[] = DEFAULT_TIMEOUT_TAIL_CLASSES,
): boolean {
  const key = normalizeSkipUrl(requestedUrl);
  if (!key) return false;
  const wanted = new Set(classes);
  const ordered = rows
    .filter(row => normalizeSkipUrl(row.requestedUrl) === key)
    .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
  if (!ordered.length) return false;
  const want = Math.max(1, Math.trunc(threshold) || 1);
  const isTailRow = (row: UrlFailureRow): boolean => {
    if (!wanted.has(String(row.failureClass || ''))) return false;
    // FAILED/PARTIAL rows accumulate; FOUND rows count only when carrying a
    // gap class (FOUND_REQUIRED_GAP persistence). Ordinary FOUND rows (no
    // failure class) always break the tail as recovery signals.
    return row.outcome === 'ACQUISITION_FAILED' || row.outcome === 'PARTIALLY_INSPECTED' || row.outcome === 'FOUND';
  };
  // Same-attempt companions share one acquisition timestamp: static and
  // rendered observations from a single inspection carry the same
  // `observedAt` (one `now` per inspection), so a static companion row beside
  // its rendered row must not break the rendered tail. Only a tail-class-free
  // timestamp breaks the run. Timestamp comparison is numeric (ISO shape
  // independent); distinct inspections are milliseconds apart in practice.
  const tailTimestamps = new Set<number>();
  for (const row of ordered) {
    const at = Date.parse(row.observedAt);
    if (isTailRow(row) && Number.isFinite(at)) tailTimestamps.add(at);
  }
  let run = 0;
  for (const row of ordered) {
    if (isTailRow(row)) {
      run++;
      continue;
    }
    // A FOUND row always breaks the tail: invite discovery is a recovery
    // signal no companion rule may swallow.
    if (row.outcome === 'FOUND') break;
    const at = Date.parse(row.observedAt);
    if (Number.isFinite(at) && tailTimestamps.has(at)) continue;
    break;
  }
  return run >= want;
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
              outcome, observed_at AS "observedAt",
              http_status AS "httpStatus", final_url AS "finalUrl"
       FROM (SELECT requested_url, failure_class, outcome, observed_at, http_status, final_url,
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
            outcome, observed_at AS "observedAt",
            http_status AS "httpStatus", final_url AS "finalUrl"
     FROM external_acquisition_observations
     WHERE channel_id = $1
     ORDER BY observed_at DESC, id DESC
     LIMIT $2`,
    [channelId, Math.min(2000, Math.max(1, Math.floor(limit) || 500))]
  );
  return res.rows as UrlFailureRow[];
}
