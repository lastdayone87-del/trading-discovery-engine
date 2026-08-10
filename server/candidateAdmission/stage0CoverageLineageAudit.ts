import { Pool } from 'pg';

export type Stage0CoverageLineageStatus =
  | 'DIRECT_LINK'
  | 'RECOVERABLE_EXACT_DIAGNOSTIC'
  | 'AMBIGUOUS_DIAGNOSTIC_COVERAGE'
  | 'COVERAGE_MISSING'
  | 'FOCUS_MISSING'
  | 'DIAGNOSTIC_MISSING'
  | 'DIRECT_LINK_DIAGNOSTIC_MISMATCH';

export interface Stage0CoverageLineageCandidate {
  focusSnapshotId?: string | null;
  classificationDiagnosticId?: string | null;
  directCoverageSnapshotId?: string | null;
  directCoverageDiagnosticId?: string | null;
  exactDiagnosticCoverageIds?: string[] | null;
}

export function classifyStage0CoverageLineage(input: Stage0CoverageLineageCandidate): Stage0CoverageLineageStatus {
  if (!input.focusSnapshotId) return 'FOCUS_MISSING';
  if (!input.classificationDiagnosticId) return 'DIAGNOSTIC_MISSING';

  if (input.directCoverageSnapshotId) {
    if (input.directCoverageDiagnosticId && input.directCoverageDiagnosticId !== input.classificationDiagnosticId) {
      return 'DIRECT_LINK_DIAGNOSTIC_MISMATCH';
    }
    return 'DIRECT_LINK';
  }

  const exact = [...new Set((input.exactDiagnosticCoverageIds || []).filter(Boolean).map(String))];
  if (exact.length === 1) return 'RECOVERABLE_EXACT_DIAGNOSTIC';
  if (exact.length > 1) return 'AMBIGUOUS_DIAGNOSTIC_COVERAGE';
  return 'COVERAGE_MISSING';
}

const OPERATOR_VISIBLE_CHANNEL_SQL = `country_status <> 'REJECTED'
  AND scan_status <> 'SKIPPED_EXCLUDED'
  AND trading_status <> 'NON_TRADING'
  AND NOT EXISTS (
    SELECT 1 FROM excluded_countries excluded
    WHERE lower(regexp_replace(trim(excluded.country_name), '\\s+', ' ', 'g')) =
      lower(regexp_replace(trim(channels.country), '\\s+', ' ', 'g'))
  )`;

