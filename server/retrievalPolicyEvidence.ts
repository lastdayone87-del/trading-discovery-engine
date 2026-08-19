import { getDb } from './db';

export interface PageLevelYieldSummary {
  pageNumber: number;
  avgNewCreators: number;
  avgConfirmedCreators: number;
  avgQualityCreators: number;
  avgDuplicateRatio: number;
  sampleSize: number;
}

export interface NeighborhoodRetrievalEvidence {
  neighborhoodKey: string;
  configKey: string;
  executionCount: number;
  recentExecutionCount: number;
  expectedMarginalValue: number;
  observedMarginalValue: number;
  relevantNewYield: number;
  qualityNewYield: number;
  duplicateRate: number;
  knownCreatorRate: number;
  pageLevelYields: PageLevelYieldSummary[];
  quotaCost: number;
  uncertainty: number;
  exposureCount: number;
  lastTestedAt: string | null;
}

/**
 * Deterministically recomputes aggregate retrieval-policy neighborhood evidence
 * directly from canonical autonomous_query_page_observations.
 *
 * This operation is completely idempotent and restart-safe: re-running or retrying
 * for a run/page always produces the exact same aggregate state and never double-counts.
 */
export async function recomputeNeighborhoodRetrievalEvidence(
  neighborhoodKey: string,
  configKey: string,
  clientOverride?: any
): Promise<NeighborhoodRetrievalEvidence | null> {
  const runner = clientOverride || (process.env.DATABASE_URL ? await getDb() : null);
  if (!runner) return null;

  const summaryRes = await runner.query(
    `WITH canonical_runs AS (
       SELECT DISTINCT
         po.query_run_id,
         ran.neighborhood_key,
         COALESCE(po.retrieval_config_key, qr.retrieval_config_key) AS config_key,
         qr.created_at AS run_created_at
       FROM autonomous_query_page_observations po
       JOIN query_runs qr ON qr.id = po.query_run_id
       JOIN retrieval_action_neighborhoods ran ON ran.query_run_id = po.query_run_id
       WHERE ran.neighborhood_key = $1
         AND COALESCE(po.retrieval_config_key, qr.retrieval_config_key) = $2
     ),
     run_totals AS (
       SELECT
         cr.query_run_id,
         cr.run_created_at,
         COALESCE(SUM(po.quota_units), 100)::int AS run_quota,
         COALESCE(SUM(po.distinct_creator_count), 0)::int AS distinct_creators,
         COALESCE(SUM(po.new_creators), 0)::int AS new_creators,
         COALESCE(SUM(po.confirmed_creators), 0)::int AS confirmed_creators,
         COALESCE(SUM(po.quality_confirmed_creators), 0)::int AS quality_creators,
         COALESCE(SUM(po.known_creators), 0)::int AS known_creators,
         AVG(po.duplicate_ratio)::float AS avg_dup_ratio
       FROM canonical_runs cr
       JOIN autonomous_query_page_observations po ON po.query_run_id = cr.query_run_id
       GROUP BY cr.query_run_id, cr.run_created_at
     ),
     page_breakdown AS (
       SELECT
         po.page_number,
         COUNT(DISTINCT po.query_run_id)::int AS sample_size,
         AVG(po.new_creators)::float AS avg_new,
         AVG(po.confirmed_creators)::float AS avg_confirmed,
         AVG(po.quality_confirmed_creators)::float AS avg_quality,
         AVG(po.duplicate_ratio)::float AS avg_dup
       FROM canonical_runs cr
       JOIN autonomous_query_page_observations po ON po.query_run_id = cr.query_run_id
       GROUP BY po.page_number
       ORDER BY po.page_number ASC
     )
     SELECT
       COUNT(DISTINCT cr.query_run_id)::int AS execution_count,
       COUNT(DISTINCT cr.query_run_id) FILTER (WHERE cr.run_created_at >= now() - interval '7 days')::int AS recent_execution_count,
       COALESCE(AVG(rt.run_quota), 100)::float AS avg_quota_cost,
       COALESCE(AVG(CASE WHEN rt.distinct_creators > 0 THEN rt.confirmed_creators::float / rt.distinct_creators ELSE 0 END), 0)::float AS relevant_new_yield,
       COALESCE(AVG(CASE WHEN rt.distinct_creators > 0 THEN rt.quality_creators::float / rt.distinct_creators ELSE 0 END), 0)::float AS quality_new_yield,
       COALESCE(AVG(rt.avg_dup_ratio), 0)::float AS duplicate_rate,
       COALESCE(AVG(CASE WHEN rt.distinct_creators > 0 THEN rt.known_creators::float / rt.distinct_creators ELSE 0 END), 0)::float AS known_creator_rate,
       MAX(cr.run_created_at)::text AS last_tested_at,
       (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'pageNumber', pb.page_number,
          'avgNewCreators', ROUND(pb.avg_new::numeric, 2),
          'avgConfirmedCreators', ROUND(pb.avg_confirmed::numeric, 2),
          'avgQualityCreators', ROUND(pb.avg_quality::numeric, 2),
          'avgDuplicateRatio', ROUND(pb.avg_dup::numeric, 3),
          'sampleSize', pb.sample_size
        )), '[]'::jsonb) FROM page_breakdown pb) AS page_level_yields
     FROM canonical_runs cr
     LEFT JOIN run_totals rt ON rt.query_run_id = cr.query_run_id`,
    [neighborhoodKey, configKey]
  );

  const row = summaryRes.rows[0];
  const executionCount = Number(row?.execution_count || 0);

  if (executionCount === 0) {
    return {
      neighborhoodKey,
      configKey,
      executionCount: 0,
      recentExecutionCount: 0,
      expectedMarginalValue: 0,
      observedMarginalValue: 0,
      relevantNewYield: 0,
      qualityNewYield: 0,
      duplicateRate: 0,
      knownCreatorRate: 0,
      pageLevelYields: [],
      quotaCost: 100,
      uncertainty: 1.0,
      exposureCount: 0,
      lastTestedAt: null
    };
  }

  const recentExecutionCount = Number(row.recent_execution_count || 0);
  const relevantNewYield = Math.round(Number(row.relevant_new_yield || 0) * 1000) / 1000;
  const qualityNewYield = Math.round(Number(row.quality_new_yield || 0) * 1000) / 1000;
  const duplicateRate = Math.round(Number(row.duplicate_rate || 0) * 1000) / 1000;
  const knownCreatorRate = Math.round(Number(row.known_creator_rate || 0) * 1000) / 1000;
  const quotaCost = Math.round(Number(row.avg_quota_cost || 100));
  const uncertainty = Math.round((1.0 / Math.sqrt(1 + executionCount)) * 1000) / 1000;

  // Expected and observed marginal discovery value formulas
  const rawObserved = (relevantNewYield * 50) + (qualityNewYield * 50) - (duplicateRate * 20) - (knownCreatorRate * 10);
  const observedMarginalValue = Math.round(Math.max(0, Math.min(100, rawObserved)) * 10) / 10;
  const expectedMarginalValue = Math.round(Math.max(0, Math.min(100, observedMarginalValue * (1 - uncertainty * 0.3))) * 10) / 10;

  const rawPageYields = typeof row.page_level_yields === 'string' ? JSON.parse(row.page_level_yields) : (row.page_level_yields || []);
  const pageLevelYields: PageLevelYieldSummary[] = Array.isArray(rawPageYields) ? rawPageYields : [];

  const evidence: NeighborhoodRetrievalEvidence = {
    neighborhoodKey,
    configKey,
    executionCount,
    recentExecutionCount,
    expectedMarginalValue,
    observedMarginalValue,
    relevantNewYield,
    qualityNewYield,
    duplicateRate,
    knownCreatorRate,
    pageLevelYields,
    quotaCost,
    uncertainty,
    exposureCount: executionCount,
    lastTestedAt: row.last_tested_at || null
  };

  await runner.query(
    `INSERT INTO retrieval_policy_neighborhood_evidence(
       neighborhood_key, config_key, execution_count, recent_execution_count,
       expected_marginal_value, observed_marginal_value, relevant_new_yield,
       quality_new_yield, duplicate_rate, known_creator_rate, page_level_yields,
       quota_cost, uncertainty, exposure_count, last_tested_at, updated_at
     )
     VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now())
     ON CONFLICT(neighborhood_key, config_key) DO UPDATE SET
       execution_count = EXCLUDED.execution_count,
       recent_execution_count = EXCLUDED.recent_execution_count,
       expected_marginal_value = EXCLUDED.expected_marginal_value,
       observed_marginal_value = EXCLUDED.observed_marginal_value,
       relevant_new_yield = EXCLUDED.relevant_new_yield,
       quality_new_yield = EXCLUDED.quality_new_yield,
       duplicate_rate = EXCLUDED.duplicate_rate,
       known_creator_rate = EXCLUDED.known_creator_rate,
       page_level_yields = EXCLUDED.page_level_yields,
       quota_cost = EXCLUDED.quota_cost,
       uncertainty = EXCLUDED.uncertainty,
       exposure_count = EXCLUDED.exposure_count,
       last_tested_at = EXCLUDED.last_tested_at,
       updated_at = now()`,
    [
      evidence.neighborhoodKey,
      evidence.configKey,
      evidence.executionCount,
      evidence.recentExecutionCount,
      evidence.expectedMarginalValue,
      evidence.observedMarginalValue,
      evidence.relevantNewYield,
      evidence.qualityNewYield,
      evidence.duplicateRate,
      evidence.knownCreatorRate,
      JSON.stringify(evidence.pageLevelYields),
      evidence.quotaCost,
      evidence.uncertainty,
      evidence.exposureCount,
      evidence.lastTestedAt
    ]
  ).catch((err: unknown) => console.warn('[RetrievalPolicyEvidence] Failed to upsert evidence aggregate:', err));

  return evidence;
}

