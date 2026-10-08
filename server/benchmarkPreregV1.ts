/**
 * Execution plumbing for benchmark-preregistration-v2.
 *
 * The frozen specification (docs/BENCHMARK_PREREGISTRATION.md) is the sole
 * authority. This module implements ONLY what is genuinely missing to make
 * the already-frozen benchmark executable:
 * - frozen-constant verification (fail closed on drift),
 * - the exact frozen experiment request builder,
 * - deterministic pool-snapshot construction + hashing (mirroring the
 *   production selection pipeline stage by stage),
 * - configuration/provider/migration provenance capture + hashing,
 * - benchmark gate verification (fail closed unless everything is OFF),
 * - execution-record assembly.
 *
 * It changes NOTHING about selection, assignment, eligibility, providers,
 * thresholds, priors, weights, quotas, or UCB1. Scheduling itself reuses the
 * existing runAutonomousDiscoveryCycle path untouched (see
 * scripts/runBenchmarkPreregV1.ts). No benchmark from any other script
 * (fastBenchmark, evaluateBenchmark, semantic benchmarks) is involved.
 */
import { createHash } from 'node:crypto';
import type { QueryRecord } from '../src/types';
import {
  QUERY_SELECTION_EXPERIMENT_VERSION,
  THOMPSON_OBSERVATION_MAP_VERSION,
  QUERY_FEATURES_MAP_VERSION,
  BENCHMARK_PREREG_ORDERING_WINDOW_DAYS,
  validateSelectionExperimentRequest,
  isFrozenBenchmarkConfiguration,
  reservableFilter,
  type NormalizedSelectionExperiment,
  type SelectionExperimentRequest,
} from './querySelectionExperiments';
import { RETRIEVAL_EXPERIMENT_VERSION } from './retrievalExperiment';
import { ALLOCATION_CHALLENGER_VERSION } from './allocationChallengers';
import { TRIAL_FUNNEL_MAP_VERSION } from './discoveryFrontierTrials';
import { PERSISTENT_RESEARCH_PHASE8_VERSION } from './discoveryFrontierAllocator';
import { SITE_PROFILER_POLICY_VERSION } from './siteProfiler';
import { ACQUISITION_LADDER_POLICY_VERSION } from './acquisitionLadder';
import { FRONTIER_POLICY_VERSION } from './frontierManager';
import { DOMAIN_LEARNER_POLICY_VERSION } from './domainLearner';
import { LLM_ASSIST_POLICY_VERSION } from './llmAssist';
import { GRAPH_EXPANSION_POLICY_VERSION } from './graphExpansionPolicy';
import { RELATIONSHIP_CANARY_VERSION } from './relationshipCanary';
import { AUTONOMOUS_QUERY_AUTHORITY_POLICY_VERSION, evaluateAutonomousQueryAuthority } from './autonomousQueryAuthority';
import { CANDIDATE_TRIAGE_POLICY_VERSION } from './candidateTriage';
import {
  queriesOutsideCooldown,
  limitRepeatedPrimaryTerms,
  rotateAwayFromMostRecentIntent,
} from './queryPlanner';

// Frozen literals (benchmark-preregistration-v1 §1/§3A/§7/§10). Compared
// against the live code constants by verifyFrozenBenchmarkVersions().
// v1 names/values are frozen: v2 lives alongside under BENCHMARK_PREREG_V2_*
// and explicit spec objects, never by editing v1 behavior.
export const BENCHMARK_PREREG_SPEC_VERSION = 'benchmark-preregistration-v1';
export const BENCHMARK_PREREG_FROZEN_BASE_COMMIT = '4b49e0c01ac53eebf0080fae29bd6aaabb803cfc';
export const BENCHMARK_PREREG_SCOPE_SIZE = 300;
export const BENCHMARK_PREREG_WALL_CLOCK_DAYS = 14;
export const BENCHMARK_PREREG_FROZEN_MIGRATION_COUNT = 137;
export const BENCHMARK_PREREG_POOL_RULES_VERSION = 'pool-rules-benchmark-prereg-v1';
export const BENCHMARK_PREREG_FROZEN_SELECTION = {
  experimentId: 'benchmark-prereg-v1-selection',
  enabledArms: ['THOMPSON', 'CONTEXTUAL'],
  treatmentBasisPoints: 5000,
  thompsonPrior: { alpha0: 1, beta0: 1 },
  contextualWeights: { value: 0.5, exploration: 0.35, cost: 0.1 },
} as const;
export const BENCHMARK_PREREG_FROZEN_ORDERING = {
  experimentId: 'benchmark-prereg-v1-ordering',
  treatmentBasisPoints: 5000,
} as const;
export const BENCHMARK_PREREG_FROZEN_TRIAL_DEFAULTS = { maxQuota: 100, pageDepth: 1 } as const;

