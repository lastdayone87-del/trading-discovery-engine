import { getDb } from './db';
import {
  type RetrievalConfiguration,
  buildRetrievalConfiguration,
  ensureRetrievalConfigurationPersisted
} from './retrievalConfiguration';
import { getNeighborhoodRetrievalEvidence } from './retrievalPolicyEvidence';

export interface ShadowRetrievalRecommendationInput {
  opportunityKey: string;
  queryRunId?: string | null;
  neighborhoodKey: string;
  actualConfig: RetrievalConfiguration;
  now?: Date;
  clientOverride?: any;
}

export interface ShadowRetrievalRecommendationResult {
  id?: string;
  opportunityKey: string;
  queryRunId?: string | null;
  neighborhoodKey: string;
  actualConfigKey: string;
  recommendedConfigKey: string;
  expectedMarginalValue: number;
  uncertainty: number;
  expectedQuotaImpact: number;
  differsFromActual: boolean;
  evidence: Record<string, unknown>;
  createdAt: string;
}

/**
 * Evaluates candidate retrieval configurations for a neighborhood and returns the policy's preferred choice.
 */
export async function evaluatePreferredRetrievalConfig(
  neighborhoodKey: string,
  actualConfig: RetrievalConfiguration,
  clientOverride?: any
): Promise<{ recommendedConfig: RetrievalConfiguration; expectedMarginalValue: number; uncertainty: number; evidence: Record<string, unknown> }> {
  // Candidate configurations to evaluate for shadow recommendation
  const candidates: RetrievalConfiguration[] = [
    actualConfig,
    buildRetrievalConfiguration({ searchOrdering: 'RELEVANCE', retrievalLane: actualConfig.retrievalLane, requestedPageDepth: 1 }),
    buildRetrievalConfiguration({ searchOrdering: 'RELEVANCE', retrievalLane: actualConfig.retrievalLane, requestedPageDepth: 2 }),
    buildRetrievalConfiguration({ searchOrdering: 'DATE', retrievalLane: actualConfig.retrievalLane, requestedPageDepth: 1 }),
    buildRetrievalConfiguration({ searchOrdering: 'DATE', retrievalLane: actualConfig.retrievalLane, requestedPageDepth: 2 })
  ];

  // Deduplicate candidates by configKey
  const uniqueCandidates = Array.from(new Map(candidates.map(c => [c.configKey, c])).values());

  let bestCandidate = actualConfig;
  let bestScore = -Infinity;
  let bestExpectedValue = 0;
  let bestUncertainty = 1.0;
  const candidateEvidenceMap: Record<string, unknown> = {};

  for (const cand of uniqueCandidates) {
    const ev = await getNeighborhoodRetrievalEvidence(neighborhoodKey, cand.configKey, clientOverride);
    const executionCount = ev?.executionCount || 0;
    const expValue = ev?.expectedMarginalValue || (cand.searchOrdering === 'DATE' ? 45 : 50);
    const uncert = ev?.uncertainty ?? (executionCount === 0 ? 1.0 : 0.5);

    // UCB1 scoring for retrieval configurations: expected value + exploration bonus
    const score = expValue + (uncert * 20);

    candidateEvidenceMap[cand.configKey] = {
      searchOrdering: cand.searchOrdering,
      retrievalLane: cand.retrievalLane,
      requestedPageDepth: cand.requestedPageDepth,
      executionCount,
      expectedMarginalValue: expValue,
      uncertainty: uncert,
      ucbScore: score
    };

    if (score > bestScore) {
      bestScore = score;
      bestCandidate = cand;
      bestExpectedValue = expValue;
      bestUncertainty = uncert;
    }
  }

  return {
    recommendedConfig: bestCandidate,
    expectedMarginalValue: bestExpectedValue,
    uncertainty: bestUncertainty,
    evidence: {
      evaluatedCandidatesCount: uniqueCandidates.length,
      candidateEvidence: candidateEvidenceMap,
      winningConfigKey: bestCandidate.configKey
    }
  };
}

/**
 * Evaluates and persists a shadow retrieval policy recommendation at the scheduling boundary.
 *
 * ZERO SERVING AUTHORITY:
 * Returns diagnostic evaluation without altering search ordering, retrieval lane,
 * page depth, or continuation.
 */
export async function evaluateShadowRetrievalRecommendation(
  input: ShadowRetrievalRecommendationInput
): Promise<ShadowRetrievalRecommendationResult> {
  const now = input.now || new Date();
  const runner = input.clientOverride || (process.env.DATABASE_URL ? await getDb() : null);

  // Ensure both actual and recommended configurations are persisted in lookup table
  if (runner) {
    await ensureRetrievalConfigurationPersisted(input.actualConfig, runner);
  }

  const { recommendedConfig, expectedMarginalValue, uncertainty, evidence } =
    await evaluatePreferredRetrievalConfig(input.neighborhoodKey, input.actualConfig, runner);

  if (runner) {
    await ensureRetrievalConfigurationPersisted(recommendedConfig, runner);
  }

  const differsFromActual = recommendedConfig.configKey !== input.actualConfig.configKey;
  const expectedQuotaImpact = (recommendedConfig.requestedPageDepth - input.actualConfig.requestedPageDepth) * 100;

  const result: ShadowRetrievalRecommendationResult = {
    opportunityKey: input.opportunityKey,
    queryRunId: input.queryRunId || null,
    neighborhoodKey: input.neighborhoodKey,
    actualConfigKey: input.actualConfig.configKey,
    recommendedConfigKey: recommendedConfig.configKey,
    expectedMarginalValue,
    uncertainty,
    expectedQuotaImpact,
    differsFromActual,
    evidence,
    createdAt: now.toISOString()
  };

  if (runner) {
    await runner.query(
      `INSERT INTO retrieval_policy_shadow_recommendations(
         opportunity_key, query_run_id, neighborhood_key, actual_config_key,
         recommended_config_key, expected_marginal_value, uncertainty,
         expected_quota_impact, differs_from_actual, evidence, created_at
       )
       VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        result.opportunityKey,
        result.queryRunId,
        result.neighborhoodKey,
        result.actualConfigKey,
        result.recommendedConfigKey,
        result.expectedMarginalValue,
        result.uncertainty,
        result.expectedQuotaImpact,
        result.differsFromActual,
        JSON.stringify(result.evidence),
        result.createdAt
      ]
    ).catch((err: unknown) => console.warn('[RetrievalPolicyShadow] Failed to record shadow recommendation:', err));
  }

  return result;
}