/**
 * Fetches current retrieval policy evidence for a neighborhood and configuration.
 */
export async function getNeighborhoodRetrievalEvidence(
  neighborhoodKey: string,
  configKey: string,
  clientOverride?: any
): Promise<NeighborhoodRetrievalEvidence | null> {
  const runner = clientOverride || (process.env.DATABASE_URL ? await getDb() : null);
  if (!runner) return null;

  const res = await runner.query(
    `SELECT
       neighborhood_key, config_key, execution_count, recent_execution_count,
       expected_marginal_value, observed_marginal_value, relevant_new_yield,
       quality_new_yield, duplicate_rate, known_creator_rate, page_level_yields,
       quota_cost, uncertainty, exposure_count, last_tested_at
     FROM retrieval_policy_neighborhood_evidence
     WHERE neighborhood_key = $1 AND config_key = $2`,
    [neighborhoodKey, configKey]
  );

  if (!res.rows.length) return null;
  const row = res.rows[0];

  return {
    neighborhoodKey: row.neighborhood_key,
    configKey: row.config_key,
    executionCount: Number(row.execution_count || 0),
    recentExecutionCount: Number(row.recent_execution_count || 0),
    expectedMarginalValue: Number(row.expected_marginal_value || 0),
    observedMarginalValue: Number(row.observed_marginal_value || 0),
    relevantNewYield: Number(row.relevant_new_yield || 0),
    qualityNewYield: Number(row.quality_new_yield || 0),
    duplicateRate: Number(row.duplicate_rate || 0),
    knownCreatorRate: Number(row.known_creator_rate || 0),
    pageLevelYields: typeof row.page_level_yields === 'string' ? JSON.parse(row.page_level_yields) : (row.page_level_yields || []),
    quotaCost: Number(row.quota_cost || 100),
    uncertainty: Number(row.uncertainty || 1.0),
    exposureCount: Number(row.exposure_count || 0),
    lastTestedAt: row.last_tested_at || null
  };
}
