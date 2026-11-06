/**
 * Phase 0 URL work ledger report builder (read-only).
 *
 * The CLI wrapper lives in scripts/phase0UrlWorkLedgerReport.ts. Keeping the
 * builder here lets the PostgreSQL regression exercise the same SQL the
 * operator runs, without duplicating query text in tests.
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

const SURFACES = [...COMMUNITY_ACQUISITION_WORK_SURFACES];

// The SQL bound deliberately uses raw URL spelling (lowercased, trailing slash
// removed) rather than the projection's full canonicalization, so a
// normalization bug appears as a delta instead of being hidden.
function safeIntSql(jsonExpression: string): string {
  // Parentheses are required: `::` binds tighter than `->>`, so an unparenthesized
  // cast would apply to the trailing key literal instead of the extracted value.
  return `(CASE WHEN ${jsonExpression} ~ '^[0-9]+$' THEN (${jsonExpression})::int ELSE 0 END)`;
}

export async function buildPhase0UrlWorkLedgerReport(
  db: Phase0UrlWorkLedgerReportDb,
  options: Phase0UrlWorkLedgerReportOptions = {},
): Promise<Phase0UrlWorkLedgerReport> {
  const windowDays = Math.max(1, Math.min(90, Math.round(options.windowDays ?? 14)));
  const maxDeltaPct = Math.max(0, Math.min(100, options.maxDeltaPct ?? 5));

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
        AND COALESCE(o.requested_url,'') <> ''
        AND COALESCE(o.provenance->>'surface','') = ANY($2::text[])
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
     deferred AS (
       SELECT o.channel_id,
              COALESCE(o.provenance->>'surface','') AS surface,
              lower(rtrim(COALESCE(o.requested_url,''),'/')) AS normalized_url,
              bool_or(
                COALESCE(o.provenance->'crawlerTelemetry'->>'mode','') = 'RENDERED'
                AND (
                  ${safeIntSql(`o.provenance->'crawlerTelemetry'->>'requestsFinished'`)} > 0
                  OR ${safeIntSql(`o.provenance->'crawlerTelemetry'->>'pagesInspected'`)} > 0
                  OR ${safeIntSql(`o.provenance->'crawlerTelemetry'->>'clicksSucceeded'`)} > 0
                )
              ) AS browser_executed
         FROM external_acquisition_observations o
         JOIN pending ON pending.channel_id = o.channel_id
        WHERE o.retryable
          AND o.observed_at > now() - ($1::text || ' days')::interval
          AND COALESCE(o.requested_url,'') <> ''
          AND COALESCE(o.provenance->>'surface','') = ANY($2::text[])
        GROUP BY 1,2,3
     )
     SELECT count(*)::int AS retryable_rows,
            count(*) FILTER (WHERE NOT browser_executed)::int AS never_browser_executed_rows
       FROM deferred`,
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
     SELECT count(*)::int AS rows
       FROM creator_site_links l
       JOIN pending ON pending.channel_id = l.channel_id
       LEFT JOIN site_inspections s ON s.site_identity = l.site_identity
      WHERE COALESCE(s.canonical_url,l.source_url,'') <> ''
        AND NOT EXISTS (
          SELECT 1
            FROM external_acquisition_observations o
           WHERE o.channel_id = l.channel_id
             AND lower(rtrim(COALESCE(o.requested_url,''),'/'))
                 = lower(rtrim(COALESCE(s.canonical_url,l.source_url),'/'))
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
  if (!reconciliation.retryableWithinFivePercent) {
    warnings.push('retryable_projection_delta_exceeds_tolerance');
  }
  if (!reconciliation.neverExecutedWithinFivePercent) {
    warnings.push('never_executed_projection_delta_exceeds_tolerance');
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