export async function auditStage0CoverageLineage(): Promise<Record<string, unknown>> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for Stage 0 coverage lineage audit.');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'disable' ? false : process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
  });
  const db = await pool.connect();
  try {
    await db.query('BEGIN TRANSACTION READ ONLY');
    const result = await db.query(`
      WITH visible AS (
        SELECT channel_id, channel_name, trading_status
          FROM channels
         WHERE ${OPERATOR_VISIBLE_CHANNEL_SQL}
      ), latest_focus AS (
        SELECT DISTINCT ON (f.channel_id)
               f.id AS focus_snapshot_id,
               f.channel_id,
               f.classification_diagnostic_id,
               f.evidence_coverage_snapshot_id,
               f.observed_at AS focus_observed_at
          FROM creator_focus_classification_snapshots f
          JOIN visible v ON v.channel_id=f.channel_id
         ORDER BY f.channel_id, f.observed_at DESC, f.id DESC
      )
      SELECT v.channel_id,
             v.channel_name,
             v.trading_status,
             lf.focus_snapshot_id,
             lf.classification_diagnostic_id,
             lf.evidence_coverage_snapshot_id AS direct_coverage_snapshot_id,
             lf.focus_observed_at,
             direct_cov.classification_diagnostic_id AS direct_coverage_diagnostic_id,
             COALESCE(exact_cov.coverage_ids, ARRAY[]::text[]) AS exact_diagnostic_coverage_ids
        FROM visible v
        LEFT JOIN latest_focus lf ON lf.channel_id=v.channel_id
        LEFT JOIN evidence_coverage_snapshots direct_cov ON direct_cov.id=lf.evidence_coverage_snapshot_id
        LEFT JOIN LATERAL (
          SELECT array_agg(c.id::text ORDER BY c.observed_at DESC,c.id DESC) AS coverage_ids
            FROM evidence_coverage_snapshots c
           WHERE c.classification_diagnostic_id=lf.classification_diagnostic_id
        ) exact_cov ON lf.classification_diagnostic_id IS NOT NULL
       ORDER BY v.channel_id`);
    await db.query('ROLLBACK');

    const statusCounts: Record<Stage0CoverageLineageStatus, number> = {
      DIRECT_LINK: 0,
      RECOVERABLE_EXACT_DIAGNOSTIC: 0,
      AMBIGUOUS_DIAGNOSTIC_COVERAGE: 0,
      COVERAGE_MISSING: 0,
      FOCUS_MISSING: 0,
      DIAGNOSTIC_MISSING: 0,
      DIRECT_LINK_DIAGNOSTIC_MISMATCH: 0
    };

    const rows = result.rows.map((row: any) => {
      const exactIds = Array.isArray(row.exact_diagnostic_coverage_ids) ? row.exact_diagnostic_coverage_ids.map(String) : [];
      const status = classifyStage0CoverageLineage({
        focusSnapshotId: row.focus_snapshot_id ? String(row.focus_snapshot_id) : null,
        classificationDiagnosticId: row.classification_diagnostic_id ? String(row.classification_diagnostic_id) : null,
        directCoverageSnapshotId: row.direct_coverage_snapshot_id ? String(row.direct_coverage_snapshot_id) : null,
        directCoverageDiagnosticId: row.direct_coverage_diagnostic_id ? String(row.direct_coverage_diagnostic_id) : null,
        exactDiagnosticCoverageIds: exactIds
      });
      statusCounts[status]++;
      return {
        channelId: String(row.channel_id),
        channelName: String(row.channel_name || ''),
        tradingStatus: String(row.trading_status || 'UNKNOWN'),
        focusSnapshotId: row.focus_snapshot_id ? String(row.focus_snapshot_id) : null,
        classificationDiagnosticId: row.classification_diagnostic_id ? String(row.classification_diagnostic_id) : null,
        directCoverageSnapshotId: row.direct_coverage_snapshot_id ? String(row.direct_coverage_snapshot_id) : null,
        directCoverageDiagnosticId: row.direct_coverage_diagnostic_id ? String(row.direct_coverage_diagnostic_id) : null,
        exactDiagnosticCoverageIds: exactIds,
        focusObservedAt: row.focus_observed_at ? new Date(row.focus_observed_at).toISOString() : null,
        status
      };
    });

    const directOrRecoverable = statusCounts.DIRECT_LINK + statusCounts.RECOVERABLE_EXACT_DIAGNOSTIC;
    const withFocus = rows.filter(row => row.status !== 'FOCUS_MISSING').length;
    const recentCutoff = Date.now() - 24 * 60 * 60 * 1000;
    const recent = rows.filter(row => row.focusObservedAt && new Date(row.focusObservedAt).getTime() >= recentCutoff);
    const recentDirect = recent.filter(row => row.status === 'DIRECT_LINK').length;

    return {
      reportType: 'STAGE0_COVERAGE_LINEAGE_AUDIT',
      generatedAt: new Date().toISOString(),
      readOnly: true,
      servingAuthority: false,
      automaticPromotion: false,
      totals: {
        operatorVisibleChannels: rows.length,
        channelsWithFocusSnapshot: withFocus,
        statusCounts,
        directOrExactlyRecoverable: directOrRecoverable,
        directOrExactlyRecoverableRate: rows.length ? directOrRecoverable / rows.length : null,
        recent24hFocusSnapshots: recent.length,
        recent24hDirectCoverageLinks: recentDirect,
        recent24hDirectCoverageLinkRate: recent.length ? recentDirect / recent.length : null
      },
      rows
    };
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    db.release();
    await pool.end();
  }
}
