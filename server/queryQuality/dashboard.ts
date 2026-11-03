import { rewardRate } from './accounting';
import type { QueryQualityVector } from './types';

/**
 * Q6 operator surface: query quality, admission reasons, selection/stop reason
 * and quota. This module is a pure projection over existing DB reads. It never
 * mutates a query, never triggers generation and never spends quota.
 *
 * Honesty rules:
 * - only completed runs with a persisted `qualityVector` contribute to reward;
 * - rows without the vector are reported as unaccounted, not as zero yield;
 * - a missing stop reason is reported as missing, not guessed;
 * - admission data is the stored admission, not a re-classification.
 */
export const QUERY_QUALITY_DASHBOARD_VERSION = 'query-quality-dashboard-v1';
export const QUERY_QUALITY_DASHBOARD_MAX_ROWS = 200;

export interface QueryQualityDashboardAdmission {
  tier?: string;
  compositionFamily?: string;
  reasonCodes?: string[];
  source?: string;
  eligible?: boolean;
}

export interface QueryQualityDashboardRunInput {
  runId: string;
  queryId: number;
  query: string;
  country: string;
  status: string;
  selectionStrategy: string;
  selectionReason: string;
  stopReason?: string | null;
  quotaUsed: number;
  completedAt?: string | null;
  performanceScore?: number;
  qualityVector?: Partial<QueryQualityVector> | null;
  admission?: QueryQualityDashboardAdmission | null;
}

export interface QueryQualityDashboardRun extends QueryQualityDashboardRunInput {
  qualityVector: QueryQualityVector | null;
  accounted: boolean;
}

export interface QueryQualityDashboard {
  version: string;
  generatedAt: string;
  /** Maximum runs included in this projection. */
  rowLimit: number;
  /** True when the read hit the row limit, so totals are a window not all time. */
  truncated: boolean;
  portfolio: {
    dailyQuotaUnits: number;
    portfolioRatio: number;
    portfolioUnitsReserved: number;
    /** Authoritative shared (all-country) budget usage. */
    portfolioUnitsUsed: number;
    /** Usage attributed to the selected country filter, if one was applied. */
    countryUnitsUsed: number | null;
    portfolioShareUsed: number;
    withinBudget: boolean;
  };
  totals: {
    runs: number;
    completedRuns: number;
    pendingRuns: number;
    failedRuns: number;
    accountedRuns: number;
    /** Accounted runs whose vector is eligible for reward (not degraded/failed/zero-quota). */
    rewardEligibleRuns: number;
    /**
     * Accounted, non-degraded/non-failed runs that spent no quota. They are
     * reported separately so free-provider confirmations cannot be read as
     * quota yield.
     */
    zeroQuotaRuns: number;
    unaccountedCompletedRuns: number;
    newConfirmedCreators: number;
    newQualityCreators: number;
    quotaUnits: number;
    confirmedNewCreatorsPer100Quota: number;
    qualityNewCreatorsPer100Quota: number;
    zeroConfirmRuns: number;
    zeroConfirmShare: number;
    /** Null when no reward-eligible run measured target-market membership. */
    targetMarketPrecision: number | null;
    duplicateRatio: number;
    providerDegradedRuns: number;
  };
  selection: {
    strategies: Record<string, number>;
    stopReasons: Array<{ reason: string; count: number }>;
    stopReasonCoverage: number;
    admissionRejections: Array<{ reason: string; count: number }>;
    admissionTiers: Record<string, number>;
    compositionFamilies: Record<string, number>;
  };
  rows: QueryQualityDashboardRun[];
}

const safe = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

const increment = (counts: Record<string, number>, key: string | null | undefined): void => {
  const normalized = String(key || 'UNKNOWN');
  counts[normalized] = (counts[normalized] || 0) + 1;
};

const topCounts = (counts: Record<string, number>): Array<{ reason: string; count: number }> =>
  Object.entries(counts)
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));

