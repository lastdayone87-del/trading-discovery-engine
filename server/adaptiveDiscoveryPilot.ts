import { createHash } from 'node:crypto';
import { getAppSetting, getDb } from './db';
import { canonicalCountry } from './countryInference';
import {
  generateCountryNativeProposals,
  generateCreatorDerivedProposals,
  materializeBoundedCountryNativeProposals,
  persistFrontierProposals,
  settleBeforeDeadline,
  type DiscoveryFrontierProposal
} from './discoveryProposalGenerators';
import {
  getNextYouTubeQuotaResetAt,
  getYouTubeQuotaDay,
  getYouTubeQuotaDayStartAt
} from './youtubeQuotaDay';
import { ADAPTIVE_PILOT_POLICY_VERSION } from './adaptiveDiscoveryPilotPolicy';
export { ADAPTIVE_PILOT_POLICY_VERSION } from './adaptiveDiscoveryPilotPolicy';

/**
 * Opt-in adaptive country-aware discovery pilot.
 *
 * CONTROL countries follow the existing country-native materialization path
 * unchanged. TREATMENT countries additionally receive bounded CREATOR_DERIVED
 * proposals, so verified creators can seed a follow-up query. Assignment is a
 * deterministic country-day randomization recorded before any generation; it
 * is audit evidence only and never grants scheduling or serving authority.
 *
 * Everything here is inert unless adaptive_discovery_pilot_enabled=true. The
 * existing frontier allocator, safety gates and observed-outcome evaluation
 * remain the only authorities.
 */

export const ADAPTIVE_PILOT_DEFAULT_TREATMENT_PERCENT = 50;
export const ADAPTIVE_PILOT_DEFAULT_SEED = 'adaptive-pilot-v1';

export type AdaptivePilotArm = 'TREATMENT' | 'CONTROL';

export interface AdaptivePilotConfig {
  enabled: boolean;
  treatmentPercent: number;
  seed: string;
}

export interface AdaptivePilotAssignment {
  assignmentKey: string;
  country: string;
  quotaDay: string;
  arm: AdaptivePilotArm;
  treatmentPercent: number;
  assignmentSeed: string;
  policyVersion: string;
  windowStart: string;
  windowEnd: string;
}

export interface AdaptivePilotDb {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
}

export interface AdaptivePilotMaterializationConfig {
  globalCap?: number;
  perCountryCap?: number;
  fairnessCursor?: number;
  deadlineMs?: number;
  now?: Date;
}

export interface AdaptivePilotDeps {
  readConfig?: () => Promise<AdaptivePilotConfig>;
  recordAssignment?: typeof recordAdaptivePilotAssignment;
  generateNative?: typeof generateCountryNativeProposals;
  generateDerived?: typeof generateCreatorDerivedProposals;
  persist?: typeof persistFrontierProposals;
  baseline?: typeof materializeBoundedCountryNativeProposals;
}

export interface AdaptivePilotAssignmentInput {
  country: string;
  quotaDay: string;
  arm: AdaptivePilotArm;
  treatmentPercent: number;
  seed: string;
  windowStart: string;
  windowEnd: string;
  policyVersion?: string;
}

function clampPercent(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return ADAPTIVE_PILOT_DEFAULT_TREATMENT_PERCENT;
  return Math.max(0, Math.min(100, Math.floor(parsed)));
}

function cleanSeed(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.slice(0, 128) : ADAPTIVE_PILOT_DEFAULT_SEED;
}

/** Pure, fail-closed config resolution. Only an exact `true` enables the pilot. */
export function resolveAdaptivePilotConfig(settings: {
  enabled?: string | null;
  treatmentPercent?: string | null;
  seed?: string | null;
}): AdaptivePilotConfig {
  return {
    enabled: settings.enabled === 'true',
    treatmentPercent: clampPercent(settings.treatmentPercent),
    seed: cleanSeed(settings.seed)
  };
}

