import pg from 'pg';

export const PHASE_B_DOCUMENT_COMPLETENESS_VERSION = 'phase-b-document-completeness-v2';

export interface PhaseBDocumentCompletenessMetrics {
  diagnostics: number;
  completeProjections: number;
  missingProjections: number;
  nonEquivalentProjections: number;
  incompleteCoverage: number;
  missingDiagnosticLineage: number;
  pendingDiagnosticObservations: number;
  missingCoverageSnapshots: number;
  missingCreatorFocusSnapshots: number;
  missingCoverageFocusLineage: number;
}

export interface PhaseBDocumentCompletenessReport {
  version: string;
  windowStart: string;
  cutoffAt: string;
  ready: boolean;
  servingAuthority: false;
  assertionAuthority: false;
  reasonCodes: string[];
  metrics: PhaseBDocumentCompletenessMetrics;
}

export function buildPhaseBDocumentCompletenessReport(input: {
  windowStart: string;
  cutoffAt: string;
  metrics: PhaseBDocumentCompletenessMetrics;
}): PhaseBDocumentCompletenessReport {
  const reasonCodes: string[] = [];
  if (!input.metrics.diagnostics) reasonCodes.push('INSUFFICIENT_DIAGNOSTICS');
  if (input.metrics.missingProjections) reasonCodes.push('DOCUMENT_PROJECTION_MISSING');
  if (input.metrics.nonEquivalentProjections) reasonCodes.push('DOCUMENT_PROJECTION_MISMATCH');
  if (input.metrics.incompleteCoverage) reasonCodes.push('DOCUMENT_OR_COVERAGE_INCOMPLETE');
  if (input.metrics.missingDiagnosticLineage) reasonCodes.push('DIAGNOSTIC_LINEAGE_MISSING');
  if (input.metrics.pendingDiagnosticObservations) reasonCodes.push('OBSERVATION_RECONCILIATION_PENDING');
  if (input.metrics.missingCoverageSnapshots) reasonCodes.push('COVERAGE_SNAPSHOT_MISSING');
  if (input.metrics.missingCreatorFocusSnapshots) reasonCodes.push('CREATOR_FOCUS_SNAPSHOT_MISSING');
  if (input.metrics.missingCoverageFocusLineage) reasonCodes.push('COVERAGE_FOCUS_LINEAGE_MISSING');
  if (input.metrics.completeProjections !== input.metrics.diagnostics) reasonCodes.push('DOCUMENT_COMPLETENESS_COUNT_MISMATCH');
  return {
    version: PHASE_B_DOCUMENT_COMPLETENESS_VERSION,
    windowStart: input.windowStart,
    cutoffAt: input.cutoffAt,
    ready: reasonCodes.length === 0,
    servingAuthority: false,
    assertionAuthority: false,
    reasonCodes,
    metrics: input.metrics
  };
}

export async function inspectPhaseBDocumentCompleteness(input: {
  windowStart: string;
  cutoffAt: string;
}): Promise<PhaseBDocumentCompletenessReport> {
  const start = new Date(input.windowStart);
  const cutoff = new Date(input.cutoffAt);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(cutoff.getTime()) || start >= cutoff) {
    throw new Error('INVALID_DOCUMENT_COMPLETENESS_WINDOW');
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for Phase B document completeness inspection.');
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    ssl: process.env.PGSSL === 'disable' ? false : process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
  });
  const db = await pool.connect();
  try {
    await db.query('BEGIN TRANSACTION READ ONLY');
    const result = await db.query(
      `WITH diagnostics AS (
         SELECT id FROM production_classification_diagnostics WHERE created_at>=$1 AND created_at<$2
       ), projection AS (
         SELECT DISTINCT ON(classification_diagnostic_id) classification_diagnostic_id,equivalent,document_count,coverage_persisted
           FROM evidence_projection_observations
          WHERE observed_at>=$1 AND observed_at<$2 AND classification_diagnostic_id IS NOT NULL
          ORDER BY classification_diagnostic_id,observed_at DESC,id DESC
       ), focus_mode AS (
         SELECT upper(coalesce((SELECT setting_value FROM app_settings WHERE setting_key='creator_focus_classifier_mode'),'OFF')) AS mode
       )
       SELECT count(*)::int diagnostics,
              count(*) FILTER(WHERE p.classification_diagnostic_id IS NOT NULL AND p.equivalent AND p.document_count>0 AND p.coverage_persisted)::int complete_projections,
              count(*) FILTER(WHERE p.classification_diagnostic_id IS NULL)::int missing_projections,
              count(*) FILTER(WHERE p.classification_diagnostic_id IS NOT NULL AND NOT p.equivalent)::int non_equivalent_projections,
              count(*) FILTER(WHERE p.classification_diagnostic_id IS NOT NULL AND (p.document_count=0 OR NOT p.coverage_persisted))::int incomplete_coverage,
              (SELECT count(*) FROM evidence_projection_observations WHERE observed_at>=$1 AND observed_at<$2 AND classification_diagnostic_id IS NULL)::int missing_diagnostic_lineage,
              (SELECT count(*) FROM phase_b_observation_outbox WHERE observation_type='PRODUCTION_DIAGNOSTIC' AND status<>'COMPLETED' AND created_at>=$1 AND created_at<$2)::int pending_diagnostic_observations,
              count(*) FILTER(WHERE p.coverage_persisted AND c.id IS NULL)::int missing_coverage_snapshots,
              count(*) FILTER(WHERE p.coverage_persisted AND (SELECT mode FROM focus_mode) IN ('SHADOW','CANARY') AND f.id IS NULL)::int missing_creator_focus_snapshots,
              count(*) FILTER(WHERE f.id IS NOT NULL AND f.evidence_coverage_snapshot_id IS NULL)::int missing_coverage_focus_lineage
         FROM diagnostics d
         LEFT JOIN projection p ON p.classification_diagnostic_id=d.id
         LEFT JOIN evidence_coverage_snapshots c ON c.classification_diagnostic_id=d.id
         LEFT JOIN creator_focus_classification_snapshots f ON f.classification_diagnostic_id=d.id`,
      [input.windowStart, input.cutoffAt]
    );
    const row = result.rows[0] || {};
    const report = buildPhaseBDocumentCompletenessReport({
      windowStart: input.windowStart,
      cutoffAt: input.cutoffAt,
      metrics: {
        diagnostics: Number(row.diagnostics || 0),
        completeProjections: Number(row.complete_projections || 0),
        missingProjections: Number(row.missing_projections || 0),
        nonEquivalentProjections: Number(row.non_equivalent_projections || 0),
        incompleteCoverage: Number(row.incomplete_coverage || 0),
        missingDiagnosticLineage: Number(row.missing_diagnostic_lineage || 0),
        pendingDiagnosticObservations: Number(row.pending_diagnostic_observations || 0),
        missingCoverageSnapshots: Number(row.missing_coverage_snapshots || 0),
        missingCreatorFocusSnapshots: Number(row.missing_creator_focus_snapshots || 0),
        missingCoverageFocusLineage: Number(row.missing_coverage_focus_lineage || 0)
      }
    });
    await db.query('ROLLBACK');
    return report;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    db.release();
    await pool.end();
  }
}