/** Versioned benchmark specification. v1 names above stay frozen; v2 lives here. */
export interface BenchmarkPreregSpec {
  specVersion: string;
  baseCommit: string;
  scopeSize: number;
  poolRulesVersion: string;
  poolPrefix: string;
  logTag: string;
  selectionExperimentId: string;
  orderingExperimentId: string;
  frozenSelection: {
    experimentId: string;
    enabledArms: readonly string[];
    treatmentBasisPoints: number;
    thompsonPrior: { alpha0: number; beta0: number };
    contextualWeights: { value: number; exploration: number; cost: number };
  };
  frozenOrdering: { experimentId: string; treatmentBasisPoints: number };
}
export const BENCHMARK_PREREG_V1_SPEC: BenchmarkPreregSpec = {
  specVersion: BENCHMARK_PREREG_SPEC_VERSION,
  baseCommit: BENCHMARK_PREREG_FROZEN_BASE_COMMIT,
  scopeSize: BENCHMARK_PREREG_SCOPE_SIZE,
  poolRulesVersion: BENCHMARK_PREREG_POOL_RULES_VERSION,
  poolPrefix: 'benchmark-prereg-v1:pool',
  logTag: 'benchmark-prereg-v1',
  selectionExperimentId: 'benchmark-prereg-v1-selection',
  orderingExperimentId: 'benchmark-prereg-v1-ordering',
  frozenSelection: BENCHMARK_PREREG_FROZEN_SELECTION,
  frozenOrdering: BENCHMARK_PREREG_FROZEN_ORDERING,
};
export const BENCHMARK_PREREG_V2_FROZEN_BASE_COMMIT = 'fed806fc3965b64d9925fbaa0e9b0c6c65e21e41';
export const BENCHMARK_PREREG_V2_SPEC: BenchmarkPreregSpec = {
  specVersion: 'benchmark-preregistration-v2',
  baseCommit: BENCHMARK_PREREG_V2_FROZEN_BASE_COMMIT,
  scopeSize: 120,
  poolRulesVersion: 'pool-rules-benchmark-prereg-v2',
  poolPrefix: 'benchmark-prereg-v2:pool',
  logTag: 'benchmark-prereg-v2',
  selectionExperimentId: 'benchmark-prereg-v2-selection',
  orderingExperimentId: 'benchmark-prereg-v2-ordering',
  frozenSelection: {
    experimentId: 'benchmark-prereg-v2-selection',
    enabledArms: ['THOMPSON', 'CONTEXTUAL'],
    treatmentBasisPoints: 5000,
    thompsonPrior: { alpha0: 1, beta0: 1 },
    contextualWeights: { value: 0.5, exploration: 0.35, cost: 0.1 },
  } as const,
  frozenOrdering: {
    experimentId: 'benchmark-prereg-v2-ordering',
    treatmentBasisPoints: 5000,
  } as const,
};
/** Resolve a spec by version string, fail closed on anything unknown. Pure. */
export function benchmarkPreregSpecForVersion(specVersion: string): BenchmarkPreregSpec {
  if (specVersion === BENCHMARK_PREREG_V2_SPEC.specVersion) return BENCHMARK_PREREG_V2_SPEC;
  if (specVersion === BENCHMARK_PREREG_V1_SPEC.specVersion) return BENCHMARK_PREREG_V1_SPEC;
  throw new Error(`BENCHMARK_PREREG_UNKNOWN_SPEC: ${specVersion}`);
}
/** Same-UTC-day check for the plan/execute freshness gate. Pure. */
export function isSameUtcDayPlan(collectedAtIso: string, now: Date = new Date()): boolean {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const collected = new Date(collectedAtIso);
  if (Number.isNaN(collected.getTime())) return false;
  return day(collected) === day(now);
}
/** Freshness gate for initial execution: a PLANNED record requires a
 * same-UTC-day plan snapshot; an already IN_PROGRESS record resumes under
 * the existing safeguards (kill-switch rechecks, scheduler checks, ledger
 * adoption) instead of being stranded by a day boundary. Pure. */
export function requireFreshPlanForStatus(recordStatus: string, collectedAtIso: string, now: Date = new Date()): void {
  if (recordStatus === 'IN_PROGRESS') return;
  if (recordStatus === 'PLANNED' && isSameUtcDayPlan(collectedAtIso, now)) return;
  throw new Error('BENCHMARK_PREREG_PLAN_STALE: plan snapshot is not from today (UTC); re-run --plan the same day before executing');
}
/** Quiescence check for the execute gate: the scheduler row must stay
 * enabled (acquireSchedulerLock() only grants the lock WHERE
 * is_enabled=true; a disabled row could never proceed, so allowing it past
 * the gate would only fail later and opaquely), with no running cycle and no
 * live lease. Quiescence (nothing able to compete) plus the separate
 * live-lease check is the invariant that actually excludes concurrent
 * producers. Pure. */
export function isSchedulerStoppedForBenchmark(
  row: { is_enabled?: unknown; is_running?: unknown } | null | undefined,
  liveRunning: boolean = false
): boolean {
  if (!row) return false;
  if (row.is_enabled !== true) return false;
  if (row.is_running !== false) return false;
  if (liveRunning) return false;
  return true;
}
/** Combined initial-execution preflight decisions: freshness first, then
 * scheduler quiescence. Throws the exact gate error; the runner must call
 * this before mutating any record so a failed gate can never convert a
 * fresh PLANNED plan. Pure. */
export function assertExecutionPreflightReady(input: {
  recordStatus: string;
  collectedAtIso: string;
  schedulerRow: { is_enabled?: unknown; is_running?: unknown } | null | undefined;
  liveRunning: boolean;
  now?: Date;
}): void {
  requireFreshPlanForStatus(input.recordStatus, input.collectedAtIso, input.now ?? new Date());
  if (!isSchedulerStoppedForBenchmark(input.schedulerRow, input.liveRunning)) {
    throw new Error('BENCHMARK_PREREG_SCHEDULER_NOT_STOPPED: autonomous scheduler must be quiescent (enabled row, no running cycle, no live lease) before executing');
  }
}

