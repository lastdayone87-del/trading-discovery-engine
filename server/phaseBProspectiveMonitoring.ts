import pg from 'pg';
import { inspectActivePhaseBCollectionEpoch } from './phaseBCollectionEpoch';

export const PHASE_B_PROSPECTIVE_MONITORING_VERSION = 'phase-b-prospective-monitoring-v1';
export const PHASE_B_MINIMUM_CLASS_ESS = 30;
export const PHASE_B_MINIMUM_EVIDENCE_ELIGIBILITY_BPS = 9000;

export interface PhaseBProspectiveMonitoringMetrics {
  selectedAssignments: number;
  diagnosticsMatched: number;
  coverageMatched: number;
  creatorFocusMatched: number;
  labelsMatched: number;
  fullyJoinableExamples: number;
  disputedLabels: number;
  unlabeledSelectedAssignments: number;
  pendingGroundTruthObservations: number;
  evidenceEligibilityBasisPoints: number;
  joinCompletenessBasisPoints: number;
  genuineLabeledCount: number;
  baselineFalsePositiveLabeledCount: number;
  projectedEssGenuine: number;
  projectedEssBaselineFalsePositive: number;
  meanInclusionProbability: number;
  labelLagHoursP50: number | null;
  labelLagHoursP95: number | null;
  countries: number;
  languages: number;
  discoveryOrigins: number;
  epochDeclared: boolean;
  epochStartedAt?: string;
}

export interface PhaseBProspectiveMonitoringReport {
  version: string;
  windowStart: string;
  cutoffAt: string;
  ready: boolean;
  servingAuthority: false;
  automaticPromotion: false;
  minimumClassEss: number;
  minimumEvidenceEligibilityBasisPoints: number;
  metrics: PhaseBProspectiveMonitoringMetrics;
  reasonCodes: string[];
  segmentCounts: {
    countries: Record<string, number>;
    languages: Record<string, number>;
    discoveryOrigins: Record<string, number>;
  };
}

/** Inverse-propensity weight from inclusion basis points. Mirrors offline Admission V2 weighting. */
export function propensityWeightFromBasisPoints(inclusionBasisPoints: number): number {
  if (!Number.isInteger(inclusionBasisPoints) || inclusionBasisPoints <= 0 || inclusionBasisPoints > 10000) {
    throw new Error('INCLUSION_BASIS_POINTS_OUT_OF_RANGE');
  }
  return 10000 / inclusionBasisPoints;
}

/** Kish effective sample size: (sum w)^2 / sum(w^2). */
export function effectiveSampleSizeFromWeights(weights: number[]): number {
  if (!weights.length) return 0;
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const squares = weights.reduce((sum, weight) => sum + weight * weight, 0);
  return squares > 0 ? (total * total) / squares : 0;
}

