/**
 * Stage 0 — temporary read-only operator-visible counterfactual.
 *
 * Reuses evaluateOfflineAdmissionV2 / buildOfflineAdmissionV2Report only.
 * Opens PostgreSQL with BEGIN TRANSACTION READ ONLY.
 * Performs zero writes (no inserts/updates/deletes/settings/serving/projections).
 */
import { Pool } from 'pg';
import { createHash } from 'node:crypto';
import type { CreatorFocusDistribution } from '../evidenceEngine/hypothesisTaxonomy';
import {
  buildOfflineAdmissionV2Report,
  evaluateOfflineAdmissionV2,
  OFFLINE_ADMISSION_V2_POLICY_VERSION,
  OFFLINE_ADMISSION_V2_REPORT_VERSION,
  type OfflineAdmissionCoverage,
  type OfflineAdmissionExample,
  type OfflineAdmissionGroundTruth,
  type OfflineAdmissionV2Decision,
  type OfflineAdmissionV2Result
} from './offlineV2';

/** Mirrors server/db.ts OPERATOR_VISIBLE_CHANNEL_SQL (single source kept in sync by Stage 0 design). */
const OPERATOR_VISIBLE_CHANNEL_SQL = `country_status <> 'REJECTED'
  AND scan_status <> 'SKIPPED_EXCLUDED'
  AND trading_status <> 'NON_TRADING'
  AND NOT EXISTS (
    SELECT 1 FROM excluded_countries excluded
    WHERE lower(regexp_replace(trim(excluded.country_name), '\\s+', ' ', 'g')) =
      lower(regexp_replace(trim(channels.country), '\\s+', ' ', 'g'))
  )`;

const json = <T>(value: T | string | null | undefined): T => {
  if (value == null) return value as T;
  return typeof value === 'string' ? (JSON.parse(value) as T) : value;
};

const checksum = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

export type Stage0ChannelRow = {
  channelId: string;
  channelName: string;
  country: string;
  discoverySource: string;
  tradingStatus: string;
  tradingConfidenceScore: number;
  tradingCategory: string;
  language: string;
  confidenceBand: string;
  hasLabel: boolean;
  groundTruth: OfflineAdmissionGroundTruth | null;
  creatorFocusSnapshotId: string | null;
  coverageSnapshotId: string | null;
  creatorFocusProposedStatus: string | null;
  tradingMass: number | null;
  alternativeMass: number | null;
  lowerConfidenceBound: number | null;
  decision: OfflineAdmissionV2Decision | null;
  reasonCodes: string[];
  futureDashboardVisible: boolean | null;
  exclusionReason: string | null;
};

function confidenceBand(score: number): string {
  if (!Number.isFinite(score)) return 'UNKNOWN';
  if (score < 20) return '0-19';
  if (score < 40) return '20-39';
  if (score < 50) return '40-49';
  if (score < 65) return '50-64';
  if (score < 80) return '65-79';
  return '80-100';
}

function countBy<T extends string>(items: Array<T | null | undefined>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const key = item == null || item === '' ? 'UNKNOWN' : String(item);
    out[key] = (out[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

function segmentBreakdown(
  rows: Stage0ChannelRow[],
  key: (row: Stage0ChannelRow) => string
): Record<string, {
  channels: number;
  evaluated: number;
  WITHHOLD: number;
  DEFER_INVESTIGATION: number;
  ADMIT_REVIEW: number;
  ADMIT_CONFIRMED: number;
  futureDashboardVisible: number;
}> {
  const map: Record<string, {
    channels: number;
    evaluated: number;
    WITHHOLD: number;
    DEFER_INVESTIGATION: number;
    ADMIT_REVIEW: number;
    ADMIT_CONFIRMED: number;
  futureDashboardVisible: number;
  }> = {};
  for (const row of rows) {
    const k = key(row) || 'UNKNOWN';
    if (!map[k]) {
      map[k] = {
        channels: 0,
        evaluated: 0,
        WITHHOLD: 0,
        DEFER_INVESTIGATION: 0,
        ADMIT_REVIEW: 0,
        ADMIT_CONFIRMED: 0,
        futureDashboardVisible: 0
      };
    }
    const bucket = map[k];
    bucket.channels++;
    if (row.decision) {
      bucket.evaluated++;
      bucket[row.decision]++;
      if (row.futureDashboardVisible) bucket.futureDashboardVisible++;
    }
  }
  return Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)));
}

