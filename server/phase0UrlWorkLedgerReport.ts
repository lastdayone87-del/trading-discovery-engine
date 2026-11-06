/**
 * Phase 0 URL work ledger report builder (read-only).
 *
 * The CLI wrapper lives in scripts/phase0UrlWorkLedgerReport.ts. Keeping the
 * builder here lets the PostgreSQL regression exercise the same SQL the
 * operator runs, without duplicating query text in tests.
 *
 * The builder issues several queries. Callers must run it on one connection in
 * a REPEATABLE READ transaction (the CLI and the PostgreSQL regression do), so
 * the pending-channel population cannot change between the projection and the
 * independent SQL bound.
 */

import {
  COMMUNITY_ACQUISITION_WORK_SURFACES,
  projectCommunityAcquisitionWork,
  reconcileCommunityWorkProjection,
  type CommunityWorkObservation,
  type CommunityWorkProjectionRow,
  type CommunityWorkProjectionStats,
  type CommunityWorkReconciliation,
} from './communityAcquisitionWorkLedger';

export interface Phase0UrlWorkLedgerReportOptions {
  windowDays?: number;
  maxDeltaPct?: number;
  includeRows?: boolean;
}

export interface Phase0UrlWorkLedgerReport {
  generatedAt: string;
  windowDays: number;
  maxDeltaPct: number;
  schema: { ledgerTablePresent: boolean };
  batches: { pendingJobs: number; pendingChannels: number };
  projection: CommunityWorkProjectionStats;
  telemetry: { retryableRows: number; neverBrowserExecutedRows: number };
  reconciliation: CommunityWorkReconciliation;
  discoveredUnobservedLinks: number;
  ledger: { rows: number; byState: Record<string, number> };
  warnings: string[];
  rows?: CommunityWorkProjectionRow[];
}

export interface Phase0UrlWorkLedgerReportDb {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }>;
}

export interface Phase0UrlWorkLedgerReportArgs {
  windowDays: number;
  maxDeltaPct: number;
  check: boolean;
  includeRows: boolean;
  out: string | null;
  help: boolean;
}

export const PHASE0_URL_WORK_LEDGER_USAGE =
  'Usage: npx tsx scripts/phase0UrlWorkLedgerReport.ts '
  + '[--window-days=14] [--max-delta-pct=5] [--check] [--include-rows] [--out=path]';

