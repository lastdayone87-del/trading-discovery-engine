import { createHash } from 'node:crypto';
import { runStage2PostFixShadowEvaluation } from './stage2PostFixShadowEvaluation';

export const STAGE2_RATE_PRESSURE_POLICY_VERSION = 'stage2-rate-pressure-shadow-v1';

const rate = (n: number, d: number) => d > 0 ? n / d : null;
const checksum = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function providerDegraded(row: any): boolean {
  return Array.isArray(row?.evidenceCoverage?.acquisitionFailures) && row.evidenceCoverage.acquisitionFailures.length > 0;
}

/**
 * Shadow-only fallback for semantic-provider rate pressure.
 *
 * This does NOT infer a specific alternative creator identity. It only permits a
 * counterfactual WITHHOLD when broad, recent, independent creator-level coverage
 * repeatedly fails to produce even a minimal trading hypothesis while the
 * semantic provider is degraded. Narrow/sparse evidence still defers.
 *
 * The policy has no serving authority and is evaluated only against the sealed
 * Stage 1 cohort before any production consideration.
 */
export function applyStage2RatePressureShadowPolicy(row: any) {
  if (row.decision !== 'DEFER_INVESTIGATION') return { ...row, ratePressureFallbackApplied: false };

  const coverage = row.evidenceCoverage || {};
  const focus = row.creatorFocus || {};
  const broadCoverage = coverage.disposition === 'SUFFICIENT'
    && Number(coverage.observedDocumentCount || 0) >= 10
    && Number(coverage.independentFamilyCount || 0) >= 3;
  const capabilityReady = focus.supportedLanguage === true && focus.recentEvidence === true;
  const noTradingSignal = Number(focus.tradingMass || 0) < 0.05;

  if (providerDegraded(row) && broadCoverage && capabilityReady && noTradingSignal) {
    return {
      ...row,
      decision: 'WITHHOLD',
      reasonCodes: [
        'BROAD_CREATOR_COVERAGE_NO_TRADING_SIGNAL',
        'SEMANTIC_PROVIDER_DEGRADED_SHADOW_FALLBACK',
        'COUNTERFACTUAL_ONLY_NO_SERVING_AUTHORITY'
      ],
      reasoning: [
        ...(Array.isArray(row.reasoning) ? row.reasoning : []),
        `Shadow fallback: ${coverage.observedDocumentCount} documents across ${coverage.independentFamilyCount} independent families produced trading mass ${Number(focus.tradingMass || 0).toFixed(4)} during provider degradation.`
      ],
      ratePressureFallbackApplied: true,
      originalDecision: row.decision
    };
  }

  return { ...row, ratePressureFallbackApplied: false };
}

export async function runStage2RatePressureShadowEvaluation(requestedDatasetId?: string) {
  const base = await runStage2PostFixShadowEvaluation(requestedDatasetId);
  const rows = base.rows.map(applyStage2RatePressureShadowPolicy);
  const counts = { ADMIT_CONFIRMED: 0, ADMIT_REVIEW: 0, WITHHOLD: 0, DEFER_INVESTIGATION: 0 } as Record<string, number>;
  for (const row of rows) counts[row.decision] = (counts[row.decision] || 0) + 1;

  const nonTrading = rows.filter((row: any) => row.groundTruth === 'NON_TRADING');
  const genuine = rows.filter((row: any) => row.groundTruth === 'TRADING_CONFIRMED');
  const withheldNonTrading = nonTrading.filter((row: any) => row.decision === 'WITHHOLD');
  const withheldGenuine = genuine.filter((row: any) => row.decision === 'WITHHOLD');
  const retainedGenuine = genuine.filter((row: any) => row.decision !== 'WITHHOLD');
  const decisive = rows.filter((row: any) => row.decision === 'WITHHOLD' || row.decision === 'ADMIT_CONFIRMED');
  const fallbackRows = rows.filter((row: any) => row.ratePressureFallbackApplied);

  return {
    reportType: 'STAGE2_RATE_PRESSURE_SHADOW_EVALUATION',
    version: STAGE2_RATE_PRESSURE_POLICY_VERSION,
    datasetId: base.datasetId,
    baseReportVersion: base.version,
    groundTruthAnchor: 'SEALED_STAGE1_DATASET',
    servingAuthority: false,
    automaticPromotion: false,
    mutatesOperationalState: false,
    policyBoundary: 'COUNTERFACTUAL_SHADOW_ONLY',
    totals: {
      sealedExamples: base.totals.sealedExamples,
      evaluated: rows.length,
      failed: base.failures.length,
      decisionCounts: counts,
      fallbackApplied: fallbackRows.length
    },
    metrics: {
      evaluationCoverage: { rate: rate(rows.length, base.totals.sealedExamples) },
      decisiveDecisionRate: { decisive: decisive.length, evaluated: rows.length, rate: rate(decisive.length, rows.length) },
      nonTradingWithhold: { nonTradingCreators: nonTrading.length, withheldNonTrading: withheldNonTrading.length, rate: rate(withheldNonTrading.length, nonTrading.length) },
      genuineCreatorRecall: { genuineCreators: genuine.length, retainedCreators: retainedGenuine.length, rate: rate(retainedGenuine.length, genuine.length) },
      genuineCreatorFalseWithhold: { genuineCreators: genuine.length, withheldGenuine: withheldGenuine.length, rate: rate(withheldGenuine.length, genuine.length) },
      providerDegradation: base.metrics.providerDegradation
    },
    failures: base.failures,
    rows,
    outputChecksum: checksum(rows.map((row: any) => ({ exampleKey: row.exampleKey, decision: row.decision, fallback: row.ratePressureFallbackApplied }))),
    nextAction: withheldGenuine.length > 0
      ? 'REJECT_RATE_PRESSURE_FALLBACK_FALSE_WITHHOLD'
      : fallbackRows.length === 0
        ? 'RATE_PRESSURE_FALLBACK_PRODUCED_NO_DECISIONS'
        : 'REVIEW_RATE_PRESSURE_SHADOW_METRICS'
  };
}