/** Gates that must be OFF (or absent) for benchmark execution. */
export const BENCHMARK_PREREG_REQUIRED_OFF_KEYS = [
  'site_profiler_enabled',
  'acquisition_ladder_enabled',
  'frontier_manager_enabled',
  'domain_weight_experiment_enabled',
  'llm_assist_enabled',
  'graph_depth2_experiment_enabled',
  'relationship_canary_enabled',
  'external_osint_materialization_enabled',
  'frontier_trials_enabled',
  'query_intelligence_paused',
] as const;

/**
 * Fail closed unless every frozen version constant still matches the
 * preregistered value. Any drift means the running code is no longer the
 * frozen system under test: refuse to build an execution record rather than
 * silently benchmark a different engine.
 */
export function verifyFrozenBenchmarkVersions(
  live: Record<string, string> = {
    selectionExperiment: QUERY_SELECTION_EXPERIMENT_VERSION,
    thompsonObservationMap: THOMPSON_OBSERVATION_MAP_VERSION,
    queryFeaturesMap: QUERY_FEATURES_MAP_VERSION,
    retrievalExperiment: RETRIEVAL_EXPERIMENT_VERSION,
    allocationChallenger: ALLOCATION_CHALLENGER_VERSION,
    trialFunnelMap: TRIAL_FUNNEL_MAP_VERSION,
    frontierAllocator: PERSISTENT_RESEARCH_PHASE8_VERSION,
    siteProfiler: SITE_PROFILER_POLICY_VERSION,
    acquisitionLadder: ACQUISITION_LADDER_POLICY_VERSION,
    frontierManager: FRONTIER_POLICY_VERSION,
    domainLearner: DOMAIN_LEARNER_POLICY_VERSION,
    llmAssist: LLM_ASSIST_POLICY_VERSION,
    graphExpansion: GRAPH_EXPANSION_POLICY_VERSION,
    relationshipCanary: RELATIONSHIP_CANARY_VERSION,
    autonomousQueryAuthority: AUTONOMOUS_QUERY_AUTHORITY_POLICY_VERSION,
    candidateTriage: CANDIDATE_TRIAGE_POLICY_VERSION,
  },
): void {
  const frozen: Record<string, string> = {
    selectionExperiment: 'query-selection-experiment-v1',
    thompsonObservationMap: 'thompson-observation-map-v1',
    queryFeaturesMap: 'query-features-v1',
    retrievalExperiment: 'retrieval-experiment-v1',
    allocationChallenger: 'allocation-challenger-v1',
    trialFunnelMap: 'trial-funnel-map-v1',
    frontierAllocator: 'discovery-frontier-allocator-v1',
    siteProfiler: 'site-profiler-v1',
    acquisitionLadder: 'acquisition-ladder-v1',
    frontierManager: 'frontier-manager-v1',
    domainLearner: 'domain-learner-v1',
    llmAssist: 'llm-assist-v1',
    graphExpansion: 'graph-expansion-v1',
    relationshipCanary: 'relationship-canary-v1',
    autonomousQueryAuthority: 'autonomous-query-authority-v2',
    candidateTriage: 'candidate-triage-v4-contextual-admission',
  };
  const mismatches = Object.keys(frozen).filter(key => live[key] !== frozen[key]);
  if (BENCHMARK_PREREG_ORDERING_WINDOW_DAYS !== 90) {
    mismatches.push('orderingWindowDays');
  }
  if (mismatches.length > 0) {
    throw new Error(`BENCHMARK_PREREG_VERSION_DRIFT: ${mismatches.join(',')}`);
  }
}

/**
 * Builds the exact frozen experiment request for one designated pool row.
 * Uses only frozen literals; the result must satisfy both the route
 * validator and isFrozenBenchmarkConfiguration, otherwise fail closed.
 */
export function buildFrozenBenchmarkRequest(snapshotHash: string, poolRowId: number, spec: BenchmarkPreregSpec = BENCHMARK_PREREG_V1_SPEC): NormalizedSelectionExperiment {
  const request: SelectionExperimentRequest = {
    selection: {
      experimentId: spec.frozenSelection.experimentId,
      enabledArms: [...spec.frozenSelection.enabledArms] as Array<'THOMPSON' | 'CONTEXTUAL'>,
      treatmentBasisPoints: spec.frozenSelection.treatmentBasisPoints,
      thompsonPrior: { ...spec.frozenSelection.thompsonPrior },
      contextualWeights: { ...spec.frozenSelection.contextualWeights },
    },
    ordering: {
      experimentId: spec.frozenOrdering.experimentId,
      treatmentBasisPoints: spec.frozenOrdering.treatmentBasisPoints,
    },
    benchmark: { snapshotHash, poolRowId },
  };
  const normalized = validateSelectionExperimentRequest(request);
  if (!normalized || !isFrozenBenchmarkConfiguration(normalized)) {
    throw new Error('BENCHMARK_PREREG_FROZEN_REQUEST_REJECTED');
  }
  return normalized;
}

/**
 * Fail closed unless every benchmark-relevant gate is OFF/absent, the
 * canary kill switch is engaged (or absent), and query intelligence is not
 * paused. `settings` is the app_settings dump (missing key = default OFF).
 */