export async function readAdaptivePilotConfig(
  readSetting: (key: string, fallback: string) => Promise<string> = getAppSetting
): Promise<AdaptivePilotConfig> {
  const [enabled, treatmentPercent, seed] = await Promise.all([
    readSetting('adaptive_discovery_pilot_enabled', 'false'),
    readSetting('adaptive_discovery_pilot_treatment_percent', String(ADAPTIVE_PILOT_DEFAULT_TREATMENT_PERCENT)),
    readSetting('adaptive_discovery_pilot_seed', ADAPTIVE_PILOT_DEFAULT_SEED)
  ]);
  return resolveAdaptivePilotConfig({ enabled, treatmentPercent, seed });
}

/** Deterministic, independently reproducible country-day assignment. */
export function assignAdaptivePilotArm(input: {
  country: string;
  quotaDay: string;
  treatmentPercent: number;
  seed: string;
}): AdaptivePilotArm {
  const percent = clampPercent(input.treatmentPercent);
  if (percent <= 0) return 'CONTROL';
  if (percent >= 100) return 'TREATMENT';
  const digest = createHash('sha256')
    .update(`${cleanSeed(input.seed)}|${input.quotaDay}|${String(input.country).toUpperCase()}`)
    .digest();
  const draw = digest.readUInt32BE(0) / 0x1_0000_0000;
  return draw * 100 < percent ? 'TREATMENT' : 'CONTROL';
}

export function adaptivePilotAssignmentKey(input: {
  country: string;
  quotaDay: string;
  seed: string;
  policyVersion?: string;
}): string {
  return createHash('sha256')
    .update(`${input.policyVersion || ADAPTIVE_PILOT_POLICY_VERSION}|${cleanSeed(input.seed)}|${input.quotaDay}|${String(input.country).toUpperCase()}`)
    .digest('hex');
}

function mapAssignment(row: any): AdaptivePilotAssignment {
  return {
    assignmentKey: String(row.assignment_key),
    country: String(row.country),
    quotaDay: String(row.quota_day),
    arm: row.arm === 'TREATMENT' ? 'TREATMENT' : 'CONTROL',
    treatmentPercent: Number(row.treatment_percent),
    assignmentSeed: String(row.assignment_seed),
    policyVersion: String(row.policy_version),
    windowStart: new Date(row.window_start).toISOString(),
    windowEnd: new Date(row.window_end).toISOString()
  };
}

/**
 * Inserts the immutable assignment or returns the already-recorded arm. A
 * config change or policy release during the same country-day can never flip
 * an assignment or create a second arm for that day.
 */
export async function recordAdaptivePilotAssignment(
  input: AdaptivePilotAssignmentInput,
  client?: AdaptivePilotDb
): Promise<AdaptivePilotAssignment> {
  const db = client || (await getDb());
  const country = canonicalCountry(input.country).toUpperCase();
  if (!country) throw new Error('ADAPTIVE_PILOT_COUNTRY_REQUIRED');
  const policyVersion = input.policyVersion || ADAPTIVE_PILOT_POLICY_VERSION;
  const assignmentKey = adaptivePilotAssignmentKey({
    country,
    quotaDay: input.quotaDay,
    seed: input.seed,
    policyVersion
  });
  const inserted = await db.query(
    `INSERT INTO adaptive_discovery_pilot_assignments(
       assignment_key,country,quota_day,arm,treatment_percent,assignment_seed,
       policy_version,window_start,window_end
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT(country,quota_day) DO NOTHING
     RETURNING *`,
    [
      assignmentKey,
      country,
      input.quotaDay,
      input.arm,
      clampPercent(input.treatmentPercent),
      cleanSeed(input.seed),
      policyVersion,
      input.windowStart,
      input.windowEnd
    ]
  );
  if (inserted.rows[0]) return mapAssignment(inserted.rows[0]);
  const existing = await db.query(
    `SELECT * FROM adaptive_discovery_pilot_assignments
     WHERE country=$1 AND quota_day=$2`,
    [country, input.quotaDay]
  );
  if (!existing.rows[0]) throw new Error('ADAPTIVE_PILOT_ASSIGNMENT_NOT_RECORDED');
  return mapAssignment(existing.rows[0]);
}

function interleaveFamilies(
  native: DiscoveryFrontierProposal[],
  derived: DiscoveryFrontierProposal[]
): DiscoveryFrontierProposal[] {
  const out: DiscoveryFrontierProposal[] = [];
  const seen = new Set<string>();
  const max = Math.max(native.length, derived.length);
  for (let index = 0; index < max; index++) {
    for (const proposal of [native[index], derived[index]]) {
      if (!proposal || seen.has(proposal.dedupKey)) continue;
      seen.add(proposal.dedupKey);
      out.push(proposal);
    }
  }
  return out;
}