export async function evaluateOperatorVisibleStage0(): Promise<Record<string, unknown>> {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required for Stage 0 operator-visible counterfactual.');
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl:
      process.env.PGSSL === 'disable'
        ? false
        : process.env.NODE_ENV === 'production'
          ? { rejectUnauthorized: false }
          : undefined
  });
  const db = await pool.connect();

  try {
    await db.query('BEGIN TRANSACTION READ ONLY');

    const visible = await db.query(
      `
      WITH visible AS (
        SELECT
          channels.channel_id,
          channels.channel_name,
          channels.country,
          channels.discovery_source,
          channels.trading_status,
          COALESCE(channels.trading_confidence_score, 0)::float AS trading_confidence_score,
          COALESCE(channels.trading_category, 'General Trading') AS trading_category
        FROM channels
        WHERE ${OPERATOR_VISIBLE_CHANNEL_SQL}
      ),
      latest_focus AS (
        SELECT DISTINCT ON (f.channel_id)
          f.channel_id,
          f.id AS creator_focus_snapshot_id,
          f.input_checksum AS creator_focus_input_checksum,
          f.creator_focus_distribution,
          f.proposed_status AS creator_focus_proposed_status,
          f.probability AS creator_focus_probability,
          f.lower_confidence_bound,
          f.reason_codes AS creator_focus_reason_codes,
          f.stage_report AS creator_focus_stage_report,
          f.policy_version AS creator_focus_policy_version,
          f.evidence_coverage_snapshot_id,
          f.observed_at AS focus_observed_at
        FROM creator_focus_classification_snapshots f
        INNER JOIN visible v ON v.channel_id = f.channel_id
        ORDER BY f.channel_id, f.observed_at DESC, f.id DESC
      ),
      latest_coverage AS (
        SELECT DISTINCT ON (cov.channel_id)
          cov.channel_id,
          cov.id AS coverage_snapshot_id,
          cov.completeness_disposition,
          cov.observed_document_count,
          cov.expected_document_count,
          cov.independent_family_count,
          cov.language_coverage,
          cov.temporal_coverage,
          cov.provider_availability,
          cov.acquisition_failures,
          cov.reason_codes AS coverage_reason_codes,
          cov.input_checksum AS coverage_input_checksum,
          cov.policy_version AS coverage_policy_version,
          cov.observed_at AS coverage_observed_at
        FROM evidence_coverage_snapshots cov
        INNER JOIN visible v ON v.channel_id = cov.channel_id
        ORDER BY cov.channel_id, cov.observed_at DESC, cov.id DESC
      ),
      latest_review AS (
        SELECT DISTINCT ON (d.channel_id)
          d.channel_id,
          d.decision AS review_decision
        FROM channel_review_decisions d
        INNER JOIN visible v ON v.channel_id = d.channel_id
        WHERE d.decision IN ('APPROVE', 'REJECT')
        ORDER BY d.channel_id, d.decided_at DESC, d.id DESC
      )
      SELECT
        v.channel_id,
        v.channel_name,
        v.country,
        v.discovery_source,
        v.trading_status,
        v.trading_confidence_score,
        v.trading_category,
        lr.review_decision,
        lf.creator_focus_snapshot_id,
        lf.creator_focus_input_checksum,
        lf.creator_focus_distribution,
        lf.creator_focus_proposed_status,
        lf.creator_focus_probability,
        lf.lower_confidence_bound,
        lf.creator_focus_reason_codes,
        lf.creator_focus_stage_report,
        lf.creator_focus_policy_version,
        lf.evidence_coverage_snapshot_id AS focus_coverage_snapshot_id,
        COALESCE(fc.id, lc.coverage_snapshot_id) AS coverage_snapshot_id,
        COALESCE(fc.completeness_disposition, lc.completeness_disposition) AS completeness_disposition,
        COALESCE(fc.observed_document_count, lc.observed_document_count) AS observed_document_count,
        COALESCE(fc.expected_document_count, lc.expected_document_count) AS expected_document_count,
        COALESCE(fc.independent_family_count, lc.independent_family_count) AS independent_family_count,
        COALESCE(fc.language_coverage, lc.language_coverage) AS language_coverage,
        COALESCE(fc.temporal_coverage, lc.temporal_coverage) AS temporal_coverage,
        COALESCE(fc.provider_availability, lc.provider_availability) AS provider_availability,
        COALESCE(fc.acquisition_failures, lc.acquisition_failures) AS acquisition_failures,
        COALESCE(fc.reason_codes, lc.coverage_reason_codes) AS coverage_reason_codes,
        COALESCE(fc.input_checksum, lc.coverage_input_checksum) AS coverage_input_checksum,
        COALESCE(fc.policy_version, lc.coverage_policy_version) AS coverage_policy_version
      FROM visible v
      LEFT JOIN latest_focus lf ON lf.channel_id = v.channel_id
      LEFT JOIN evidence_coverage_snapshots fc ON fc.id = lf.evidence_coverage_snapshot_id
      LEFT JOIN latest_coverage lc ON lc.channel_id = v.channel_id
      LEFT JOIN latest_review lr ON lr.channel_id = v.channel_id
      ORDER BY v.channel_id
      `
    );

    await db.query('COMMIT');

    const channelRows: Stage0ChannelRow[] = [];
    const labeledExamples: OfflineAdmissionExample[] = [];
    const excludedExamples: Array<{ exampleKey: string; channelId: string; reasonCode: string }> = [];
    const offlineResults: OfflineAdmissionV2Result[] = [];

    for (const row of visible.rows) {
      const channelId = String(row.channel_id);
      const exampleKey = `operator-visible:${channelId}`;
      const score = Number(row.trading_confidence_score) || 0;
      const languageCoverage = json<Record<string, unknown>>(row.language_coverage) || {};
      const language =
        (typeof languageCoverage.primary === 'string' && languageCoverage.primary) ||
        (typeof languageCoverage.language === 'string' && languageCoverage.language) ||
        (Array.isArray((languageCoverage as any).languages) && (languageCoverage as any).languages[0]
          ? String((languageCoverage as any).languages[0])
          : 'UNKNOWN');

      let groundTruth: OfflineAdmissionGroundTruth | null = null;
      if (row.review_decision === 'APPROVE') groundTruth = 'TRADING_CONFIRMED';
      else if (row.review_decision === 'REJECT') groundTruth = 'NON_TRADING';
      else if (row.trading_status === 'TRADING_CONFIRMED') groundTruth = 'TRADING_CONFIRMED';
      else if (row.trading_status === 'HUMAN_REJECTED' || row.trading_status === 'NON_TRADING') {
        groundTruth = 'NON_TRADING';
      }

      const baseRow: Stage0ChannelRow = {
        channelId,
        channelName: String(row.channel_name || ''),
        country: String(row.country || 'UNKNOWN'),
        discoverySource: String(row.discovery_source || 'UNKNOWN'),
        tradingStatus: String(row.trading_status || 'UNKNOWN'),
        tradingConfidenceScore: score,
        tradingCategory: String(row.trading_category || 'General Trading'),
        language: String(language || 'UNKNOWN'),
        confidenceBand: confidenceBand(score),
        hasLabel: groundTruth != null,
        groundTruth,
        creatorFocusSnapshotId: row.creator_focus_snapshot_id ? String(row.creator_focus_snapshot_id) : null,
        coverageSnapshotId: row.coverage_snapshot_id ? String(row.coverage_snapshot_id) : null,
        creatorFocusProposedStatus: row.creator_focus_proposed_status
          ? String(row.creator_focus_proposed_status)
          : null,
        tradingMass: null,
        alternativeMass: null,
        lowerConfidenceBound: row.lower_confidence_bound != null ? Number(row.lower_confidence_bound) : null,
        decision: null,
        reasonCodes: [],
        futureDashboardVisible: null,
        exclusionReason: null
      };

      if (!row.creator_focus_snapshot_id) {
        baseRow.exclusionReason = 'CREATOR_FOCUS_SNAPSHOT_MISSING';
        excludedExamples.push({ exampleKey, channelId, reasonCode: 'CREATOR_FOCUS_SNAPSHOT_MISSING' });
        channelRows.push(baseRow);
        continue;
      }
      if (!row.coverage_snapshot_id) {
        baseRow.exclusionReason = 'EVIDENCE_COVERAGE_SNAPSHOT_MISSING';
        excludedExamples.push({ exampleKey, channelId, reasonCode: 'EVIDENCE_COVERAGE_SNAPSHOT_MISSING' });
        channelRows.push(baseRow);
        continue;
      }

      const coverage: OfflineAdmissionCoverage = {
        snapshotId: String(row.coverage_snapshot_id),
        disposition: row.completeness_disposition,
        observedDocumentCount: Number(row.observed_document_count) || 0,
        expectedDocumentCount: Number(row.expected_document_count) || 0,
        independentFamilyCount: Number(row.independent_family_count) || 0,
        languageCoverage: json(row.language_coverage) || {},
        temporalCoverage: json(row.temporal_coverage) || {},
        providerAvailability: json(row.provider_availability) || [],
        acquisitionFailures: json(row.acquisition_failures) || [],
        reasonCodes: json(row.coverage_reason_codes) || [],
        inputChecksum: String(row.coverage_input_checksum || ''),
        policyVersion: String(row.coverage_policy_version || '')
      };

      const example: OfflineAdmissionExample = {
        exampleKey,
        channelId,
        split: 'TEST',
        groundTruth: groundTruth || 'NON_TRADING',
        inclusionProbability: 1,
        productionStatus: String(row.trading_status || 'UNKNOWN'),
        productionScore: score,
        segment: {
          country: baseRow.country,
          language: baseRow.language,
          discovery_source: baseRow.discoverySource,
          trading_status: baseRow.tradingStatus,
          trading_category: baseRow.tradingCategory,
          confidence_band: baseRow.confidenceBand
        },
        creatorFocusSnapshotId: String(row.creator_focus_snapshot_id),
        creatorFocusInputChecksum: String(row.creator_focus_input_checksum || ''),
        creatorFocusDistribution: json<CreatorFocusDistribution>(row.creator_focus_distribution),
        creatorFocusProposedStatus: row.creator_focus_proposed_status,
        creatorFocusProbability: Number(row.creator_focus_probability) || 0,
        creatorFocusLowerConfidenceBound: Number(row.lower_confidence_bound) || 0,
        creatorFocusReasonCodes: json(row.creator_focus_reason_codes) || [],
        creatorFocusStageReport: json(row.creator_focus_stage_report) || {},
        creatorFocusPolicyVersion: String(row.creator_focus_policy_version || ''),
        coverage
      };

      const result = evaluateOfflineAdmissionV2(example);
      offlineResults.push(result);
      if (groundTruth) labeledExamples.push({ ...example, groundTruth });

      baseRow.decision = result.decision;
      baseRow.reasonCodes = result.reasonCodes;
      baseRow.tradingMass = result.creatorFocus.tradingMass;
      baseRow.alternativeMass = result.creatorFocus.alternativeMass;
      baseRow.lowerConfidenceBound = result.creatorFocus.lowerConfidenceBound;
      baseRow.futureDashboardVisible =
        result.decision === 'ADMIT_CONFIRMED' || result.decision === 'ADMIT_REVIEW';
      channelRows.push(baseRow);
    }

    const decisionCounts: Record<OfflineAdmissionV2Decision, number> = {
      ADMIT_CONFIRMED: 0,
      ADMIT_REVIEW: 0,
      WITHHOLD: 0,
      DEFER_INVESTIGATION: 0
    };
    for (const result of offlineResults) decisionCounts[result.decision]++;

    const evaluated = offlineResults.length;
    const operatorVisible = channelRows.length;
    const eligibilityRate = operatorVisible > 0 ? evaluated / operatorVisible : null;
    const reliableForPopulationInference =
      evaluated >= 30 && eligibilityRate != null && eligibilityRate >= 0.5;

    const labeledReport =
      labeledExamples.length > 0
        ? buildOfflineAdmissionV2Report({
            dataset: {
              id: '00000000-0000-4000-8000-000000000000',
              key: 'stage0-operator-visible-labeled-subset',
              version: 0,
              cutoffAt: new Date().toISOString(),
              checksum: checksum(labeledExamples.map((e) => e.exampleKey))
            },
            examples: labeledExamples,
            excludedExamples: []
          })
        : null;

    const needsReviewBand = channelRows.filter(
      (r) =>
        r.tradingStatus === 'NEEDS_REVIEW' &&
        r.confidenceBand === '40-49' &&
        r.tradingCategory === 'General Trading'
    );
    const needsReviewBandEvaluated = needsReviewBand.filter((r) => r.decision);

    const representativeOutOfDomain = channelRows
      .filter(
        (r) =>
          r.decision === 'WITHHOLD' ||
          (r.tradingStatus === 'NEEDS_REVIEW' &&
            r.confidenceBand === '40-49' &&
            r.tradingCategory === 'General Trading' &&
            r.decision != null)
      )
      .sort((a, b) => {
        const am = (b.alternativeMass || 0) - (a.alternativeMass || 0);
        if (am !== 0) return am;
        return a.channelId.localeCompare(b.channelId);
      })
      .slice(0, 25)
      .map((r) => ({
        channelId: r.channelId,
        channelName: r.channelName,
        country: r.country,
        discoverySource: r.discoverySource,
        tradingStatus: r.tradingStatus,
        tradingConfidenceScore: r.tradingConfidenceScore,
        tradingCategory: r.tradingCategory,
        language: r.language,
        creatorFocusProposedStatus: r.creatorFocusProposedStatus,
        tradingMass: r.tradingMass,
        alternativeMass: r.alternativeMass,
        lowerConfidenceBound: r.lowerConfidenceBound,
        admissionV2Decision: r.decision,
        reasonCodes: r.reasonCodes,
        futureDashboardVisible: r.futureDashboardVisible,
        exclusionReason: r.exclusionReason
      }));

    const baselineReviewEligible = channelRows.filter((r) =>
      ['UNCERTAIN', 'NEEDS_REVIEW'].includes(r.tradingStatus)
    ).length;
    const proposedReview = decisionCounts.ADMIT_REVIEW;
    const projectedReviewReduction =
      baselineReviewEligible > 0
        ? {
            baselineEligible: baselineReviewEligible,
            proposedReview,
            avoided: Math.max(0, baselineReviewEligible - proposedReview),
            rate: (baselineReviewEligible - proposedReview) / baselineReviewEligible
          }
        : { baselineEligible: 0, proposedReview: 0, avoided: 0, rate: null as number | null };

    return {
      reportVersion: 'stage0-operator-visible-counterfactual-1',
      offlinePolicyVersion: OFFLINE_ADMISSION_V2_POLICY_VERSION,
      offlineReportVersion: OFFLINE_ADMISSION_V2_REPORT_VERSION,
      generatedAt: new Date().toISOString(),
      servingAuthority: false as const,
      automaticPromotion: false as const,
      readOnly: true as const,
      methodology: {
        cohort: 'channels matching OPERATOR_VISIBLE_CHANNEL_SQL at measurement time',
        evaluator: 'evaluateOfflineAdmissionV2 (existing Offline Admission V2; no parallel algorithm)',
        snapshots: 'latest creator_focus_classification_snapshots + linked or latest evidence_coverage_snapshots',
        labels:
          'optional human review APPROVE/REJECT and terminal trading_status TRADING_CONFIRMED/HUMAN_REJECTED/NON_TRADING',
        futureDashboardVisible: 'ADMIT_CONFIRMED or ADMIT_REVIEW only',
        transaction: 'BEGIN TRANSACTION READ ONLY; COMMIT; zero writes'
      },
      totals: {
        operatorVisibleChannels: operatorVisible,
        evaluatedWithFocusAndCoverage: evaluated,
        excludedMissingFocusOrCoverage: excludedExamples.length,
        historicalEvidenceEligibilityRate: eligibilityRate,
        reliableForPopulationInference,
        decisionCounts,
        projectedDashboardVisible: decisionCounts.ADMIT_CONFIRMED + decisionCounts.ADMIT_REVIEW,
        projectedDashboardVisibleRate:
          evaluated > 0
            ? (decisionCounts.ADMIT_CONFIRMED + decisionCounts.ADMIT_REVIEW) / evaluated
            : null,
        projectedWithheldOrDeferred: decisionCounts.WITHHOLD + decisionCounts.DEFER_INVESTIGATION,
        projectedReviewReduction,
        labeledExamples: labeledExamples.length,
        falsePositiveReduction: labeledReport?.metrics.falsePositiveReduction || null,
        genuineCreatorRecall: labeledReport?.metrics.genuineCreatorRecall || null
      },
      needsReviewFortyToFiftyGeneralTrading: {
        channels: needsReviewBand.length,
        evaluated: needsReviewBandEvaluated.length,
        decisionCounts: {
          ADMIT_CONFIRMED: needsReviewBandEvaluated.filter((r) => r.decision === 'ADMIT_CONFIRMED').length,
          ADMIT_REVIEW: needsReviewBandEvaluated.filter((r) => r.decision === 'ADMIT_REVIEW').length,
          WITHHOLD: needsReviewBandEvaluated.filter((r) => r.decision === 'WITHHOLD').length,
          DEFER_INVESTIGATION: needsReviewBandEvaluated.filter((r) => r.decision === 'DEFER_INVESTIGATION').length
        },
        futureDashboardVisible: needsReviewBandEvaluated.filter((r) => r.futureDashboardVisible).length
      },
      breakdowns: {
        byCountry: segmentBreakdown(channelRows, (r) => r.country),
        byLanguage: segmentBreakdown(channelRows, (r) => r.language),
        byDiscoverySource: segmentBreakdown(channelRows, (r) => r.discoverySource),
        byTradingStatus: segmentBreakdown(channelRows, (r) => r.tradingStatus),
        byConfidenceBand: segmentBreakdown(channelRows, (r) => r.confidenceBand),
        byCategory: segmentBreakdown(channelRows, (r) => r.tradingCategory),
        exclusionReasons: countBy(excludedExamples.map((e) => e.reasonCode))
      },
      representativeOutOfDomain,
      labeledOfflineReport: labeledReport
        ? {
            metrics: labeledReport.metrics,
            decisionCounts: labeledReport.decisionCounts,
            evaluatedExamples: labeledReport.evaluatedExamples,
            hypothesisAssessment: labeledReport.hypothesisAssessment,
            servingAuthority: labeledReport.servingAuthority
          }
        : null,
      inputChecksum: checksum({
        operatorVisible,
        evaluated,
        decisionCounts,
        excluded: excludedExamples.length
      })
    };
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    db.release();
    await pool.end();
  }
}