export function buildPhaseBProspectiveMonitoringReport(input: {
  windowStart: string;
  cutoffAt: string;
  metrics: Omit<
    PhaseBProspectiveMonitoringMetrics,
    'evidenceEligibilityBasisPoints' | 'joinCompletenessBasisPoints' | 'projectedEssGenuine' | 'projectedEssBaselineFalsePositive'
  > & {
    genuineWeights: number[];
    baselineFalsePositiveWeights: number[];
  };
  segmentCounts: PhaseBProspectiveMonitoringReport['segmentCounts'];
  minimumClassEss?: number;
  minimumEvidenceEligibilityBasisPoints?: number;
}): PhaseBProspectiveMonitoringReport {
  const minimumClassEss = input.minimumClassEss ?? PHASE_B_MINIMUM_CLASS_ESS;
  const minimumEvidenceEligibilityBasisPoints =
    input.minimumEvidenceEligibilityBasisPoints ?? PHASE_B_MINIMUM_EVIDENCE_ELIGIBILITY_BPS;
  const projectedEssGenuine = effectiveSampleSizeFromWeights(input.metrics.genuineWeights);
  const projectedEssBaselineFalsePositive = effectiveSampleSizeFromWeights(input.metrics.baselineFalsePositiveWeights);
  const evidenceEligibilityBasisPoints = input.metrics.diagnosticsMatched
    ? Math.floor((input.metrics.fullyJoinableExamples * 10000) / input.metrics.diagnosticsMatched)
    : 0;
  const joinCompletenessBasisPoints = input.metrics.selectedAssignments
    ? Math.floor((input.metrics.fullyJoinableExamples * 10000) / input.metrics.selectedAssignments)
    : 0;

  const metrics: PhaseBProspectiveMonitoringMetrics = {
    selectedAssignments: input.metrics.selectedAssignments,
    diagnosticsMatched: input.metrics.diagnosticsMatched,
    coverageMatched: input.metrics.coverageMatched,
    creatorFocusMatched: input.metrics.creatorFocusMatched,
    labelsMatched: input.metrics.labelsMatched,
    fullyJoinableExamples: input.metrics.fullyJoinableExamples,
    disputedLabels: input.metrics.disputedLabels,
    unlabeledSelectedAssignments: input.metrics.unlabeledSelectedAssignments,
    pendingGroundTruthObservations: input.metrics.pendingGroundTruthObservations,
    evidenceEligibilityBasisPoints,
    joinCompletenessBasisPoints,
    genuineLabeledCount: input.metrics.genuineLabeledCount,
    baselineFalsePositiveLabeledCount: input.metrics.baselineFalsePositiveLabeledCount,
    projectedEssGenuine,
    projectedEssBaselineFalsePositive,
    meanInclusionProbability: input.metrics.meanInclusionProbability,
    labelLagHoursP50: input.metrics.labelLagHoursP50,
    labelLagHoursP95: input.metrics.labelLagHoursP95,
    countries: input.metrics.countries,
    languages: input.metrics.languages,
    discoveryOrigins: input.metrics.discoveryOrigins,
    epochDeclared: input.metrics.epochDeclared,
    epochStartedAt: input.metrics.epochStartedAt
  };

  const reasonCodes: string[] = [];
  if (!metrics.epochDeclared) reasonCodes.push('COLLECTION_EPOCH_UNDECLARED');
  if (!metrics.selectedAssignments) reasonCodes.push('NO_SELECTED_ASSIGNMENTS');
  if (metrics.unlabeledSelectedAssignments > 0) reasonCodes.push('LABEL_LAG_PRESENT');
  if (metrics.pendingGroundTruthObservations > 0) reasonCodes.push('GROUND_TRUTH_RECONCILIATION_PENDING');
  if (metrics.evidenceEligibilityBasisPoints < minimumEvidenceEligibilityBasisPoints) {
    reasonCodes.push('EVIDENCE_ELIGIBILITY_BELOW_FLOOR');
  }
  if (metrics.joinCompletenessBasisPoints < minimumEvidenceEligibilityBasisPoints) {
    reasonCodes.push('JOIN_COMPLETENESS_BELOW_FLOOR');
  }
  if (metrics.projectedEssGenuine < minimumClassEss) reasonCodes.push('GENUINE_ESS_BELOW_FLOOR');
  if (metrics.projectedEssBaselineFalsePositive < minimumClassEss) {
    reasonCodes.push('BASELINE_FALSE_POSITIVE_ESS_BELOW_FLOOR');
  }
  if (metrics.countries < 1 || metrics.languages < 1) reasonCodes.push('SEGMENT_COVERAGE_INSUFFICIENT');

  return {
    version: PHASE_B_PROSPECTIVE_MONITORING_VERSION,
    windowStart: input.windowStart,
    cutoffAt: input.cutoffAt,
    ready: reasonCodes.length === 0,
    servingAuthority: false,
    automaticPromotion: false,
    minimumClassEss,
    minimumEvidenceEligibilityBasisPoints,
    metrics,
    reasonCodes,
    segmentCounts: input.segmentCounts
  };
}