function selectFairAdaptiveProposals(
  groups: Array<{ country: string; proposals: DiscoveryFrontierProposal[] }>,
  globalCap: number,
  fairnessCursor: number
): DiscoveryFrontierProposal[] {
  const ordered = groups
    .map(group => ({ ...group, proposals: [...group.proposals] }))
    .filter(group => group.proposals.length > 0)
    .sort((a, b) => a.country.localeCompare(b.country));
  if (!ordered.length || globalCap <= 0) return [];
  const offset = Math.max(0, Math.floor(fairnessCursor)) % ordered.length;
  const rotated = [...ordered.slice(offset), ...ordered.slice(0, offset)];
  const seen = new Set<string>();
  const selected: DiscoveryFrontierProposal[] = [];
  const maxDepth = Math.max(...rotated.map(group => group.proposals.length));
  for (let depth = 0; depth < maxDepth && selected.length < globalCap; depth++) {
    for (const group of rotated) {
      const proposal = group.proposals[depth];
      if (proposal && !seen.has(proposal.dedupKey)) {
        seen.add(proposal.dedupKey);
        selected.push(proposal);
        if (selected.length >= globalCap) break;
      }
    }
  }
  return selected;
}

/**
 * Disabled: byte-for-byte existing baseline behavior.
 * Enabled: records one country-day arm, then adds CREATOR_DERIVED follow-up
 * hypotheses only in TREATMENT countries.
 */
export async function materializeAdaptiveDiscoveryPilotProposals(
  countries: string[],
  config: AdaptivePilotMaterializationConfig = {},
  deps: AdaptivePilotDeps = {}
): Promise<{
  enabled: boolean;
  generated: number;
  persisted: number;
  proposals: DiscoveryFrontierProposal[];
  assignments: AdaptivePilotAssignment[];
}> {
  const globalCap = Math.min(100, Math.max(1, Math.floor(config.globalCap ?? 25)));
  const perCountryCap = Math.min(globalCap, Math.max(1, Math.floor(config.perCountryCap ?? 5)));
  const deadlineMs = Math.min(30_000, Math.max(100, Math.floor(config.deadlineMs ?? 2_500)));
  const fairnessCursor = Math.max(0, Math.floor(config.fairnessCursor ?? 0));
  const now = config.now || new Date();
  const readConfig = deps.readConfig || readAdaptivePilotConfig;

  const pilot = await readConfig();
  if (!pilot.enabled) {
    const baseline = deps.baseline || materializeBoundedCountryNativeProposals;
    const result = await baseline(countries, {
      globalCap,
      perCountryCap,
      fairnessCursor,
      deadlineMs
    });
    return {
      enabled: false,
      generated: result.generated,
      persisted: result.persisted,
      proposals: result.proposals,
      assignments: []
    };
  }

  const quotaDay = getYouTubeQuotaDay(now);
  const windowStart = new Date(getYouTubeQuotaDayStartAt(now)).toISOString();
  const windowEnd = new Date(getNextYouTubeQuotaResetAt(now)).toISOString();
  // Keep the canonical country identity downstream. The assignment ledger
  // uppercases its own storage key, but proposal target dimensions must retain
  // the canonical name so query authorization can resolve curated anchors.
  const normalizedCountries = [...new Set(countries.map(country => canonicalCountry(country)).filter(Boolean))];
  const recordAssignment = deps.recordAssignment || recordAdaptivePilotAssignment;
  const generateNative = deps.generateNative || generateCountryNativeProposals;
  const generateDerived = deps.generateDerived || generateCreatorDerivedProposals;
  const persist = deps.persist || persistFrontierProposals;

  type PilotCountryResult = {
    assignment: AdaptivePilotAssignment;
    group: { country: string; proposals: DiscoveryFrontierProposal[] };
  };
  const deadlineAt = Date.now() + deadlineMs;
  const remainingDeadlineMs = () => Math.max(1, deadlineAt - Date.now());

  // Countries run concurrently under one shared deadline. The recorded
  // assignment, never a recomputed local arm, governs treatment so a config
  // change during the quota day cannot desynchronize execution from audit.
  const results = await Promise.all(normalizedCountries.map(async (country): Promise<PilotCountryResult | null> => {
    const assignment = await settleBeforeDeadline(recordAssignment({
      country,
      quotaDay,
      arm: assignAdaptivePilotArm({
        country,
        quotaDay,
        treatmentPercent: pilot.treatmentPercent,
        seed: pilot.seed
      }),
      treatmentPercent: pilot.treatmentPercent,
      seed: pilot.seed,
      windowStart,
      windowEnd
    }), remainingDeadlineMs(), null);
    if (!assignment) return null;

    const [native, derived] = await Promise.all([
      settleBeforeDeadline(generateNative(country, perCountryCap), remainingDeadlineMs(), []),
      assignment.arm === 'TREATMENT'
        ? settleBeforeDeadline(generateDerived(country, perCountryCap, {
            expiresAt: assignment.windowEnd,
            pilotQuotaDay: assignment.quotaDay,
            pilotAssignmentKey: assignment.assignmentKey,
            pilotArm: assignment.arm,
            pilotPolicyVersion: ADAPTIVE_PILOT_POLICY_VERSION
          }), remainingDeadlineMs(), [])
        : Promise.resolve([])
    ]);
    const proposals = (assignment.arm === 'TREATMENT'
      ? interleaveFamilies(native, derived)
      : native).slice(0, perCountryCap);
    return { assignment, group: { country, proposals } };
  }));

  const successful = results
    .filter((item): item is PilotCountryResult => item !== null)
    .sort((a, b) => a.assignment.country.localeCompare(b.assignment.country));
  const assignments = successful.map(item => item.assignment);
  const groups = successful.map(item => item.group);

  const selected = selectFairAdaptiveProposals(groups, globalCap, fairnessCursor);
  const persisted = await settleBeforeDeadline(persist(selected), remainingDeadlineMs(), 0);
  return {
    enabled: true,
    generated: selected.length,
    persisted,
    proposals: selected,
    assignments
  };
}