export function verifyBenchmarkGatesOff(settings: Record<string, string>): void {
  const violations: string[] = [];
  for (const key of BENCHMARK_PREREG_REQUIRED_OFF_KEYS) {
    const value = settings[key];
    if (value !== undefined && value !== '' && value !== 'false' && value !== '0') {
      violations.push(`${key}=${value}`);
    }
  }
  const killSwitch = settings['relationship_canary_kill_switch'];
  if (killSwitch !== undefined && killSwitch !== '' && killSwitch !== 'true') {
    violations.push(`relationship_canary_kill_switch=${killSwitch}`);
  }
  if (violations.length > 0) {
    throw new Error(`BENCHMARK_PREREG_GATE_ENGAGED: ${violations.join(',')}`);
  }
}

export interface PoolSnapshotInput {
  rows: QueryRecord[];
  collectedAt: Date;
  cooldownMinutes: number;
  maxPrimaryUses: number;
}

export interface PoolSnapshotRow {
  poolIndex: number;
  queryId: number;
  query: string;
  country: string;
}

export interface PoolSnapshot {
  specVersion: string;
  baseCommit: string;
  rulesVersion: string;
  collectedAt: string;
  cooldownMinutes: number;
  maxPrimaryUses: number;
  candidateRows: number;
  rows: PoolSnapshotRow[];
  exclusionCounts: Record<string, number>;
  snapshotHash: string;
}

/**
 * Builds the frozen pool snapshot: the first 120 eligible opportunities in
 * deterministic snapshot ID ascending order. Eligibility mirrors the
 * production selection pipeline stage by stage (reservable → cooldown →
 * primary-term diversity → intent rotation → authority → retrieval shape),
 * so snapshot membership predicts schedulability without changing any gate.
 * Pure and deterministic: identical inputs always yield the identical hash.
 */
export function buildPoolSnapshot(input: PoolSnapshotInput, spec: BenchmarkPreregSpec = BENCHMARK_PREREG_V1_SPEC): PoolSnapshot {
  const { rows, collectedAt, cooldownMinutes, maxPrimaryUses } = input;
  const exclusionCounts: Record<string, number> = {};
  const exclude = (reason: string) => {
    exclusionCounts[reason] = (exclusionCounts[reason] || 0) + 1;
  };
  const reservable = rows.filter(query => {
    // Mirrors production selection/reservation: only ACTIVE rows are
    // schedulable (getQueriesByCountry requires status='ACTIVE').
    if (query.status !== 'ACTIVE') {
      exclude('NOT_ACTIVE');
      return false;
    }
    const ok = reservableFilter(query, collectedAt);
    if (!ok) exclude('NOT_RESERVABLE');
    return ok;
  });
  // Cooldown, primary-term diversity, and intent rotation apply WITHIN each
  // country's query set in production (per-cycle country pools), never
  // across the whole library: group first so a recent query in country A
  // cannot exclude an otherwise eligible row in country B.
  const groups = new Map<string, QueryRecord[]>();
  for (const query of reservable) {
    const key = query.country.toLowerCase();
    const group = groups.get(key);
    if (group) group.push(query);
    else groups.set(key, [query]);
  }
  const gated: QueryRecord[] = [];
  for (const group of groups.values()) {
    const outsideCooldown = queriesOutsideCooldown(group, collectedAt, cooldownMinutes);
    exclusionCounts['IN_COOLDOWN'] = (exclusionCounts['IN_COOLDOWN'] || 0) + (group.length - outsideCooldown.length);
    const diverse = limitRepeatedPrimaryTerms(outsideCooldown, group, collectedAt, cooldownMinutes, maxPrimaryUses);
    exclusionCounts['PRIMARY_TERM_CAPPED'] = (exclusionCounts['PRIMARY_TERM_CAPPED'] || 0) + (outsideCooldown.length - diverse.length);
    const rotated = rotateAwayFromMostRecentIntent(diverse, group);
    exclusionCounts['MOST_RECENT_INTENT'] = (exclusionCounts['MOST_RECENT_INTENT'] || 0) + (diverse.length - rotated.length);
    gated.push(...rotated);
  }
  const authorized = gated.filter(query => {
    // Authority revalidation implies the retrieval-shape check
    // (evaluateAutonomousQueryAuthority rejects non-oriented queries with
    // CURRENT_RETRIEVAL_SHAPE_FAILED), so no separate shape stage exists.
    const decision = evaluateAutonomousQueryAuthority(query);
    if (!decision.eligible) {
      exclude(`AUTHORITY_${decision.reasonCodes[0] || 'REJECTED'}`);
      return false;
    }
    return true;
  });
  const ordered = [...authorized].sort((a, b) => a.id - b.id).slice(0, spec.scopeSize);
  const snapshotRows: PoolSnapshotRow[] = ordered.map((query, poolIndex) => ({
    poolIndex,
    queryId: query.id,
    query: query.query,
    country: query.country,
  }));
  const snapshotHash = createHash('sha256')
    .update(
      [spec.specVersion,
        spec.baseCommit,
        spec.poolRulesVersion,
        JSON.stringify(snapshotRows),
      ].join('\n')
    )
    .digest('hex');
  return {
    specVersion: spec.specVersion,
    baseCommit: spec.baseCommit,
    rulesVersion: spec.poolRulesVersion,
    collectedAt: collectedAt.toISOString(),
    cooldownMinutes,
    maxPrimaryUses,
    candidateRows: rows.length,
    rows: snapshotRows,
    exclusionCounts,
    snapshotHash,
  };
}