export async function inspectPhaseBProspectiveMonitoring(input: {
  windowStart?: string;
  cutoffAt?: string;
  minimumClassEss?: number;
  minimumEvidenceEligibilityBasisPoints?: number;
} = {}): Promise<PhaseBProspectiveMonitoringReport> {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required for Phase B prospective monitoring.');
  }

  const epoch = await inspectActivePhaseBCollectionEpoch();
  const cutoffAt = input.cutoffAt || new Date().toISOString();
  const windowStart =
    input.windowStart ||
    (epoch.epoch?.startedAt ? new Date(String(epoch.epoch.startedAt)).toISOString() : undefined);
  if (!windowStart) throw new Error('PHASE_B_WINDOW_START_OR_COLLECTION_EPOCH_REQUIRED');
  if (!Number.isFinite(new Date(windowStart).getTime()) || !Number.isFinite(new Date(cutoffAt).getTime())) {
    throw new Error('INVALID_PROSPECTIVE_MONITORING_WINDOW');
  }
  if (new Date(windowStart) >= new Date(cutoffAt)) throw new Error('INVALID_PROSPECTIVE_MONITORING_WINDOW');

  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    ssl: process.env.PGSSL === 'disable' ? false : process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
  });
  const db = await pool.connect();
  try {
    await db.query('BEGIN TRANSACTION READ ONLY');
    const graph = await db.query(
      `WITH selected AS (
         SELECT a.id, a.channel_id, a.inclusion_basis_points, a.stratum, a.discovery_context, a.assigned_at
           FROM evaluation_cohort_assignments a
          WHERE a.cohort <> 'NOT_SELECTED'
            AND a.inclusion_basis_points > 0
            AND a.assigned_at >= $1::timestamptz
            AND a.assigned_at < $2::timestamptz
       ), matched AS (
         SELECT s.*,
                d.id AS diagnostic_id,
                d.created_at AS diagnostic_at,
                c.id AS coverage_id,
                f.id AS focus_id,
                f.evidence_coverage_snapshot_id AS focus_coverage_id,
                f.effective_status AS focus_effective_status,
                l.id AS label_id,
                l.label AS ground_truth_label,
                l.labeled_at
           FROM selected s
           LEFT JOIN LATERAL (
             SELECT id, created_at
               FROM production_classification_diagnostics d
              WHERE d.channel_id = s.channel_id
                AND d.created_at >= s.assigned_at
                AND d.created_at < $2::timestamptz
              ORDER BY d.created_at DESC, d.id DESC
              LIMIT 1
           ) d ON true
           LEFT JOIN evidence_coverage_snapshots c ON c.classification_diagnostic_id = d.id
           LEFT JOIN creator_focus_classification_snapshots f ON f.classification_diagnostic_id = d.id
           LEFT JOIN LATERAL (
             SELECT id, label, labeled_at
               FROM evaluation_ground_truth_labels l
              WHERE l.channel_id = s.channel_id
                AND l.labeled_at >= COALESCE(d.created_at, s.assigned_at)
                AND l.labeled_at < $2::timestamptz
                AND l.label <> 'DISPUTED'
              ORDER BY l.labeled_at DESC, l.id DESC
              LIMIT 1
           ) l ON true
       )
       SELECT
         count(*)::int AS selected_assignments,
         count(*) FILTER (WHERE diagnostic_id IS NOT NULL)::int AS diagnostics_matched,
         count(*) FILTER (WHERE coverage_id IS NOT NULL)::int AS coverage_matched,
         count(*) FILTER (WHERE focus_id IS NOT NULL AND focus_effective_status = 'UNCERTAIN')::int AS creator_focus_matched,
         count(*) FILTER (WHERE label_id IS NOT NULL)::int AS labels_matched,
         count(*) FILTER (
           WHERE diagnostic_id IS NOT NULL
             AND coverage_id IS NOT NULL
             AND focus_id IS NOT NULL
             AND focus_coverage_id IS NOT NULL
             AND focus_effective_status = 'UNCERTAIN'
             AND label_id IS NOT NULL
         )::int AS fully_joinable_examples,
         count(*) FILTER (WHERE label_id IS NULL)::int AS unlabeled_selected_assignments,
         coalesce(avg(inclusion_basis_points::float8 / 10000.0), 0)::float8 AS mean_inclusion_probability,
         count(*) FILTER (WHERE ground_truth_label = 'TRADING_CONFIRMED')::int AS genuine_labeled_count,
         count(*) FILTER (WHERE ground_truth_label = 'NON_TRADING')::int AS baseline_false_positive_labeled_count,
         percentile_cont(0.5) WITHIN GROUP (
           ORDER BY EXTRACT(EPOCH FROM (labeled_at - diagnostic_at)) / 3600.0
         ) FILTER (WHERE labeled_at IS NOT NULL AND diagnostic_at IS NOT NULL) AS label_lag_hours_p50,
         percentile_cont(0.95) WITHIN GROUP (
           ORDER BY EXTRACT(EPOCH FROM (labeled_at - diagnostic_at)) / 3600.0
         ) FILTER (WHERE labeled_at IS NOT NULL AND diagnostic_at IS NOT NULL) AS label_lag_hours_p95
       FROM matched`,
      [windowStart, cutoffAt]
    );

    const weights = await db.query(
      `WITH selected AS (
         SELECT a.channel_id, a.inclusion_basis_points, a.assigned_at
           FROM evaluation_cohort_assignments a
          WHERE a.cohort <> 'NOT_SELECTED'
            AND a.inclusion_basis_points > 0
            AND a.assigned_at >= $1::timestamptz
            AND a.assigned_at < $2::timestamptz
       ), labeled AS (
         SELECT s.inclusion_basis_points, l.label
           FROM selected s
           JOIN LATERAL (
             SELECT label, labeled_at
               FROM evaluation_ground_truth_labels l
              WHERE l.channel_id = s.channel_id
                AND l.labeled_at >= s.assigned_at
                AND l.labeled_at < $2::timestamptz
                AND l.label <> 'DISPUTED'
              ORDER BY l.labeled_at DESC, l.id DESC
              LIMIT 1
           ) l ON true
       )
       SELECT label, array_agg(inclusion_basis_points ORDER BY inclusion_basis_points) AS basis_points
         FROM labeled
        GROUP BY label`,
      [windowStart, cutoffAt]
    );

    const disputed = await db.query(
      `SELECT count(*)::int AS count
         FROM evaluation_ground_truth_labels
        WHERE label = 'DISPUTED'
          AND labeled_at >= $1::timestamptz
          AND labeled_at < $2::timestamptz`,
      [windowStart, cutoffAt]
    );

    const pendingLabels = await db.query(
      `SELECT count(*)::int AS count
         FROM phase_b_observation_outbox
        WHERE observation_type = 'GROUND_TRUTH_LABEL'
          AND status <> 'COMPLETED'
          AND created_at >= $1::timestamptz
          AND created_at < $2::timestamptz`,
      [windowStart, cutoffAt]
    );

    const segments = await db.query(
      `WITH selected AS (
         SELECT stratum, discovery_context
           FROM evaluation_cohort_assignments
          WHERE cohort <> 'NOT_SELECTED'
            AND inclusion_basis_points > 0
            AND assigned_at >= $1::timestamptz
            AND assigned_at < $2::timestamptz
       )
       SELECT
         (SELECT coalesce(jsonb_object_agg(key, count), '{}'::jsonb)
            FROM (
              SELECT coalesce(stratum->>'country', 'UNKNOWN') AS key, count(*)::int AS count
                FROM selected GROUP BY 1 ORDER BY 1
            ) countries) AS countries,
         (SELECT coalesce(jsonb_object_agg(key, count), '{}'::jsonb)
            FROM (
              SELECT coalesce(stratum->>'language', 'UNKNOWN') AS key, count(*)::int AS count
                FROM selected GROUP BY 1 ORDER BY 1
            ) languages) AS languages,
         (SELECT coalesce(jsonb_object_agg(key, count), '{}'::jsonb)
            FROM (
              SELECT coalesce(discovery_context->>'discoveryOrigin', stratum->>'discoveryOrigin', 'UNKNOWN') AS key,
                     count(*)::int AS count
                FROM selected GROUP BY 1 ORDER BY 1
            ) origins) AS discovery_origins`,
      [windowStart, cutoffAt]
    );

    const row = graph.rows[0] || {};
    const genuineBasis: number[] = [];
    const baselineBasis: number[] = [];
    for (const weightRow of weights.rows) {
      const points = (weightRow.basis_points || []) as number[];
      if (weightRow.label === 'TRADING_CONFIRMED') genuineBasis.push(...points.map(Number));
      if (weightRow.label === 'NON_TRADING') baselineBasis.push(...points.map(Number));
    }

    const countryMap = (segments.rows[0]?.countries || {}) as Record<string, number>;
    const languageMap = (segments.rows[0]?.languages || {}) as Record<string, number>;
    const originMap = (segments.rows[0]?.discovery_origins || {}) as Record<string, number>;

    const report = buildPhaseBProspectiveMonitoringReport({
      windowStart,
      cutoffAt,
      minimumClassEss: input.minimumClassEss,
      minimumEvidenceEligibilityBasisPoints: input.minimumEvidenceEligibilityBasisPoints,
      segmentCounts: {
        countries: countryMap,
        languages: languageMap,
        discoveryOrigins: originMap
      },
      metrics: {
        selectedAssignments: Number(row.selected_assignments || 0),
        diagnosticsMatched: Number(row.diagnostics_matched || 0),
        coverageMatched: Number(row.coverage_matched || 0),
        creatorFocusMatched: Number(row.creator_focus_matched || 0),
        labelsMatched: Number(row.labels_matched || 0),
        fullyJoinableExamples: Number(row.fully_joinable_examples || 0),
        disputedLabels: Number(disputed.rows[0]?.count || 0),
        unlabeledSelectedAssignments: Number(row.unlabeled_selected_assignments || 0),
        pendingGroundTruthObservations: Number(pendingLabels.rows[0]?.count || 0),
        genuineLabeledCount: Number(row.genuine_labeled_count || 0),
        baselineFalsePositiveLabeledCount: Number(row.baseline_false_positive_labeled_count || 0),
        meanInclusionProbability: Number(row.mean_inclusion_probability || 0),
        labelLagHoursP50: row.label_lag_hours_p50 == null ? null : Number(row.label_lag_hours_p50),
        labelLagHoursP95: row.label_lag_hours_p95 == null ? null : Number(row.label_lag_hours_p95),
        countries: Object.keys(countryMap).length,
        languages: Object.keys(languageMap).length,
        discoveryOrigins: Object.keys(originMap).length,
        epochDeclared: epoch.declared,
        epochStartedAt: epoch.epoch?.startedAt ? String(epoch.epoch.startedAt) : undefined,
        genuineWeights: genuineBasis.map(propensityWeightFromBasisPoints),
        baselineFalsePositiveWeights: baselineBasis.map(propensityWeightFromBasisPoints)
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
