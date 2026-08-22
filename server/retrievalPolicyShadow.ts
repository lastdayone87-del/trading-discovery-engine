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
  controlConfig: RetrievalConfiguration;
  executedConfig: RetrievalConfiguration;
  now?: Date;
  clientOverride?: any;
}

export interface ShadowRetrievalRecommendationResult {
  id?: string;
  opportunityKey: string;
  queryRunId?: string | null;
  neighborhoodKey: string;
  controlConfigKey: string;
  executedConfigKey: string;
  recommendedConfigKey: string;
  expectedMarginalValue: number;
  uncertainty: number;
  expectedQuotaImpact: number;
  differsFromControl: boolean;
  differsFromExecuted: boolean;
  evidence: Record<string, unknown>;
  createdAt: string;
}

/**
 * Evaluates candidate retrieval configurations for a neighborhood and returns the policy's preferred choice.
 */
export async function evaluatePreferredRetrievalConfig(
  neighborhoodKey: string,
  baseConfig: RetrievalConfiguration,
  clientOverride?: any
): Promise<{ recommendedConfig: RetrievalConfiguration; expectedMarginalValue: number; uncertainty: number; evidence: Record<string, unknown> }> {
  // Candidate configurations to evaluate for shadow recommendation
  const candidates: RetrievalConfiguration[] = [
    baseConfig,
    buildRetrievalConfiguration({ searchOrdering: 'RELEVANCE', retrievalLane: baseConfig.retrievalLane, requestedPageDepth: 1 }),
    buildRetrievalConfiguration({ searchOrdering: 'RELEVANCE', retrievalLane: baseConfig.retrievalLane, requestedPageDepth: 2 }),
    buildRetrievalConfiguration({ searchOrdering: 'DATE', retrievalLane: baseConfig.retrievalLane, requestedPageDepth: 1 }),
    buildRetrievalConfiguration({ searchOrdering: 'DATE', retrievalLane: baseConfig.retrievalLane, requestedPageDepth: 2 })
  ];

  // Deduplicate candidates by configKey
  const uniqueCandidates = Array.from(new Map(candidates.map(c => [c.configKey, c])).values());

  let bestCandidate = baseConfig;
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

const SHADOW_SAVEPOINT = 'retrieval_policy_shadow_recommendation';

function shadowFailureClass(error: unknown): string {
  if (error instanceof Error && error.name) return error.name;
  if (typeof error === 'string' && error.trim()) return 'STRING_ERROR';
  return 'UNKNOWN_ERROR';
}

function buildShadowRecommendationResult(
  input: ShadowRetrievalRecommendationInput,
  now: Date,
  recommendedConfig: RetrievalConfiguration,
  expectedMarginalValue: number,
  uncertainty: number,
  evidence: Record<string, unknown>
): ShadowRetrievalRecommendationResult {
  return {
    opportunityKey: input.opportunityKey,
    queryRunId: input.queryRunId || null,
    neighborhoodKey: input.neighborhoodKey,
    controlConfigKey: input.controlConfig.configKey,
    executedConfigKey: input.executedConfig.configKey,
    recommendedConfigKey: recommendedConfig.configKey,
    expectedMarginalValue,
    uncertainty,
    expectedQuotaImpact: (recommendedConfig.requestedPageDepth - input.executedConfig.requestedPageDepth) * 100,
    differsFromControl: recommendedConfig.configKey !== input.controlConfig.configKey,
    differsFromExecuted: recommendedConfig.configKey !== input.executedConfig.configKey,
    evidence,
    createdAt: now.toISOString()
  };
}

/**
 * Evaluates and persists a shadow retrieval policy recommendation at the scheduling boundary.
 *
 * ZERO SERVING AUTHORITY:
 * Returns diagnostic evaluation without altering search ordering, retrieval lane,
 * page depth, or continuation. Optional shadow persistence is isolated from a
 * caller-owned transaction and skipped when its neighborhood parent is absent.
 */
export async function evaluateShadowRetrievalRecommendation(
  input: ShadowRetrievalRecommendationInput
): Promise<ShadowRetrievalRecommendationResult> {
  const now = input.now || new Date();
  const suppliedRunner = input.clientOverride || null;
  const pool = suppliedRunner ? null : (process.env.DATABASE_URL ? await getDb() : null);
  const runner = suppliedRunner || (pool ? await pool.connect() : null);
  const ownsTransaction = !suppliedRunner && Boolean(runner);

  if (!runner) {
    const { recommendedConfig, expectedMarginalValue, uncertainty, evidence } =
      await evaluatePreferredRetrievalConfig(input.neighborhoodKey, input.executedConfig, runner);
    return buildShadowRecommendationResult(
      input,
      now,
      recommendedConfig,
      expectedMarginalValue,
      uncertainty,
      { ...evidence, shadowPersistenceStatus: 'NOT_PERSISTED_NO_RUNNER' }
    );
  }

  let savepointOpen = false;
  try {
    if (ownsTransaction) await runner.query('BEGIN');
    await runner.query(`SAVEPOINT ${SHADOW_SAVEPOINT}`);
    savepointOpen = true;

    const parent = await runner.query(
      'SELECT 1 FROM discovery_neighborhoods WHERE neighborhood_key = $1 LIMIT 1',
      [input.neighborhoodKey]
    );
    if (!parent.rowCount) {
      await runner.query(`RELEASE SAVEPOINT ${SHADOW_SAVEPOINT}`);
      savepointOpen = false;
      if (ownsTransaction) await runner.query('ROLLBACK');
      return buildShadowRecommendationResult(
        input,
        now,
        input.executedConfig,
        0,
        1,
        {
          shadowPersistenceStatus: 'SKIPPED_NEIGHBORHOOD_PARENT_MISSING',
          neighborhoodKeyValidated: false,
          evaluatedConfigKey: input.executedConfig.configKey
        }
      );
    }

    await ensureRetrievalConfigurationPersisted(input.controlConfig, runner);
    await ensureRetrievalConfigurationPersisted(input.executedConfig, runner);
    const { recommendedConfig, expectedMarginalValue, uncertainty, evidence } =
      await evaluatePreferredRetrievalConfig(input.neighborhoodKey, input.executedConfig, runner);
    await ensureRetrievalConfigurationPersisted(recommendedConfig, runner);

    const result = buildShadowRecommendationResult(
      input,
      now,
      recommendedConfig,
      expectedMarginalValue,
      uncertainty,
      { ...evidence, shadowPersistenceStatus: 'PERSISTED', neighborhoodKeyValidated: true }
    );

    await runner.query(
      `INSERT INTO retrieval_policy_shadow_recommendations(
         opportunity_key, query_run_id, neighborhood_key, control_config_key,
         executed_config_key, recommended_config_key, expected_marginal_value,
         uncertainty, expected_quota_impact, differs_from_control, differs_from_executed,
         evidence, created_at
       )
       VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        result.opportunityKey,
        result.queryRunId,
        result.neighborhoodKey,
        result.controlConfigKey,
        result.executedConfigKey,
        result.recommendedConfigKey,
        result.expectedMarginalValue,
        result.uncertainty,
        result.expectedQuotaImpact,
        result.differsFromControl,
        result.differsFromExecuted,
        JSON.stringify(result.evidence),
        result.createdAt
      ]
    );
    await runner.query(`RELEASE SAVEPOINT ${SHADOW_SAVEPOINT}`);
    savepointOpen = false;
    if (ownsTransaction) await runner.query('COMMIT');
    return result;
  } catch (error: unknown) {
    if (savepointOpen) {
      try {
        await runner.query(`ROLLBACK TO SAVEPOINT ${SHADOW_SAVEPOINT}`);
        await runner.query(`RELEASE SAVEPOINT ${SHADOW_SAVEPOINT}`);
      } catch (isolationError: unknown) {
        console.warn('[RetrievalPolicyShadow] Failed to restore caller transaction after isolated shadow failure:', shadowFailureClass(isolationError));
      }
    }
    if (ownsTransaction) {
      try {
        await runner.query('ROLLBACK');
      } catch (rollbackError: unknown) {
        console.warn('[RetrievalPolicyShadow] Failed to roll back private shadow transaction:', shadowFailureClass(rollbackError));
      }
    }
    const failureClass = shadowFailureClass(error);
    console.warn('[RetrievalPolicyShadow] Shadow recommendation skipped after isolated failure:', failureClass);
    return buildShadowRecommendationResult(
      input,
      now,
      input.executedConfig,
      0,
      1,
      {
        shadowPersistenceStatus: 'SKIPPED_ISOLATED_FAILURE',
        neighborhoodKeyValidated: false,
        shadowFailureClass: failureClass
      }
    );
  } finally {
    if (ownsTransaction) runner.release();
  }
}