/** pool = sha256(specVersion + engineCommit + ordered snapshot + rules). */
export function verifyPoolSnapshotHash(snapshot: PoolSnapshot): void {
  const recomputed = createHash('sha256')
    .update(
      [
        snapshot.specVersion,
        snapshot.baseCommit,
        snapshot.rulesVersion,
        JSON.stringify(snapshot.rows),
      ].join('\n')
    )
    .digest('hex');
  if (
    recomputed !== snapshot.snapshotHash ||
    snapshot.baseCommit !== benchmarkPreregSpecForVersion(snapshot.specVersion).baseCommit ||
    snapshot.rows.length > benchmarkPreregSpecForVersion(snapshot.specVersion).scopeSize
  ) {
    throw new Error('BENCHMARK_PREREG_SNAPSHOT_MISMATCH');
  }
}

/**
 * Cryptographically/structurally binds the execution record to the loaded
 * snapshot before any scheduling. The record's embedded pool snapshot must
 * equal the complete loaded snapshot — every PoolSnapshot field, not just
 * hash/rows/metadata — and every designated opportunity must be exactly the
 * snapshot-derived set (snapshotHash + poolRowId + deterministic opportunity
 * id + country). A jointly edited record+snapshot pair can otherwise preserve
 * rows/hash while silently changing planning provenance (collection time,
 * limits, candidate/exclusion counts), causing ledger attribution lookups to
 * miss and misclassify as exclusions.
 */
export function verifyExecutionArtifactsBound(record: BenchmarkExecutionRecord, snapshot: PoolSnapshot): void {
  const embedded = record.poolSnapshot;
  if (
    embedded.snapshotHash !== snapshot.snapshotHash ||
    embedded.specVersion !== snapshot.specVersion ||
    embedded.baseCommit !== snapshot.baseCommit ||
    embedded.rulesVersion !== snapshot.rulesVersion ||
    embedded.collectedAt !== snapshot.collectedAt ||
    embedded.cooldownMinutes !== snapshot.cooldownMinutes ||
    embedded.maxPrimaryUses !== snapshot.maxPrimaryUses ||
    embedded.candidateRows !== snapshot.candidateRows ||
    JSON.stringify(embedded.exclusionCounts) !== JSON.stringify(snapshot.exclusionCounts) ||
    JSON.stringify(embedded.rows) !== JSON.stringify(snapshot.rows)
  ) {
    throw new Error('BENCHMARK_PREREG_RECORD_MISMATCH: execution record pool snapshot does not match loaded snapshot');
  }
  if (record.designatedOpportunities.length !== snapshot.rows.length) {
    throw new Error('BENCHMARK_PREREG_RECORD_MISMATCH: designated opportunity count does not match snapshot rows');
  }
  for (let index = 0; index < snapshot.rows.length; index++) {
    const row = snapshot.rows[index];
    const designated = record.designatedOpportunities[index] as
      | { snapshotHash?: string; poolRowId?: number; benchmarkOpportunityId?: string; country?: string }
      | undefined;
    const expectedId = `${benchmarkPreregSpecForVersion(record.specVersion).poolPrefix}:${snapshot.snapshotHash}:${row.queryId}`;
    if (
      !designated ||
      designated.snapshotHash !== snapshot.snapshotHash ||
      designated.poolRowId !== row.queryId ||
      designated.benchmarkOpportunityId !== expectedId ||
      designated.country !== row.country
    ) {
      throw new Error(`BENCHMARK_PREREG_RECORD_MISMATCH: designated opportunity mismatch at poolIndex=${index}`);
    }
  }
}

/**
 * configHash = sha256(engineCommit + specVersion + sorted app_settings dump
 * + max migration version + provider registry snapshot). Pure.
 */
export function computeConfigurationHash(input: {
  appSettings: Array<{ setting_key: string; setting_value: string }>;
  maxMigrationVersion: number;
  providerRegistry: Array<Record<string, unknown>>;
}): string {
  return createHash('sha256')
    .update(
      [
        BENCHMARK_PREREG_FROZEN_BASE_COMMIT,
        BENCHMARK_PREREG_SPEC_VERSION,
        JSON.stringify(input.appSettings),
        String(input.maxMigrationVersion),
        JSON.stringify(input.providerRegistry),
      ].join('\n')
    )
    .digest('hex');
}