export interface AdaptivePilotAggregateRow {
  arm: AdaptivePilotArm;
  assignments: number;
  countries: number;
  runs: number;
  rawResults: number;
  distinctCreators: number;
  knownCreators: number;
  newCreators: number;
  relevantNewCreators: number;
  qualityNewCreators: number;
  confirmedNewCreators: number;
  quotaConsumed: number;
  providerFailures: number;
  invalidQueries: number;
}

export interface AdaptivePilotArmMetrics {
  arm: AdaptivePilotArm;
  assignments: number;
  countries: number;
  runs: number;
  rawResults: number;
  distinctCreators: number;
  knownCreators: number;
  newCreators: number;
  relevantNewCreators: number;
  qualityNewCreators: number;
  confirmedNewCreators: number;
  quotaConsumed: number;
  providerFailures: number;
  invalidQueries: number;
  /** providerFailures + invalidQueries (the evaluation contract's terminal failures). */
  failedRuns: number;
  duplicateRate: number;
  relevanceRate: number;
  yieldPerRun: number;
  relevantYieldPerRun: number;
  qualityYieldPerRun: number;
  noveltyRate: number;
  reliability: number;
  quotaPerRelevantCreator: number | null;
  quotaPerQualityCreator: number | null;
}

export interface AdaptivePilotMetrics {
  policyVersion: string;
  windowStart: string;
  windowEnd: string;
  arms: Record<AdaptivePilotArm, AdaptivePilotArmMetrics>;
  uplift: {
    treatmentVsControl: {
      newCreatorsPerRun: number;
      relevantCreatorsPerRun: number;
      qualityCreatorsPerRun: number;
      noveltyRate: number;
      duplicateRate: number;
      reliability: number;
    };
  };
}

