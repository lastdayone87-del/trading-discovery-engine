import { getDb } from './db';
import { evaluateNeighborhoodTrend } from './neighborhoodAnalytics';

export type NeighborhoodFrontierState =
  | 'UNEXPLORED'
  | 'PROBING'
  | 'PRODUCTIVE'
  | 'PARTIALLY_OBSERVED'
  | 'SATURATING'
  | 'SATURATED'
  | 'MAINTENANCE'
  | 'HARMFUL'
  | 'UNKNOWN';

export interface NeighborhoodFrontierEvidence {
  neighborhoodKey: string;
  observationCount: number;
  expectedMarginalValue: number;
  observedMarginalValue: number;
  relevantNewYield: number;
  qualityNewYield: number;
  knownCreatorRatio: number;
  jaccardSimilarity: number | null;
  resultSetOverlap: number | null;
  recentYieldTrend: number[];
  recentOverlapTrend: number[];
  isSaturating: boolean;
  quotaEfficiency: number; // yield per 1000 quota
  uncertainty?: number;
  recencyHours?: number;
  coverageContribution?: number;
}

export interface FrontierStateEvaluationResult {
  state: NeighborhoodFrontierState;
  reason: string;
  evidence: NeighborhoodFrontierEvidence;
}

export interface PersistedFrontierState {
  neighborhoodKey: string;
  state: NeighborhoodFrontierState;
  previousState: NeighborhoodFrontierState | null;
  transitionReason: string;
  evidence: Record<string, unknown>;
  observationCount: number;
  lastObservedAt: string;
  updatedAt: string;
  createdAt: string;
}

/**
 * Deterministically evaluates neighborhood frontier state based on accumulated evidence.
 */
export function evaluateNeighborhoodFrontierState(
  evidence: NeighborhoodFrontierEvidence
): FrontierStateEvaluationResult {
  const {
    observationCount,
    relevantNewYield,
    qualityNewYield,
    resultSetOverlap,
    isSaturating,
    observedMarginalValue,
    recentYieldTrend,
    quotaEfficiency
  } = evidence;

  // 1. UNEXPLORED
  if (observationCount === 0) {
    return {
      state: 'UNEXPLORED',
      reason: 'No historical retrieval observations recorded for this neighborhood.',
      evidence
    };
  }

  // 2. PROBING (Sparse evidence)
  if (observationCount < 3) {
    return {
      state: 'PROBING',
      reason: `Sparse evidence (${observationCount} observation(s)); insufficient observations for definitive classification.`,
      evidence
    };
  }

  // 3. HARMFUL
  // Negative ROI / zero yield with high quota cost and extreme noise
  if (
    observedMarginalValue === 0 &&
    relevantNewYield === 0 &&
    qualityNewYield === 0 &&
    evidence.knownCreatorRatio < 0.1 &&
    (resultSetOverlap || 0) > 0.8 &&
    observationCount >= 3
  ) {
    return {
      state: 'HARMFUL',
      reason: 'High quota expenditure with zero relevant/quality yields and extreme redundancy.',
      evidence
    };
  }

  // 4. SATURATION & MAINTENANCE
  const overlap = resultSetOverlap ?? 0;
  const isHighOverlapLowYield = overlap >= 0.75 && relevantNewYield < 0.05;
  if (isSaturating || isHighOverlapLowYield) {
    const historicalYieldSum = recentYieldTrend.reduce((a, b) => a + b, 0);
    if (historicalYieldSum > 0 || quotaEfficiency > 0) {
      return {
        state: 'MAINTENANCE',
        reason: 'Territory was historically productive but currently saturating; transitioned to maintenance monitoring.',
        evidence
      };
    }
    if (overlap >= 0.85 && relevantNewYield < 0.02) {
      return {
        state: 'SATURATED',
        reason: 'High result set overlap with negligible new creator yield across recent observations.',
        evidence
      };
    }
    return {
      state: 'SATURATING',
      reason: 'Declining novel creator yield combined with rising result set overlap.',
      evidence
    };
  }

  // 5. PRODUCTIVE
  if (
    relevantNewYield >= 0.15 ||
    qualityNewYield >= 0.10 ||
    observedMarginalValue >= 15 ||
    quotaEfficiency >= 1.0
  ) {
    return {
      state: 'PRODUCTIVE',
      reason: 'Sustained high relevant/quality creator yield and positive marginal discovery value.',
      evidence
    };
  }

  // 6. PARTIALLY_OBSERVED
  if (observationCount >= 3) {
    return {
      state: 'PARTIALLY_OBSERVED',
      reason: 'Moderate evidence collected with non-zero yield; ongoing discovery warranted.',
      evidence
    };
  }

  return {
    state: 'UNKNOWN',
    reason: 'Evidence profile does not meet explicit state classification thresholds.',
    evidence
  };
}

