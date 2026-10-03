/**
 * Execution plumbing for benchmark-preregistration-v1.
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
export function buildFrozenBenchmarkRequest(snapshotHash: string, poolRowId: number): NormalizedSelectionExperiment {
  const request: SelectionExperimentRequest = {
    selection: {
      experimentId: BENCHMARK_PREREG_FROZEN_SELECTION.experimentId,
      enabledArms: [...BENCHMARK_PREREG_FROZEN_SELECTION.enabledArms] as Array<'THOMPSON' | 'CONTEXTUAL'>,
      treatmentBasisPoints: BENCHMARK_PREREG_FROZEN_SELECTION.treatmentBasisPoints,
      thompsonPrior: { ...BENCHMARK_PREREG_FROZEN_SELECTION.thompsonPrior },
      contextualWeights: { ...BENCHMARK_PREREG_FROZEN_SELECTION.contextualWeights },
    },
    ordering: {
      experimentId: BENCHMARK_PREREG_FROZEN_ORDERING.experimentId,
      treatmentBasisPoints: BENCHMARK_PREREG_FROZEN_ORDERING.treatmentBasisPoints,
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
 * Builds the frozen pool snapshot: the first 300 eligible opportunities in
 * deterministic snapshot ID ascending order. Eligibility mirrors the
 * production selection pipeline stage by stage (reservable → cooldown →
 * primary-term diversity → intent rotation → authority → retrieval shape),
 * so snapshot membership predicts schedulability without changing any gate.
 * Pure and deterministic: identical inputs always yield the identical hash.
 */
export function buildPoolSnapshot(input: PoolSnapshotInput): PoolSnapshot {
  const { rows, collectedAt, cooldownMinutes, maxPrimaryUses } = input;
  const exclusionCounts: Record<string, number> = {};
  const exclude = (reason: string) => {
    exclusionCounts[reason] = (exclusionCounts[reason] || 0) + 1;
  };
  const reservable = rows.filter(query => {
    const ok = reservableFilter(query, collectedAt);
    if (!ok) exclude('NOT_RESERVABLE');
    return ok;
  });
  const outsideCooldown = queriesOutsideCooldown(reservable, collectedAt, cooldownMinutes);
  exclusionCounts['IN_COOLDOWN'] = reservable.length - outsideCooldown.length;
  const diverse = limitRepeatedPrimaryTerms(outsideCooldown, rows, collectedAt, cooldownMinutes, maxPrimaryUses);
  exclusionCounts['PRIMARY_TERM_CAPPED'] = outsideCooldown.length - diverse.length;
  const rotated = rotateAwayFromMostRecentIntent(diverse, rows);
  exclusionCounts['MOST_RECENT_INTENT'] = diverse.length - rotated.length;
  const authorized = rotated.filter(query => {
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
  const ordered = [...authorized].sort((a, b) => a.id - b.id).slice(0, BENCHMARK_PREREG_SCOPE_SIZE);
  const snapshotRows: PoolSnapshotRow[] = ordered.map((query, poolIndex) => ({
    poolIndex,
    queryId: query.id,
    query: query.query,
    country: query.country,
  }));
  const snapshotHash = createHash('sha256')
    .update(
      [
        BENCHMARK_PREREG_SPEC_VERSION,
        BENCHMARK_PREREG_FROZEN_BASE_COMMIT,
        BENCHMARK_PREREG_POOL_RULES_VERSION,
        JSON.stringify(snapshotRows),
      ].join('\n')
    )
    .digest('hex');
  return {
    specVersion: BENCHMARK_PREREG_SPEC_VERSION,
    baseCommit: BENCHMARK_PREREG_FROZEN_BASE_COMMIT,
    rulesVersion: BENCHMARK_PREREG_POOL_RULES_VERSION,
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
    snapshot.specVersion !== BENCHMARK_PREREG_SPEC_VERSION ||
    snapshot.baseCommit !== BENCHMARK_PREREG_FROZEN_BASE_COMMIT ||
    snapshot.rows.length > BENCHMARK_PREREG_SCOPE_SIZE
  ) {
    throw new Error('BENCHMARK_PREREG_SNAPSHOT_MISMATCH');
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
  designatedOpportunities: Array<{ snapshotHash: string; poolRowId: number; benchmarkOpportunityId: string; country: string }>;
  status: 'PLANNED' | 'IN_PROGRESS' | 'COMPLETE' | 'INCOMPLETE';
  attempts: Array<Record<string, unknown>>;
  extras: Array<Record<string, unknown>>;
  stopReason: string | null;
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
}): BenchmarkExecutionRecord {
  verifyFrozenBenchmarkVersions();
  verifyPoolSnapshotHash(input.poolSnapshot);
  if (input.maxMigrationVersion < BENCHMARK_PREREG_FROZEN_MIGRATION_COUNT) {
    throw new Error('BENCHMARK_PREREG_MIGRATIONS_BEHIND');
  }
  const now = new Date().toISOString();
  return {
    specVersion: BENCHMARK_PREREG_SPEC_VERSION,
    frozenBaseCommit: BENCHMARK_PREREG_FROZEN_BASE_COMMIT,
    runningCommit: input.runningCommit,
    poolSnapshot: input.poolSnapshot,
    configurationHash: input.configurationHash,
    maxMigrationVersion: input.maxMigrationVersion,
    providerRegistry: input.providerRegistry,
    designatedOpportunities: input.poolSnapshot.rows.map(row => ({
      snapshotHash: input.poolSnapshot.snapshotHash,
      poolRowId: row.queryId,
      benchmarkOpportunityId: `benchmark-prereg-v1:pool:${input.poolSnapshot.snapshotHash}:${row.queryId}`,
      country: row.country,
    })),
    status: 'PLANNED',
    attempts: [],
    extras: [],
    stopReason: null,
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