const num = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export function aggregateAdaptivePilotMetrics(rows: AdaptivePilotAggregateRow[]): AdaptivePilotArmMetrics[] {
  const empty = (arm: AdaptivePilotArm): AdaptivePilotArmMetrics => ({
    arm,
    assignments: 0,
    countries: 0,
    runs: 0,
    rawResults: 0,
    distinctCreators: 0,
    knownCreators: 0,
    newCreators: 0,
    relevantNewCreators: 0,
    qualityNewCreators: 0,
    confirmedNewCreators: 0,
    quotaConsumed: 0,
    providerFailures: 0,
    invalidQueries: 0,
    failedRuns: 0,
    duplicateRate: 0,
    relevanceRate: 0,
    yieldPerRun: 0,
    relevantYieldPerRun: 0,
    qualityYieldPerRun: 0,
    noveltyRate: 0,
    reliability: 0,
    quotaPerRelevantCreator: null,
    quotaPerQualityCreator: null
  });
  const byArm: Record<AdaptivePilotArm, AdaptivePilotArmMetrics> = {
    TREATMENT: empty('TREATMENT'),
    CONTROL: empty('CONTROL')
  };
  for (const row of rows) {
    const target = row.arm === 'TREATMENT' ? byArm.TREATMENT : byArm.CONTROL;
    target.assignments += num(row.assignments);
    target.countries += num(row.countries);
    target.runs += num(row.runs);
    target.rawResults += num(row.rawResults);
    target.distinctCreators += num(row.distinctCreators);
    target.knownCreators += num(row.knownCreators);
    target.newCreators += num(row.newCreators);
    target.relevantNewCreators += num(row.relevantNewCreators);
    target.qualityNewCreators += num(row.qualityNewCreators);
    target.confirmedNewCreators += num(row.confirmedNewCreators);
    target.quotaConsumed += num(row.quotaConsumed);
    target.providerFailures += num(row.providerFailures);
    target.invalidQueries += num(row.invalidQueries);
  }
  for (const target of Object.values(byArm)) {
    const ratio = (numerator: number, denominator: number) => denominator > 0 ? numerator / denominator : 0;
    target.failedRuns = target.providerFailures + target.invalidQueries;
    target.duplicateRate = ratio(target.knownCreators, target.distinctCreators);
    target.relevanceRate = ratio(target.relevantNewCreators, target.newCreators);
    target.yieldPerRun = ratio(target.newCreators, target.runs);
    target.relevantYieldPerRun = ratio(target.relevantNewCreators, target.runs);
    target.qualityYieldPerRun = ratio(target.qualityNewCreators, target.runs);
    target.noveltyRate = ratio(target.newCreators, target.distinctCreators);
    // Match the evaluation contract: an invalid query is a terminal failure,
    // not a successful run with zero results.
    target.reliability = target.runs > 0 ? 1 - ratio(target.failedRuns, target.runs) : 0;
    target.quotaPerRelevantCreator = target.relevantNewCreators > 0
      ? target.quotaConsumed / target.relevantNewCreators
      : null;
    target.quotaPerQualityCreator = target.qualityNewCreators > 0
      ? target.quotaConsumed / target.qualityNewCreators
      : null;
  }
  return [byArm.TREATMENT, byArm.CONTROL];
}