/**
 * Retrieves current persisted frontier state for a neighborhood.
 */
export async function getNeighborhoodFrontierState(
  neighborhoodKey: string
): Promise<PersistedFrontierState | null> {
  const db = await getDb();
  const res = await db.query(
    `SELECT neighborhood_key, state, previous_state, transition_reason, evidence,
            observation_count, last_observed_at, updated_at, created_at
     FROM discovery_neighborhood_frontier_states
     WHERE neighborhood_key = $1`,
    [neighborhoodKey]
  );
  if (!res.rows.length) return null;
  const row = res.rows[0];
  return {
    neighborhoodKey: row.neighborhood_key,
    state: row.state,
    previousState: row.previous_state || null,
    transitionReason: row.transition_reason,
    evidence: typeof row.evidence === 'string' ? JSON.parse(row.evidence) : row.evidence,
    observationCount: row.observation_count,
    lastObservedAt: row.last_observed_at,
    updatedAt: row.updated_at,
    createdAt: row.created_at
  };
}

/**
 * Persists neighborhood frontier state evaluation and records audit history if state transitions.
 */
export async function recordNeighborhoodFrontierStateTransition(
  neighborhoodKey: string,
  evaluation: FrontierStateEvaluationResult
): Promise<PersistedFrontierState> {
  const db = await getDb();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const existingRes = await client.query(
      `SELECT state FROM discovery_neighborhood_frontier_states WHERE neighborhood_key = $1 FOR UPDATE`,
      [neighborhoodKey]
    );
    const currentState = existingRes.rows[0]?.state || null;
    const newState = evaluation.state;

    const upsertRes = await client.query(
      `INSERT INTO discovery_neighborhood_frontier_states(
         neighborhood_key, state, previous_state, transition_reason, evidence,
         observation_count, last_observed_at, updated_at
       )
       VALUES($1, $2, $3, $4, $5, $6, now(), now())
       ON CONFLICT(neighborhood_key) DO UPDATE
       SET state = EXCLUDED.state,
           previous_state = COALESCE(discovery_neighborhood_frontier_states.state, EXCLUDED.previous_state),
           transition_reason = EXCLUDED.transition_reason,
           evidence = EXCLUDED.evidence,
           observation_count = EXCLUDED.observation_count,
           last_observed_at = now(),
           updated_at = now()
       RETURNING neighborhood_key, state, previous_state, transition_reason, evidence,
                 observation_count, last_observed_at, updated_at, created_at`,
      [
        neighborhoodKey,
        newState,
        currentState,
        evaluation.reason,
        JSON.stringify(evaluation.evidence),
        evaluation.evidence.observationCount
      ]
    );

    if (currentState !== newState) {
      await client.query(
        `INSERT INTO discovery_neighborhood_state_history(
           neighborhood_key, from_state, to_state, transition_reason, evidence
         )
         VALUES($1, $2, $3, $4, $5)`,
        [
          neighborhoodKey,
          currentState || 'UNEXPLORED',
          newState,
          evaluation.reason,
          JSON.stringify(evaluation.evidence)
        ]
      );
    }

    await client.query('COMMIT');
    const row = upsertRes.rows[0];
    return {
      neighborhoodKey: row.neighborhood_key,
      state: row.state,
      previousState: row.previous_state || null,
      transitionReason: row.transition_reason,
      evidence: typeof row.evidence === 'string' ? JSON.parse(row.evidence) : row.evidence,
      observationCount: row.observation_count,
      lastObservedAt: row.last_observed_at,
      updatedAt: row.updated_at,
      createdAt: row.created_at
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Post-commit shadow handler to update neighborhood frontier state from historical evidence.
 */
export async function updateNeighborhoodFrontierStatePostRun(
  neighborhoodKey: string
): Promise<PersistedFrontierState | null> {
  const db = await getDb();
  const obsRes = await db.query(
    `SELECT relevant_new_creator_ratio, quality_new_creator_ratio, known_creator_ratio,
            jaccard_similarity, result_set_overlap, quota_consumed, observed_at
     FROM neighborhood_observations
     WHERE neighborhood_key = $1
     ORDER BY observed_at DESC
     LIMIT 20`,
    [neighborhoodKey]
  );

  const mvRes = await db.query(
    `SELECT expected_marginal_value, observed_marginal_value
     FROM neighborhood_marginal_values
     WHERE neighborhood_key = $1
     ORDER BY calculated_at DESC
     LIMIT 1`,
    [neighborhoodKey]
  );

  const count = obsRes.rows.length;
  if (count === 0) {
    const unobservedEvidence: NeighborhoodFrontierEvidence = {
      neighborhoodKey,
      observationCount: 0,
      expectedMarginalValue: 0,
      observedMarginalValue: 0,
      relevantNewYield: 0,
      qualityNewYield: 0,
      knownCreatorRatio: 0,
      jaccardSimilarity: null,
      resultSetOverlap: null,
      recentYieldTrend: [],
      recentOverlapTrend: [],
      isSaturating: false,
      quotaEfficiency: 0
    };
    const evalResult = evaluateNeighborhoodFrontierState(unobservedEvidence);
    return recordNeighborhoodFrontierStateTransition(neighborhoodKey, evalResult);
  }

  const latestObs = obsRes.rows[0];
  const recentYields = obsRes.rows.map(r => Number(r.relevant_new_creator_ratio || 0)).reverse();
  const recentOverlaps = obsRes.rows.map(r => Number(r.result_set_overlap || 0)).reverse();
  const trend = evaluateNeighborhoodTrend(recentYields, recentOverlaps);

  const avgRelevantYield = recentYields.reduce((a, b) => a + b, 0) / count;
  const avgQualityYield = obsRes.rows.reduce((a, b) => a + Number(b.quality_new_creator_ratio || 0), 0) / count;
  const totalQuota = obsRes.rows.reduce((a, b) => a + Number(b.quota_consumed || 0), 0);
  const totalValuableCreators = obsRes.rows.reduce(
    (a, b) => a + Math.round(Number(b.quality_new_creator_ratio || 0) * 10),
    0
  );
  const quotaEfficiency = totalQuota > 0 ? (totalValuableCreators / totalQuota) * 1000 : 0;

  const expectedMV = Number(mvRes.rows[0]?.expected_marginal_value || 0);
  const observedMV = Number(mvRes.rows[0]?.observed_marginal_value || 0);

  const evidence: NeighborhoodFrontierEvidence = {
    neighborhoodKey,
    observationCount: count,
    expectedMarginalValue: expectedMV,
    observedMarginalValue: observedMV,
    relevantNewYield: Math.round(avgRelevantYield * 1000) / 1000,
    qualityNewYield: Math.round(avgQualityYield * 1000) / 1000,
    knownCreatorRatio: Number(latestObs.known_creator_ratio || 0),
    jaccardSimilarity: latestObs.jaccard_similarity !== null ? Number(latestObs.jaccard_similarity) : null,
    resultSetOverlap: latestObs.result_set_overlap !== null ? Number(latestObs.result_set_overlap) : null,
    recentYieldTrend: recentYields,
    recentOverlapTrend: recentOverlaps,
    isSaturating: trend.isSaturating,
    quotaEfficiency: Math.round(quotaEfficiency * 100) / 100
  };

  const evalResult = evaluateNeighborhoodFrontierState(evidence);
  return recordNeighborhoodFrontierStateTransition(neighborhoodKey, evalResult);
}