function normalizeVector(value: Partial<QueryQualityVector> | null | undefined): QueryQualityVector | null {
  if (!value || typeof value !== 'object') return null;
  // The vector is persisted by buildQueryQualityVector. Accept only a vector
  // with the versioned identity so an unrelated JSONB object cannot be
  // silently counted as reward.
  if (!value.version || !String(value.version).startsWith('query-quality-vector-')) return null;
  return {
    version: String(value.version),
    rawResults: safe(value.rawResults),
    evaluatedRawResults: safe(value.evaluatedRawResults),
    distinctResults: safe(value.distinctResults),
    newChannels: safe(value.newChannels),
    newConfirmedCreators: safe(value.newConfirmedCreators),
    newQualityCreators: safe(value.newQualityCreators),
    quotaUsed: safe(value.quotaUsed),
    quotaUnits: safe(value.quotaUnits),
    confirmedNewCreatorsPer100Quota: safe(value.confirmedNewCreatorsPer100Quota),
    qualityNewCreatorsPer100Quota: safe(value.qualityNewCreatorsPer100Quota),
    duplicateRatio: safe(value.duplicateRatio),
    semanticOverlapRatio: safe(value.semanticOverlapRatio),
    invalidQueryRate: safe(value.invalidQueryRate),
    zeroResultRate: safe(value.zeroResultRate),
    targetMarketPrecision: value.targetMarketPrecision === null || value.targetMarketPrecision === undefined
      ? null
      : safe(value.targetMarketPrecision),
    languageMatchRate: value.languageMatchRate === null || value.languageMatchRate === undefined
      ? null
      : safe(value.languageMatchRate),
    providerDegraded: value.providerDegraded === true,
    failedRun: value.failedRun === true,
  };
}

