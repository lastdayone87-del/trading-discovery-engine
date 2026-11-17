import { getAppSetting } from './db';
import { evaluateQuerySaturation, type QuerySaturationPolicy } from './querySaturation';

export interface QuerySaturationSweepResult {
  evaluated: number;
  dormant: number;
  active: number;
  insufficient: number;
  skippedExistingDormancy: number;
  policy: QuerySaturationPolicy;
  dormancyDays: number;
}

interface SweepRow {
  query_id: number;
  country: string;
  mature_runs: number;
  distinct_results: number;
  pending_classifications: number;
  known_channels: number;
  duplicate_results: number;
  evaluated_raw_results: number;
  official_quota_units: number;
  fresh_relevant: number;
  fresh_quality: number;
}

/**
 * Evaluates mature query evidence and applies reversible dormancy through the
 * existing query_library.next_eligible_at eligibility gate.
 *
 * This never changes collection to REJECTED, never deletes a query, and never
 * reserves capacity. Once the dormancy date passes (or an operator clears it),
 * the query is eligible again and is re-evaluated on fresh mature evidence.
 */
export async function runQuerySaturationSweep(options: {
  db: any;
  now?: Date;
  policy?: QuerySaturationPolicy;
  dormancyDays?: number;
  readSetting?: (key: string, fallback: string) => Promise<string>;
}): Promise<QuerySaturationSweepResult> {
  const db = options.db;
  const readSetting = options.readSetting || getAppSetting;
  const configuredDormancyDays = Number(await readSetting('query_saturation_dormancy_days', '14')) || 14;
  const dormancyDays = Math.max(1, Math.min(90, Math.trunc(options.dormancyDays ?? configuredDormancyDays)));
  const policy = options.policy || {
    minimumMatureRuns: Math.max(1, Number(await readSetting('query_saturation_min_mature_runs', '7')) || 7),
    maximumPendingShare: 0.20,
    maximumLcbToBaselineRatio: Math.max(0.05, Math.min(1, Number(await readSetting('query_saturation_max_lcb_baseline_ratio', '0.5')) || 0.5)),
    minimumKnownCreatorShare: Math.max(0, Math.min(1, Number(await readSetting('query_saturation_known_share', '0.85')) || 0.85)),
  };

  // Bound the sweep to the recent mature window. Pending/young classifications
  // are excluded from the evidence rather than treated as failures.
  const rows = (await db.query(
    `WITH mature AS (
       SELECT qr.id, qr.query_id, qr.country, qr.distinct_results, qr.known_channels,
              qr.duplicate_results, qr.quota_used,
              COALESCE((qr.performance_details->>'evaluatedRawResults')::int, qr.raw_results, 0) AS evaluated_raw_results,
              COALESCE((qr.performance_details->>'classificationPending')::int, 0) AS pending_classifications
       FROM query_runs qr
       WHERE qr.status='COMPLETED'
         AND qr.query_id IS NOT NULL
         AND qr.completed_at > now()-interval '30 days'
         AND qr.completed_at < now()-interval '48 hours'
     ), fresh AS (
       SELECT qr.query_id,
              COUNT(DISTINCT cs.channel_id) FILTER (
                WHERE cs.persisted AND NOT cs.was_known
                  AND cs.funnel_outcome='TRADING_CONFIRMED'
                  AND cs.country_outcome IN ('CONFIRMED','LIKELY')
              )::int AS fresh_relevant,
              COUNT(DISTINCT cs.channel_id) FILTER (
                WHERE cs.persisted AND NOT cs.was_known
                  AND cs.funnel_outcome='TRADING_CONFIRMED'
                  AND cs.country_outcome IN ('CONFIRMED','LIKELY')
                  AND c.quality_score >= 55
              )::int AS fresh_quality
       FROM query_runs qr
       JOIN channel_sightings cs ON cs.query_run_id=qr.id
       LEFT JOIN channels c ON c.channel_id=cs.channel_id
       WHERE qr.status='COMPLETED'
         AND qr.query_id IS NOT NULL
         AND qr.completed_at > now()-interval '30 days'
         AND qr.completed_at < now()-interval '48 hours'
       GROUP BY qr.query_id
     ), grouped AS (
       SELECT m.query_id, m.country,
              COUNT(*)::int AS mature_runs,
              SUM(m.distinct_results)::int AS distinct_results,
              SUM(m.pending_classifications)::int AS pending_classifications,
              SUM(m.known_channels)::int AS known_channels,
              SUM(m.duplicate_results)::int AS duplicate_results,
              SUM(m.evaluated_raw_results)::int AS evaluated_raw_results,
              SUM(m.quota_used)::int AS official_quota_units,
              COALESCE(f.fresh_relevant, 0)::int AS fresh_relevant,
              COALESCE(f.fresh_quality, 0)::int AS fresh_quality
       FROM mature m
       LEFT JOIN fresh f ON f.query_id=m.query_id
       GROUP BY m.query_id, m.country, f.fresh_relevant, f.fresh_quality
     )
     SELECT * FROM grouped`,
    [],
  )).rows as SweepRow[];

  const countryBaseline = new Map<string, { fresh: number; runs: number }>();
  const global = { fresh: 0, runs: 0 };
  for (const row of rows) {
    if (row.pending_classifications > row.distinct_results * policy.maximumPendingShare) continue;
    if (row.mature_runs < policy.minimumMatureRuns) continue;
    const current = countryBaseline.get(row.country) || { fresh: 0, runs: 0 };
    current.fresh += Number(row.fresh_relevant || 0);
    current.runs += Number(row.mature_runs || 0);
    countryBaseline.set(row.country, current);
    global.fresh += Number(row.fresh_relevant || 0);
    global.runs += Number(row.mature_runs || 0);
  }

  const result: QuerySaturationSweepResult = {
    evaluated: 0, dormant: 0, active: 0, insufficient: 0,
    skippedExistingDormancy: 0, policy, dormancyDays,
  };
  const now = options.now || new Date();
  for (const row of rows) {
    const baseline = countryBaseline.get(row.country) || global;
    const baselineFreshPerRun = baseline.runs > 0 ? baseline.fresh / baseline.runs : 0;
    const decision = evaluateQuerySaturation({
      matureRuns: row.mature_runs,
      pendingClassifications: row.pending_classifications,
      distinctResults: row.distinct_results,
      freshRelevantCreators: row.fresh_relevant,
      freshQualityCreators: row.fresh_quality,
      knownChannels: row.known_channels,
      duplicateResults: row.duplicate_results,
      evaluatedRawResults: row.evaluated_raw_results,
      officialQuotaUnits: row.official_quota_units,
      baselineFreshPerRun,
    }, policy);
    result.evaluated++;
    if (decision.state === 'INSUFFICIENT_EVIDENCE') {
      result.insufficient++;
      continue;
    }
    if (decision.state === 'ACTIVE') {
      result.active++;
      continue;
    }
    const updated = await db.query(
      `UPDATE query_library
       SET next_eligible_at = $2::timestamptz,
           generation_metadata = COALESCE(generation_metadata,'{}'::jsonb) || jsonb_build_object(
             'saturation', $3::jsonb
           )
       WHERE id=$1
         AND status='ACTIVE'
         AND collection IN ('EXPERIMENTAL','PROVEN')
         AND (next_eligible_at IS NULL OR next_eligible_at < $2::timestamptz)`,
      [
        row.query_id,
        new Date(now.getTime() + dormancyDays * 86_400_000).toISOString(),
        JSON.stringify({
          policyVersion: 'query-saturation-v1',
          evaluatedAt: now.toISOString(),
          state: decision.state,
          reasons: decision.reasons,
          metrics: decision.metrics,
          dormancyDays,
        }),
      ],
    );
    if (updated.rowCount) result.dormant++;
    else result.skippedExistingDormancy++;
  }
  return result;
}