export interface BenchmarkExecutionRecord {
  specVersion: string;
  frozenBaseCommit: string;
  runningCommit: string;
  poolSnapshot: PoolSnapshot;
  configurationHash: string;
  maxMigrationVersion: number;
  providerRegistry: Array<Record<string, unknown>>;
  /**
   * Full app_settings dump at plan time: the baseline for mid-execution
   * drift detection (gates + benchmark-relevant knobs). Operational cursors
   * are recorded but never compared (see detectConfigurationDrift).
   */
  appSettings: Array<{ setting_key: string; setting_value: string }>;
  /**
   * Knob values as RESOLVED at plan time (settings + environment as resolved
   * then). Mid-execution drift detection compares live-resolved values
   * against these recorded strings, so an environment change between plan
   * and execute cannot pass silently.
   */
  plannedKnobs: Record<string, string>;
  designatedOpportunities: Array<{ snapshotHash: string; poolRowId: number; benchmarkOpportunityId: string; country: string }>;
  status: 'PLANNED' | 'IN_PROGRESS' | 'COMPLETE' | 'INCOMPLETE';
  attempts: Array<Record<string, unknown>>;
  extras: Array<Record<string, unknown>>;
  stopReason: string | null;
  /**
   * Authoritative 14-day wall-clock anchor: the earliest matched benchmark
   * run's scheduled_at, persisted here so process restarts can never reset
   * the window. Null until the first observation; createdAt is the
   * provisional bound meanwhile (documented, never extended on restart).
   */
  firstObservedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Assembles the execution record. Fails closed on any frozen mismatch. */
export function buildExecutionRecord(input: {
  runningCommit: string;
  poolSnapshot: PoolSnapshot;
  configurationHash: string;
  maxMigrationVersion: number;
  providerRegistry: Array<Record<string, unknown>>;
  appSettings: Array<{ setting_key: string; setting_value: string }>;
  spec?: BenchmarkPreregSpec;
}): BenchmarkExecutionRecord {
  const activeSpec = input.spec ?? BENCHMARK_PREREG_V1_SPEC;
  verifyFrozenBenchmarkVersions();
  verifyPoolSnapshotHash(input.poolSnapshot);
  if (input.maxMigrationVersion < BENCHMARK_PREREG_FROZEN_MIGRATION_COUNT) {
    throw new Error('BENCHMARK_PREREG_MIGRATIONS_BEHIND');
  }
  const now = new Date().toISOString();
  return {
    specVersion: activeSpec.specVersion,
    frozenBaseCommit: activeSpec.baseCommit,
    runningCommit: input.runningCommit,
    poolSnapshot: input.poolSnapshot,
    configurationHash: input.configurationHash,
    maxMigrationVersion: input.maxMigrationVersion,
    providerRegistry: input.providerRegistry,
    appSettings: input.appSettings,
    plannedKnobs: effectiveBenchmarkKnobs(
      Object.fromEntries(input.appSettings.map(row => [row.setting_key, row.setting_value]))
    ),
    designatedOpportunities: input.poolSnapshot.rows.map(row => ({
      snapshotHash: input.poolSnapshot.snapshotHash,
      poolRowId: row.queryId,
      benchmarkOpportunityId: `${activeSpec.poolPrefix}:${input.poolSnapshot.snapshotHash}:${row.queryId}`,
      country: row.country,
    })),
    status: 'PLANNED',
    attempts: [],
    extras: [],
    stopReason: null,
    firstObservedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Normalizes a raw normalized request back through the validator (round-trip guard used by the runner). */
export function assertNormalizedRequestUsable(normalized: NormalizedSelectionExperiment | null): asserts normalized is NormalizedSelectionExperiment {
  if (!normalized || !isFrozenBenchmarkConfiguration(normalized)) {
    throw new Error('BENCHMARK_PREREG_FROZEN_REQUEST_REJECTED');
  }
}

/**
 * Fail closed unless the snapshot holds the full frozen scope. An
 * undersized plan is not an executable benchmark: the frozen scope is 120,
 * never silently fewer. Reports the deterministic reason (candidate volume
 * plus leading exclusion causes) so operators know what to remediate.
 */
export function assertFullScope(snapshot: PoolSnapshot, spec: BenchmarkPreregSpec = BENCHMARK_PREREG_V1_SPEC): void {
  if (snapshot.rows.length >= spec.scopeSize) return;
  const reasons = Object.entries(snapshot.exclusionCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reason, count]) => `${reason}=${count}`)
    .join(',');
  throw new Error(
    `BENCHMARK_PREREG_INSUFFICIENT_POOL: eligible=${snapshot.rows.length} required=${spec.scopeSize} candidates=${snapshot.candidateRows} exclusions:${reasons}`
  );
}

export type BenchmarkRowState =
  | 'NOT_ATTEMPTED'
  | 'AWAITING_TERMINAL'
  | 'OBSERVED_COMPLETE'
  | 'OBSERVED_FAILED'
  | 'EXCLUDED_ELIGIBILITY'
  | 'EXCLUDED_NO_CAPACITY'
  | 'EXCLUDED_SELECTED_ANOTHER'
  | 'EXCLUDED_EXECUTION_FAILURE';

const BENCHMARK_ROW_TERMINAL_STATES: BenchmarkRowState[] = [
  'OBSERVED_COMPLETE',
  'OBSERVED_FAILED',
  'EXCLUDED_ELIGIBILITY',
  'EXCLUDED_NO_CAPACITY',
  'EXCLUDED_SELECTED_ANOTHER',
  'EXCLUDED_EXECUTION_FAILURE',
];

/** Every designated opportunity needs one of these before scope can complete. */
export function isBenchmarkRowTerminal(state: BenchmarkRowState): boolean {
  return BENCHMARK_ROW_TERMINAL_STATES.includes(state);
}

export interface NoMatchClassification {
  state: Extract<BenchmarkRowState, 'EXCLUDED_ELIGIBILITY' | 'EXCLUDED_NO_CAPACITY' | 'EXCLUDED_SELECTED_ANOTHER' | 'EXCLUDED_EXECUTION_FAILURE'>;
  reason: string;
}

/**
 * Classifies a designated attempt that scheduled zero matched runs. Pure and
 * deterministic: every cycle report diagnostic is examined (not just the
 * first), scheduling/infrastructure failures stay EXECUTION_FAILURE and are
 * never mislabeled as eligibility, and a later SELECTED_ANOTHER cannot be
 * masked by an earlier skip. Never fabricates an observation.
 */
export function classifyNoMatchOutcome(input: {
  queuedCount?: number;
  remainingAutonomousQuota?: number | null;
  candidates?: Array<{ disposition?: string; reasonCode?: string }>;
  extrasCount: number;
}): NoMatchClassification {
  const candidates = input.candidates || [];
  // Scheduling/infrastructure failures surface as FAILED dispositions (the
  // cycle catches scheduling errors and records FAILED + sanitized
  // SCHEDULING_*/QUERY_RUN_*/CHILD_JOB_*/etc. reason codes). These must never
  // become eligibility exclusions.
  const failure = candidates.find(
    candidate =>
      candidate.disposition === 'FAILED' ||
      /SCHEDULING_|QUERY_RUN_|CHILD_JOB_|DECISION_EVENT|SQL_FAILURE|LINKAGE_FAILURE|INSERTION_FAILURE|UNKNOWN_SCHEDULING_FAILURE/.test(candidate.reasonCode || '')
  );
  if (failure) {
    const code = failure.reasonCode || failure.disposition || 'scheduling-failure';
    return { state: 'EXCLUDED_EXECUTION_FAILURE', reason: `EXECUTION_FAILURE:${code}` };
  }
  // A declined free choice is selected-another, never an eligibility
  // failure: the row's eligibility did not fail, the arm chose elsewhere.
  // Scan all diagnostics so an earlier skip cannot mask a later selection.
  const selectedAnother = candidates.find(candidate => /SELECTED_ANOTHER/.test(candidate.reasonCode || ''));
  if (selectedAnother || input.extrasCount > 0) {
    const code = selectedAnother?.reasonCode || `extras=${input.extrasCount}`;
    return {
      state: 'EXCLUDED_SELECTED_ANOTHER',
      reason: `SELECTED_ANOTHER_QUERY:${code}`,
    };
  }
  const capacityCode = candidates.find(candidate => /QUOTA|QUEUE|CAPACITY/.test(candidate.reasonCode || ''))?.reasonCode || '';
  // Queue-target/paced-capacity exhaustion surfaces as queuedCount 0 with
  // positive quota and an empty candidate list (the producer returns early
  // with QUOTA_OR_QUEUE_GUARD before recording any candidate). That is
  // capacity, never eligibility: it must not terminally exclude as
  // ELIGIBILITY. An explicit capacity code wins and is preserved; otherwise
  // an empty zero-queue report is NO_CAPACITY with its guard reason, while a
  // non-empty eligibility skip stays ELIGIBILITY.
  const queuedZero = (input.queuedCount || 0) === 0;
  const quotaExhausted = (input.remainingAutonomousQuota ?? 1) <= 0;
  const emptyZeroQueue = queuedZero && candidates.length === 0;
  if (capacityCode || (queuedZero && (quotaExhausted || emptyZeroQueue))) {
    return { state: 'EXCLUDED_NO_CAPACITY', reason: `NO_QUEUE_CAPACITY:${capacityCode || (quotaExhausted ? 'quota-exhausted' : 'queue-target-exhausted')}` };
  }
  const firstSkipped = candidates.find(candidate => candidate.disposition && candidate.disposition !== 'SCHEDULED');
  const code = firstSkipped?.reasonCode || firstSkipped?.disposition || '';
  return { state: 'EXCLUDED_ELIGIBILITY', reason: `ELIGIBILITY:${code || 'cycle-scheduled-nothing'}` };
}

/** True only when every designated row is terminally accounted. */
export function isScopeTerminallyAccounted(states: BenchmarkRowState[]): boolean {
  return states.length > 0 && states.every(isBenchmarkRowTerminal);
}

export interface TerminalObservationPoll {
  status: string;
  attributed: boolean;
  /** Authoritative completion instant (query_runs.completed_at), if known. */
  completedAt: string | null;
}

/**
 * Waits for a scheduled run to become a legitimate benchmark observation:
 * terminal status (COMPLETED/FAILED) AND a persisted accounting attribution
 * row. Scheduling alone is never an observation. The 14-day ceiling binds
 * the authoritative completion instant (completed_at), not the poll time: a
 * run that finished after the ceiling is rejected even if first polled
 * later, and a run that finished inside the ceiling is accepted. Fails
 * closed on the ceiling or a kill-switch halt; never fabricates. Inject
 * sleep/clock for tests; production polls the run ledger.
 */
export async function waitForTerminalObservation(
  pollRun: () => Promise<TerminalObservationPoll>,
  opts: {
    deadlineMs: number;
    nowMs?: () => number;
    sleepMs?: (ms: number) => Promise<void>;
    pollIntervalMs?: number;
    isHalted?: () => boolean | Promise<boolean>;
  }
): Promise<'OBSERVED_COMPLETE' | 'OBSERVED_FAILED'> {
  const nowMs = opts.nowMs ?? Date.now;
  const sleepMs = opts.sleepMs ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
  const interval = opts.pollIntervalMs ?? 60_000;
  for (;;) {
    if (await opts.isHalted?.()) throw new Error('BENCHMARK_PREREG_KILL_SWITCH');
    const observed = await pollRun();
    const terminal = observed.status === 'COMPLETED' || observed.status === 'FAILED';
    if (terminal && observed.attributed) {
      const completedMs = observed.completedAt ? new Date(observed.completedAt).getTime() : nowMs();
      if (completedMs > opts.deadlineMs) throw new Error('BENCHMARK_PREREG_WALL_CLOCK_CEILING');
      return observed.status === 'COMPLETED' ? 'OBSERVED_COMPLETE' : 'OBSERVED_FAILED';
    }
    if (nowMs() > opts.deadlineMs) throw new Error('BENCHMARK_PREREG_WALL_CLOCK_CEILING');
    await sleepMs(interval);
  }
}

/** Knobs compared for mid-execution drift (settings key → env key → default). */
export const BENCHMARK_PREREG_DRIFT_KNOBS: Array<{ setting: string; env: string; fallback: string }> = [
  { setting: 'query_intelligence_query_cooldown_minutes', env: 'QUERY_INTELLIGENCE_COOLDOWN_MINUTES', fallback: '360' },
  { setting: 'query_intelligence_primary_term_max_uses', env: 'QUERY_INTELLIGENCE_PRIMARY_TERM_MAX_USES', fallback: '2' },
  { setting: 'query_intelligence_exploration_ratio', env: 'QUERY_INTELLIGENCE_EXPLORATION_RATIO', fallback: '0.4' },
  { setting: 'discovery_batch_size', env: 'DISCOVERY_BATCH_SIZE', fallback: '5' },
  { setting: 'discovery_target_queue_depth', env: 'DISCOVERY_TARGET_QUEUE_DEPTH', fallback: '15' },
  { setting: 'discovery_autonomous_quota_percent', env: 'DISCOVERY_AUTONOMOUS_QUOTA_PERCENT', fallback: '70' },
  { setting: 'discovery_video_lane_percent', env: 'DISCOVERY_VIDEO_LANE_PERCENT', fallback: '70' },
  { setting: 'discovery_date_ordering_video_percent', env: 'DISCOVERY_DATE_ORDERING_VIDEO_PERCENT', fallback: '10' },
  { setting: 'autonomous_pagination_max_pages', env: 'AUTONOMOUS_PAGINATION_MAX_PAGES', fallback: '3' },
  { setting: 'autonomous_pagination_max_low_yield_pages', env: 'AUTONOMOUS_PAGINATION_MAX_LOW_YIELD_PAGES', fallback: '2' },
];

/** Effective knob values under the same precedence the engine uses. */
export function effectiveBenchmarkKnobs(
  settings: Record<string, string>,
  env: Record<string, string | undefined> = process.env
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const knob of BENCHMARK_PREREG_DRIFT_KNOBS) {
    out[knob.setting] = settings[knob.setting] ?? env[knob.env] ?? knob.fallback;
  }
  return out;
}