export function buildQueryQualityDashboard(input: {
  generatedAt: string;
  portfolio: {
    dailyQuotaUnits: number;
    portfolioUnitsReserved: number;
    portfolioUnitsUsed: number;
    countryUnitsUsed?: number;
  };
  rows: QueryQualityDashboardRunInput[];
}): QueryQualityDashboard {
  // The route fetches one extra row to distinguish "exactly at the limit"
  // from "more rows were omitted". Slice before computing totals so every
  // reported aggregate is over the same visible window.
  const truncated = input.rows.length > QUERY_QUALITY_DASHBOARD_MAX_ROWS;
  const rows: QueryQualityDashboardRun[] = input.rows.slice(0, QUERY_QUALITY_DASHBOARD_MAX_ROWS).map(row => {
    const qualityVector = normalizeVector(row.qualityVector);
    return { ...row, qualityVector, accounted: row.status === 'COMPLETED' && qualityVector !== null };
  });

  const completed = rows.filter(row => row.status === 'COMPLETED');
  const pending = rows.filter(row => ['SCHEDULED', 'RUNNING', 'RETRYING'].includes(row.status));
  const failed = rows.filter(row => row.status === 'FAILED');
  const accounted = rows.filter(row => row.accounted);
  // Provider failure is not zero yield. A degraded/failed run remains visible
  // as accounted but never enters reward totals or the zero-confirm share.
  // Zero-quota runs are likewise ineligible: they cannot contribute creators
  // to a per-100-quota rate they never paid for.
  const rewardEligible = accounted.filter(row => rewardRate(row.qualityVector!).eligible);
  const zeroQuotaRuns = accounted.filter(row => {
    const vector = row.qualityVector!;
    return !vector.providerDegraded && !vector.failedRun && vector.quotaUsed <= 0;
  }).length;

  let newConfirmedCreators = 0;
  let newQualityCreators = 0;
  let quotaUnits = 0;
  let distinctResults = 0;
  let weightedTargetPrecision = 0;
  let targetPrecisionResults = 0;
  let duplicateResults = 0;
  let evaluatedResults = 0;
  let zeroConfirmRuns = 0;
  for (const row of rewardEligible) {
    const vector = row.qualityVector!;
    newConfirmedCreators += vector.newConfirmedCreators;
    newQualityCreators += vector.newQualityCreators;
    quotaUnits += vector.quotaUnits;
    distinctResults += vector.distinctResults;
    if (vector.targetMarketPrecision !== null) {
      weightedTargetPrecision += vector.targetMarketPrecision * vector.distinctResults;
      targetPrecisionResults += vector.distinctResults;
    }
    // Prefer the persisted evaluated count. Older vectors predate the field;
    // reconstruct it from the duplicate ratio so both shapes use the same
    // denominator as the source metric.
    const duplicateRatio = Math.min(1, vector.duplicateRatio);
    const storedEvaluated = safe(vector.evaluatedRawResults);
    const boundedEvaluated = storedEvaluated > 0
      ? storedEvaluated
      : duplicateRatio >= 1
        ? vector.rawResults
        : vector.distinctResults / (1 - duplicateRatio);
    evaluatedResults += boundedEvaluated;
    duplicateResults += Math.max(0, boundedEvaluated - vector.distinctResults);
    if (vector.newConfirmedCreators === 0) zeroConfirmRuns++;
  }
  // Degradation is an operator diagnostic over all accounted runs, including
  // the ones excluded from reward above.
  const providerDegradedRuns = accounted.filter(row => row.qualityVector!.providerDegraded).length;

  const strategies: Record<string, number> = {};
  const admissionRejections: Record<string, number> = {};
  const admissionTiers: Record<string, number> = {};
  const compositionFamilies: Record<string, number> = {};
  const stopReasons: Record<string, number> = {};
  let completedRowsWithStopReason = 0;
  const nonRejectionMarkers = new Set(['LEGACY_UNSCOPED_ADMISSION_COMPATIBILITY']);
  for (const row of rows) {
    increment(strategies, row.selectionStrategy);
    if (row.status === 'COMPLETED') {
      if (row.stopReason) {
        increment(stopReasons, row.stopReason);
        completedRowsWithStopReason++;
      }
      // Rejections are only meaningful for an ineligible admission. Informational
      // markers (e.g. legacy compatibility/backfill) are not rejections.
      if (row.admission?.eligible === false) {
        for (const reason of row.admission.reasonCodes || []) {
          if (!nonRejectionMarkers.has(reason)) increment(admissionRejections, reason);
        }
      }
    }
    if (row.admission?.tier) increment(admissionTiers, row.admission.tier);
    if (row.admission?.compositionFamily) increment(compositionFamilies, row.admission.compositionFamily);
  }

  const dailyQuotaUnits = Math.max(0, safe(input.portfolio.dailyQuotaUnits));
  const portfolioUnitsUsed = safe(input.portfolio.portfolioUnitsUsed);
  const countryUnitsUsed = input.portfolio.countryUnitsUsed === undefined ? null : safe(input.portfolio.countryUnitsUsed);
  const portfolioUnitsReserved = safe(input.portfolio.portfolioUnitsReserved);
  // Rates use reward-eligible spend only. Falling back to every accounted run
  // would make the denominator include degraded/failed spend that the
  // numerator explicitly excludes.
  const effectiveQuotaUnits = quotaUnits;

  return {
    version: QUERY_QUALITY_DASHBOARD_VERSION,
    generatedAt: input.generatedAt,
    rowLimit: QUERY_QUALITY_DASHBOARD_MAX_ROWS,
    truncated,
    portfolio: {
      dailyQuotaUnits,
      portfolioRatio: dailyQuotaUnits > 0 ? portfolioUnitsReserved / dailyQuotaUnits : 0,
      portfolioUnitsReserved,
      portfolioUnitsUsed,
      countryUnitsUsed,
      portfolioShareUsed: dailyQuotaUnits > 0 ? portfolioUnitsUsed / dailyQuotaUnits : 0,
      withinBudget: portfolioUnitsUsed <= portfolioUnitsReserved + 1e-9,
    },
    totals: {
      runs: rows.length,
      completedRuns: completed.length,
      pendingRuns: pending.length,
      failedRuns: failed.length,
      accountedRuns: accounted.length,
      rewardEligibleRuns: rewardEligible.length,
      zeroQuotaRuns,
      unaccountedCompletedRuns: completed.length - accounted.length,
      newConfirmedCreators,
      newQualityCreators,
      quotaUnits: effectiveQuotaUnits,
      confirmedNewCreatorsPer100Quota: effectiveQuotaUnits > 0 ? newConfirmedCreators / effectiveQuotaUnits : 0,
      qualityNewCreatorsPer100Quota: effectiveQuotaUnits > 0 ? newQualityCreators / effectiveQuotaUnits : 0,
      zeroConfirmRuns,
      zeroConfirmShare: rewardEligible.length > 0 ? zeroConfirmRuns / rewardEligible.length : 0,
      targetMarketPrecision: targetPrecisionResults > 0 ? weightedTargetPrecision / targetPrecisionResults : null,
      duplicateRatio: evaluatedResults > 0 ? duplicateResults / evaluatedResults : 0,
      providerDegradedRuns,
    },
    selection: {
      strategies,
      stopReasons: topCounts(stopReasons),
      stopReasonCoverage: completed.length > 0 ? completedRowsWithStopReason / completed.length : 0,
      admissionRejections: topCounts(admissionRejections),
      admissionTiers,
      compositionFamilies,
    },
    rows,
  };
}