function parseBoundedInteger(rawValue: string, flag: string, min: number, max: number): number {
  if (!/^\d+$/.test(rawValue)) {
    throw new Error(`${flag} must be an integer between ${min} and ${max}: "${rawValue}"`);
  }
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${flag} must be an integer between ${min} and ${max}: "${rawValue}"`);
  }
  return value;
}

function parseBoundedPercent(rawValue: string, flag: string, max: number): number {
  if (!/^\d+(?:\.\d+)?$/.test(rawValue)) {
    throw new Error(`${flag} must be a number between 0 and ${max}: "${rawValue}"`);
  }
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 0 || value > max) {
    throw new Error(`${flag} must be a number between 0 and ${max}: "${rawValue}"`);
  }
  return value;
}

/**
 * Strict argument parsing: unknown or malformed tokens fail instead of being
 * silently ignored. In particular `--max-delta-pct=0` must remain zero, and
 * `--check=true` / bare `--window-days` must not be treated as defaults.
 */
export function parsePhase0UrlWorkLedgerReportArgs(
  argv: readonly string[],
): Phase0UrlWorkLedgerReportArgs {
  const args: Phase0UrlWorkLedgerReportArgs = {
    windowDays: 14,
    maxDeltaPct: 5,
    check: false,
    includeRows: false,
    out: null,
    help: false,
  };
  for (const raw of argv) {
    if (raw === '--check') args.check = true;
    else if (raw === '--include-rows') args.includeRows = true;
    else if (raw === '--help' || raw === '-h') args.help = true;
    else if (raw.startsWith('--window-days=')) {
      args.windowDays = parseBoundedInteger(raw.slice('--window-days='.length), '--window-days', 1, 90);
    } else if (raw.startsWith('--max-delta-pct=')) {
      args.maxDeltaPct = parseBoundedPercent(raw.slice('--max-delta-pct='.length), '--max-delta-pct', 100);
    } else if (raw.startsWith('--out=')) {
      const out = raw.slice('--out='.length);
      if (!out.trim()) throw new Error('--out must name a non-empty file path');
      args.out = out;
    } else {
      throw new Error(`unknown argument: "${raw}". ${PHASE0_URL_WORK_LEDGER_USAGE}`);
    }
  }
  return args;
}

const SURFACES = [...COMMUNITY_ACQUISITION_WORK_SURFACES];

/**
 * SQL spelling of the work URL. This is deliberately independent of the
 * TypeScript URL serializer so normalization drift shows up as a delta, but it
 * must still be structurally correct:
 *
 *   * drop the fragment, preserve the query;
 *   * trim trailing slashes only from the path, never from query values;
 *   * keep a root path slash so `https://example.com` and
 *     `https://example.com/` agree with `URL.toString()`.
 */
function sqlNormalizedUrl(expression: string): string {
  const withoutFragment = `split_part(trim(COALESCE(${expression}, '')), '#', 1)`;
  // Lowercase only scheme + authority: hosts are case-insensitive, but paths
  // and query values are not. Lowercasing the whole URL would merge distinct
  // work keys and diverge from URL.toString().
  const origin = `substring(${withoutFragment} from '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]+')`;
  const rest = `substr(${withoutFragment}, length(${origin}) + 1)`;
  const pathPart = `(CASE WHEN strpos(${rest}, '?') > 0`
    + ` THEN substr(${rest}, 1, strpos(${rest}, '?') - 1)`
    + ` ELSE ${rest} END)`;
  const queryPart = `(CASE WHEN strpos(${rest}, '?') > 0`
    + ` THEN substr(${rest}, strpos(${rest}, '?'))`
    + ` ELSE '' END)`;
  const trimmedPath = `(CASE WHEN rtrim(${pathPart}, '/') ~ '^[^/]*$'`
    + ` THEN rtrim(${pathPart}, '/') || '/'`
    + ` ELSE rtrim(${pathPart}, '/') END)`;
  return `lower(${origin}) || ${trimmedPath} || ${queryPart}`;
}

function safeIntSql(jsonExpression: string): string {
  // Parentheses are required: `::` binds tighter than `->>`, so an
  // unparenthesized cast would apply to the trailing key literal instead of
  // the extracted value. The digit-length bound keeps the numeric cast safe for
  // arbitrarily long JSON strings; out-of-range counters contribute no evidence.
  return `(CASE WHEN ${jsonExpression} ~ '^[0-9]{1,18}$'`
    + ` AND (${jsonExpression})::numeric <= 2147483647`
    + ` THEN (${jsonExpression})::int ELSE 0 END)`;
}

const REQUIRED_COMMUNITY_OBSERVATION_WHERE = `
  COALESCE(o.requested_url,'') <> ''
  AND COALESCE(o.requested_url,'') ~* '^https?://'
  AND COALESCE(o.provenance->>'surface','') = ANY($2::text[])
  AND COALESCE(o.provenance->>'required','false') = 'true'
`;

export async function buildPhase0UrlWorkLedgerReport(
  db: Phase0UrlWorkLedgerReportDb,
  options: Phase0UrlWorkLedgerReportOptions = {},
): Promise<Phase0UrlWorkLedgerReport> {
  const requestedWindowDays = options.windowDays ?? 14;
  const requestedMaxDeltaPct = options.maxDeltaPct ?? 5;
  const windowDays = Number.isFinite(requestedWindowDays)
    ? Math.max(1, Math.min(90, Math.round(requestedWindowDays)))
    : 14;
  const maxDeltaPct = Number.isFinite(requestedMaxDeltaPct)
    ? Math.max(0, Math.min(100, requestedMaxDeltaPct))
    : 5;

  const schema = await db.query(
    `SELECT to_regclass('public.community_acquisition_url_state') AS oid`,
  );
  const ledgerTablePresent = Boolean(schema.rows[0]?.oid);

  const batches = await db.query(
    `SELECT count(*)::int AS pending_jobs,
            count(DISTINCT payload->>'channelId')::int AS pending_channels
       FROM jobs
      WHERE type='RETRY_COMMUNITY_ACQUISITION'
        AND status IN ('PENDING','PROCESSING')`,
  );

  const rawObservations = await db.query(
    `SELECT o.channel_id,
            o.requested_url,
            o.outcome,
            o.retryable,
            o.failure_class,
            o.observed_at,
            o.provenance
       FROM external_acquisition_observations o
       JOIN (
         SELECT DISTINCT payload->>'channelId' AS channel_id
           FROM jobs
          WHERE type='RETRY_COMMUNITY_ACQUISITION'
            AND status IN ('PENDING','PROCESSING')
       ) pending ON pending.channel_id = o.channel_id
      WHERE o.observed_at > now() - ($1::text || ' days')::interval
        AND ${REQUIRED_COMMUNITY_OBSERVATION_WHERE}
      ORDER BY o.channel_id, o.observed_at`,
    [windowDays, SURFACES],
  );

  const observations: CommunityWorkObservation[] = rawObservations.rows.map(row => ({
    channelId: String(row.channel_id || ''),
    requestedUrl: String(row.requested_url || ''),
    outcome: String(row.outcome || ''),
    retryable: row.retryable === true,
    failureClass: row.failure_class ? String(row.failure_class) : null,
    observedAt: new Date(row.observed_at).toISOString(),
    provenance: row.provenance,
  }));

  const projection = projectCommunityAcquisitionWork(observations);

  const telemetry = await db.query(
    `WITH pending AS (
       SELECT DISTINCT payload->>'channelId' AS channel_id
         FROM jobs
        WHERE type='RETRY_COMMUNITY_ACQUISITION'
          AND status IN ('PENDING','PROCESSING')
     ),
     raw AS (
       SELECT o.channel_id,
              COALESCE(o.provenance->>'surface','') AS surface,
              ${sqlNormalizedUrl('o.requested_url')} AS normalized_url,
              o.outcome,
              o.retryable,
              COALESCE(o.failure_class,'') AS failure_class,
              o.observed_at,
              COALESCE(o.provenance->>'sharedEvidenceFrom','') = '' AS direct_evidence,
              (
                COALESCE(o.provenance->>'sharedEvidenceFrom','') = ''
                AND COALESCE(o.provenance->'crawlerTelemetry'->>'mode','') = 'RENDERED'
                AND (
                  ${safeIntSql(`o.provenance->'crawlerTelemetry'->>'requestsFinished'`)} > 0
                  OR ${safeIntSql(`o.provenance->'crawlerTelemetry'->>'pagesInspected'`)} > 0
                  OR ${safeIntSql(`o.provenance->'crawlerTelemetry'->>'clicksSucceeded'`)} > 0
                )
              ) AS browser_executed
         FROM external_acquisition_observations o
         JOIN pending ON pending.channel_id = o.channel_id
        WHERE o.observed_at > now() - ($1::text || ' days')::interval
          AND ${REQUIRED_COMMUNITY_OBSERVATION_WHERE}
     ),
     grouped AS (
       SELECT channel_id,
              surface,
              normalized_url,
              bool_or(browser_executed) AS browser_executed
         FROM raw
        GROUP BY channel_id, surface, normalized_url
     ),
     ranked AS (
       SELECT raw.*,
              row_number() OVER (
                PARTITION BY channel_id, surface, normalized_url
                ORDER BY CASE outcome
                           WHEN 'FOUND' THEN 4
                           WHEN 'INSPECTED_NO_MATCH' THEN 3
                           WHEN 'PARTIALLY_INSPECTED' THEN 2
                           WHEN 'ACQUISITION_FAILED' THEN 1
                           ELSE 0
                         END DESC,
                         observed_at DESC
              ) AS effective_rank
         FROM raw
     )
     SELECT count(*) FILTER (
              WHERE e.outcome = 'ACQUISITION_FAILED'
                AND e.retryable
                AND e.direct_evidence
                AND e.failure_class <> 'REDIRECT_LIMIT'
            )::int AS retryable_rows,
            count(*) FILTER (
              WHERE e.outcome = 'ACQUISITION_FAILED'
                AND e.retryable
                AND e.direct_evidence
                AND e.failure_class <> 'REDIRECT_LIMIT'
                AND NOT g.browser_executed
            )::int AS never_browser_executed_rows
       FROM ranked e
       JOIN grouped g
         ON g.channel_id = e.channel_id
        AND g.surface = e.surface
        AND g.normalized_url = e.normalized_url
      WHERE e.effective_rank = 1`,
    [windowDays, SURFACES],
  );

  const telemetryBound = {
    retryableRows: Number(telemetry.rows[0]?.retryable_rows || 0),
    neverBrowserExecutedRows: Number(telemetry.rows[0]?.never_browser_executed_rows || 0),
  };
  const reconciliation = reconcileCommunityWorkProjection(
    projection.stats,
    telemetryBound,
    maxDeltaPct,
  );

  const discovered = await db.query(
    `WITH pending AS (
       SELECT DISTINCT payload->>'channelId' AS channel_id
         FROM jobs
        WHERE type='RETRY_COMMUNITY_ACQUISITION'
          AND status IN ('PENDING','PROCESSING')
     )
     SELECT count(DISTINCT (l.channel_id, ${sqlNormalizedUrl('l.source_url')}))::int AS rows
       FROM creator_site_links l
       JOIN pending ON pending.channel_id = l.channel_id
      WHERE COALESCE(l.source_url,'') ~* '^https?://'
        AND NOT EXISTS (
          SELECT 1
            FROM external_acquisition_observations o
           WHERE o.channel_id = l.channel_id
             AND (
               ${sqlNormalizedUrl('o.requested_url')} = ${sqlNormalizedUrl('l.source_url')}
               OR ${sqlNormalizedUrl('o.final_url')} = ${sqlNormalizedUrl('l.source_url')}
             )
        )`,
  );

  const ledger: { rows: number; byState: Record<string, number> } = { rows: 0, byState: {} };
  if (ledgerTablePresent) {
    const ledgerRows = await db.query(
      `SELECT state, count(*)::int AS rows
         FROM community_acquisition_url_state
        GROUP BY state
        ORDER BY state`,
    );
    for (const row of ledgerRows.rows) {
      ledger.byState[String(row.state)] = Number(row.rows || 0);
      ledger.rows += Number(row.rows || 0);
    }
  }

  const warnings: string[] = [];
  if (!ledgerTablePresent) {
    warnings.push('ledger_table_missing: apply migration 166 before running this report');
  } else if (ledger.rows === 0) {
    warnings.push('ledger_empty_phase0_expected: the ledger is not populated until Phase 1 dual-write');
  }
  if (telemetryBound.retryableRows === 0) {
    warnings.push('no_retryable_work_measured: the window contains no retry-owned work to reconcile');
  }
  if (!reconciliation.retryableWithinFivePercent) {
    warnings.push('retryable_projection_delta_exceeds_tolerance');
  }
  if (!reconciliation.neverExecutedWithinFivePercent) {
    warnings.push('retryable_never_browser_executed_delta_exceeds_tolerance');
  }

  return {
    generatedAt: new Date().toISOString(),
    windowDays,
    maxDeltaPct,
    schema: { ledgerTablePresent },
    batches: {
      pendingJobs: Number(batches.rows[0]?.pending_jobs || 0),
      pendingChannels: Number(batches.rows[0]?.pending_channels || 0),
    },
    projection: projection.stats,
    telemetry: telemetryBound,
    reconciliation,
    discoveredUnobservedLinks: Number(discovered.rows[0]?.rows || 0),
    ledger,
    warnings,
    ...(options.includeRows ? { rows: projection.rows } : {}),
  };
}