export interface DriftCheckProvenance {
  settings: Record<string, string>;
  providerRegistry: unknown;
  maxMigrationVersion: number;
}

/**
 * Compares live provenance against the planned record. The planned knobs
 * are the RESOLVED values stored at plan time (settings + environment as
 * resolved then); the current side re-resolves the same way now. An
 * environment-backed setting that changes between plan and execute is
 * therefore drift, not invisible: the plan stores the earlier environment
 * value. Any difference in gates, benchmark-relevant knobs, provider
 * registry, migration level, or code versions fails closed.
 */

/**
 * Compares live provenance against the planned record. Any difference in
 * gates, benchmark-relevant knobs, provider registry, migration level, or
 * code versions is drift: fail closed, schedule nothing further. Operational
 * cursors (country index, materialization cursors, scheduler state) are
 * intentionally outside the checked set — they cannot change treatment.
 */
export function detectConfigurationDrift(
  planned: { knobs: Record<string, string>; providerRegistry: unknown; maxMigrationVersion: number },
  current: DriftCheckProvenance,
  env: Record<string, string | undefined> = process.env
): string[] {
  const drift: string[] = [];
  try {
    verifyBenchmarkGatesOff(current.settings);
  } catch (error) {
    drift.push(error instanceof Error ? error.message : String(error));
  }
  try {
    verifyFrozenBenchmarkVersions();
  } catch (error) {
    drift.push(error instanceof Error ? error.message : String(error));
  }
  const currentKnobs = effectiveBenchmarkKnobs(current.settings, env);
  for (const knob of BENCHMARK_PREREG_DRIFT_KNOBS) {
    if (planned.knobs[knob.setting] !== currentKnobs[knob.setting]) {
      drift.push(`BENCHMARK_PREREG_KNOB_DRIFT:${knob.setting}:${planned.knobs[knob.setting]}->${currentKnobs[knob.setting]}`);
    }
  }
  if (JSON.stringify(planned.providerRegistry) !== JSON.stringify(current.providerRegistry)) {
    drift.push('BENCHMARK_PREREG_PROVIDER_REGISTRY_DRIFT');
  }
  if (current.maxMigrationVersion !== planned.maxMigrationVersion) {
    drift.push(`BENCHMARK_PREREG_MIGRATION_DRIFT:${planned.maxMigrationVersion}->${current.maxMigrationVersion}`);
  }
  return drift;
}

/** 14-day ceiling from the durable anchor (first observation, else record creation). */
export function benchmarkDeadlineMs(firstObservedAt: string | null, createdAt: string): number {
  return new Date(firstObservedAt || createdAt).getTime() + BENCHMARK_PREREG_WALL_CLOCK_DAYS * 24 * 60 * 60 * 1000;
}

export function isWallClockExceeded(nowMs: number, firstObservedAt: string | null, createdAt: string): boolean {
  return nowMs > benchmarkDeadlineMs(firstObservedAt, createdAt);
}

export type RowAttemptPlan = 'skip-covered' | 'adopt-recovered' | 'schedule-attempt';

/**
 * Resume-safe per-row decision. Recovery is idempotent by construction:
 * matched runs discovered in the durable ledger are adopted (never
 * rescheduled merely because local attempt state was lost); only a row
 * with zero matched runs proceeds to scheduling.
 */
export function planRowAttempt(args: { covered: boolean; matchedRunIds: string[] }): RowAttemptPlan {
  if (args.covered) return 'skip-covered';
  if (args.matchedRunIds.length > 0) return 'adopt-recovered';
  return 'schedule-attempt';
}