export async function computeAdaptivePilotMetrics(input: {
  windowStart: string;
  windowEnd: string;
  policyVersion?: string;
  client?: AdaptivePilotDb;
}): Promise<AdaptivePilotMetrics> {
  const startMs = Date.parse(input.windowStart);
  const endMs = Date.parse(input.windowEnd);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error('ADAPTIVE_PILOT_INVALID_WINDOW');
  }
  // A policy release mid-day reuses the recorded country-day assignment, so
  // that assignment keeps the policy version that randomized it. Default the
  // report to every assignment in the window; an explicit policyVersion is an
  // optional strict-cohort filter, not the default read.
  const policyVersion = input.policyVersion?.trim() || null;
  const policyFilter = policyVersion ? 'AND a.policy_version = $3' : '';
  const params = policyVersion
    ? [input.windowStart, input.windowEnd, policyVersion]
    : [input.windowStart, input.windowEnd];
  const db = input.client || (await getDb());
  const result = await db.query(
    `WITH latest_obs AS (
       SELECT DISTINCT ON (query_run_id) *
       FROM discovery_evaluation_run_observations
       WHERE allocation_at >= $1::timestamptz - interval '1 day'
         AND allocation_at < $2::timestamptz + interval '1 day'
       ORDER BY query_run_id, observation_revision DESC
     )
     SELECT
       a.arm,
       COUNT(DISTINCT a.assignment_key)::int AS assignments,
       COUNT(DISTINCT a.country)::int AS countries,
       COUNT(DISTINCT o.query_run_id)::int AS runs,
       COALESCE(SUM(o.raw_results),0)::int AS raw_results,
       COALESCE(SUM(o.distinct_creators),0)::int AS distinct_creators,
       COALESCE(SUM(o.known_creators),0)::int AS known_creators,
       COALESCE(SUM(o.new_creators),0)::int AS new_creators,
       COALESCE(SUM(o.relevant_new_creators),0)::int AS relevant_new_creators,
       COALESCE(SUM(o.quality_new_creators),0)::int AS quality_new_creators,
       COALESCE(SUM(o.confirmed_new_creators),0)::int AS confirmed_new_creators,
       COALESCE(SUM(o.quota_consumed),0)::int AS quota_consumed,
       (COUNT(DISTINCT o.query_run_id) FILTER (WHERE o.provider_failed))::int AS provider_failures,
       (COUNT(DISTINCT o.query_run_id) FILTER (WHERE o.invalid_query))::int AS invalid_queries
     FROM adaptive_discovery_pilot_assignments a
     LEFT JOIN latest_obs o
       ON LOWER(o.country) = LOWER(a.country)
      -- created_at is the auditable activation boundary for this country-day.
      -- Excluding earlier runs keeps a mid-day activation from assigning
      -- pre-activation observations to the arm retroactively.
      AND o.allocation_at >= GREATEST(a.window_start, a.created_at, $1::timestamptz)
      AND o.allocation_at < LEAST(a.window_end, $2::timestamptz)
     WHERE a.window_start < $2
       AND a.window_end > $1
       ${policyFilter}
     GROUP BY a.arm
     ORDER BY a.arm`,
    params
  );
  return summarizeAdaptivePilotMetrics({
    policyVersion: policyVersion || 'ALL',
    windowStart: new Date(startMs).toISOString(),
    windowEnd: new Date(endMs).toISOString(),
    rows: result.rows.map(row => ({
      arm: row.arm === 'TREATMENT' ? 'TREATMENT' : 'CONTROL',
      assignments: num(row.assignments),
      countries: num(row.countries),
      runs: num(row.runs),
      rawResults: num(row.raw_results),
      distinctCreators: num(row.distinct_creators),
      knownCreators: num(row.known_creators),
      newCreators: num(row.new_creators),
      relevantNewCreators: num(row.relevant_new_creators),
      qualityNewCreators: num(row.quality_new_creators),
      confirmedNewCreators: num(row.confirmed_new_creators),
      quotaConsumed: num(row.quota_consumed),
      providerFailures: num(row.provider_failures),
      invalidQueries: num(row.invalid_queries)
    }))
  });
}

/** Pure summary used by the database report and deterministic tests. */
export function summarizeAdaptivePilotMetrics(input: {
  policyVersion?: string;
  windowStart: string;
  windowEnd: string;
  rows: AdaptivePilotAggregateRow[];
}): AdaptivePilotMetrics {
  const arms = aggregateAdaptivePilotMetrics(input.rows);
  const treatment = arms.find(arm => arm.arm === 'TREATMENT')!;
  const control = arms.find(arm => arm.arm === 'CONTROL')!;
  const delta = (a: number, b: number): number => b > 0 ? a / b - 1 : 0;
  return {
    policyVersion: input.policyVersion || ADAPTIVE_PILOT_POLICY_VERSION,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    arms: { TREATMENT: treatment, CONTROL: control },
    uplift: {
      treatmentVsControl: {
        newCreatorsPerRun: delta(treatment.yieldPerRun, control.yieldPerRun),
        relevantCreatorsPerRun: delta(treatment.relevantYieldPerRun, control.relevantYieldPerRun),
        qualityCreatorsPerRun: delta(treatment.qualityYieldPerRun, control.qualityYieldPerRun),
        noveltyRate: delta(treatment.noveltyRate, control.noveltyRate),
        duplicateRate: delta(treatment.duplicateRate, control.duplicateRate),
        reliability: delta(treatment.reliability, control.reliability)
      }
    }
  };
}
