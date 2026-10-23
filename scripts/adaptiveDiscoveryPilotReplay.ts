/**
 * Read-only adaptive pilot replay.
 *
 * This script applies the production deterministic country-day assignment to
 * historical evaluation observations. It never writes, schedules, or activates
 * the pilot. Because historical runs did not receive the creator-derived
 * treatment, the two arms are a baseline balance/variance check, not a causal
 * estimate of treatment effect. Use it to verify metric definitions and sample
 * size before requesting live activation.
 *
 * Usage:
 *   npx tsx scripts/adaptiveDiscoveryPilotReplay.ts --start 2026-10-16T00:00:00Z --end 2026-10-23T00:00:00Z
 */
import { getDb } from '../server/db';
import {
  assignAdaptivePilotArm,
  summarizeAdaptivePilotMetrics,
  ADAPTIVE_PILOT_DEFAULT_SEED,
  type AdaptivePilotAggregateRow
} from '../server/adaptiveDiscoveryPilot';
import { getYouTubeQuotaDay } from '../server/youtubeQuotaDay';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const end = new Date(arg('end', new Date().toISOString()));
const start = new Date(arg('start', new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()));
const treatmentPercent = Number(arg('treatment-percent', '50'));
const seed = arg('seed', ADAPTIVE_PILOT_DEFAULT_SEED);

if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
  throw new Error('Invalid --start/--end window');
}

const db = await getDb();
const result = await db.query(
  `SELECT DISTINCT ON (query_run_id)
     query_run_id,country,allocation_at,completed_at,raw_results,distinct_creators,
     known_creators,new_creators,relevant_new_creators,quality_new_creators,
     confirmed_new_creators,quota_consumed,provider_failed
   FROM discovery_evaluation_run_observations
   WHERE completed_at >= $1 AND completed_at < $2
   ORDER BY query_run_id, observation_revision DESC`,
  [start.toISOString(), end.toISOString()]
);

const assignments = new Set<string>();
const countries: Record<'TREATMENT' | 'CONTROL', Set<string>> = {
  TREATMENT: new Set(),
  CONTROL: new Set()
};
const totals: Record<'TREATMENT' | 'CONTROL', AdaptivePilotAggregateRow> = {
  TREATMENT: {
    arm: 'TREATMENT', assignments: 0, countries: 0, runs: 0, rawResults: 0,
    distinctCreators: 0, knownCreators: 0, newCreators: 0, relevantNewCreators: 0,
    qualityNewCreators: 0, confirmedNewCreators: 0, quotaConsumed: 0, providerFailures: 0
  },
  CONTROL: {
    arm: 'CONTROL', assignments: 0, countries: 0, runs: 0, rawResults: 0,
    distinctCreators: 0, knownCreators: 0, newCreators: 0, relevantNewCreators: 0,
    qualityNewCreators: 0, confirmedNewCreators: 0, quotaConsumed: 0, providerFailures: 0
  }
};

for (const row of result.rows) {
  const country = String(row.country || '').trim();
  if (!country) continue;
  const at = row.allocation_at ? new Date(row.allocation_at) : new Date(row.completed_at);
  const quotaDay = getYouTubeQuotaDay(at);
  const arm = assignAdaptivePilotArm({
    country,
    quotaDay,
    treatmentPercent,
    seed
  });
  assignments.add(`${arm}|${country}|${quotaDay}`);
  countries[arm].add(country);
  const target = totals[arm];
  target.runs += 1;
  target.rawResults += Number(row.raw_results || 0);
  target.distinctCreators += Number(row.distinct_creators || 0);
  target.knownCreators += Number(row.known_creators || 0);
  target.newCreators += Number(row.new_creators || 0);
  target.relevantNewCreators += Number(row.relevant_new_creators || 0);
  target.qualityNewCreators += Number(row.quality_new_creators || 0);
  target.confirmedNewCreators += Number(row.confirmed_new_creators || 0);
  target.quotaConsumed += Number(row.quota_consumed || 0);
  target.providerFailures += row.provider_failed ? 1 : 0;
}

totals.TREATMENT.assignments = [...assignments].filter(key => key.startsWith('TREATMENT|')).length;
totals.CONTROL.assignments = [...assignments].filter(key => key.startsWith('CONTROL|')).length;
totals.TREATMENT.countries = countries.TREATMENT.size;
totals.CONTROL.countries = countries.CONTROL.size;

const metrics = summarizeAdaptivePilotMetrics({
  windowStart: start.toISOString(),
  windowEnd: end.toISOString(),
  rows: [totals.TREATMENT, totals.CONTROL]
});

console.log(JSON.stringify({
  mode: 'READ_ONLY_BASELINE_REPLAY',
  causalTreatmentEffect: false,
  note: 'Treatment was not applied to historical runs. Arm differences are randomization balance and baseline variance, not efficacy.',
  treatmentPercent,
  seed,
  assignments: { TREATMENT: totals.TREATMENT.assignments, CONTROL: totals.CONTROL.assignments },
  metrics
}, null, 2));
