import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import type { QueryRecord } from '../src/types';
import {
  BENCHMARK_PREREG_V2_SPEC,
  BENCHMARK_PREREG_V2_FROZEN_BASE_COMMIT,
  benchmarkPreregSpecForVersion,
  isSameUtcDayPlan,
  isSchedulerStoppedForBenchmark,
  requireFreshPlanForStatus,
  assertExecutionPreflightReady,
  BENCHMARK_PREREG_SPEC_VERSION,
  BENCHMARK_PREREG_FROZEN_BASE_COMMIT,
  BENCHMARK_PREREG_SCOPE_SIZE,
  BENCHMARK_PREREG_FROZEN_SELECTION,
  BENCHMARK_PREREG_FROZEN_ORDERING,
  verifyFrozenBenchmarkVersions,
  verifyBenchmarkGatesOff,
  buildFrozenBenchmarkRequest,
  buildPoolSnapshot,
  verifyPoolSnapshotHash,
  verifyExecutionArtifactsBound,
  assertFullScope,
  computeConfigurationHash,
  buildExecutionRecord,
} from './benchmarkPreregV1';
import { isFrozenBenchmarkConfiguration } from './querySelectionExperiments';

function eligibleRow(id: number, overrides: Record<string, unknown> = {}): QueryRecord {
  return {
    id,
    query: `trading strategy ${id}`,
    country: 'US',
    collection: 'EXPERIMENTAL',
    intent: 'strategy',
    times_executed: 0,
    last_executed: null,
    total_channels_found: 0,
    unique_channels_found: 0,
    quality_channels_found: 0,
    community_channels_found: 0,
    avg_quality_score: 0,
    performance_score: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    status: 'ACTIVE',
    generation_metadata: {
      retrievalSpecificity: { policyVersion: 'retrieval-specificity-v2', eligibility: 'STANDALONE' },
      queryTemplate: 'SINGLE_ATOM',
    },
    ...overrides,
  } as QueryRecord;
}

test('frozen request builder uses exactly the preregistered configuration', () => {
  const request = buildFrozenBenchmarkRequest('abc123', 42);
  assert.equal(request.selection?.experimentId, 'benchmark-prereg-v1-selection');
  assert.deepEqual(request.selection?.enabledArms, ['THOMPSON', 'CONTEXTUAL']);
  assert.equal(request.selection?.treatmentBasisPoints, 5000);
  assert.deepEqual(request.selection?.thompsonPrior, { alpha0: 1, beta0: 1 });
  assert.deepEqual(request.selection?.contextualWeights, { value: 0.5, exploration: 0.35, cost: 0.1 });
  assert.equal(request.ordering?.experimentId, 'benchmark-prereg-v1-ordering');
  assert.equal(request.ordering?.treatmentBasisPoints, 5000);
  assert.deepEqual(request.benchmark, { snapshotHash: 'abc123', poolRowId: 42 });
  assert.equal(isFrozenBenchmarkConfiguration(request), true);
  assert.deepEqual(BENCHMARK_PREREG_FROZEN_SELECTION.experimentId, 'benchmark-prereg-v1-selection');
  assert.deepEqual(BENCHMARK_PREREG_FROZEN_ORDERING.experimentId, 'benchmark-prereg-v1-ordering');
});

test('frozen version verification passes live and fails on drift', () => {
  verifyFrozenBenchmarkVersions();
  assert.throws(
    () => verifyFrozenBenchmarkVersions({ selectionExperiment: 'tampered-v9' } as Record<string, string>),
    /BENCHMARK_PREREG_VERSION_DRIFT/
  );
});

test('pool snapshot is deterministic, id-ordered, capped at 300, with counted exclusions', () => {
  const now = new Date('2026-05-01T00:00:00.000Z');
  const rows: QueryRecord[] = [];
  for (let id = 400; id >= 1; id--) {
    if (id % 17 === 0) rows.push(eligibleRow(id, { collection: 'REJECTED' }));
    else if (id % 23 === 0) rows.push(eligibleRow(id, { query: 'x' }));
    else rows.push(eligibleRow(id));
  }
  const first = buildPoolSnapshot({ rows, collectedAt: now, cooldownMinutes: 360, maxPrimaryUses: 2 });
  const second = buildPoolSnapshot({ rows, collectedAt: now, cooldownMinutes: 360, maxPrimaryUses: 2 });
  assert.equal(first.rows.length, BENCHMARK_PREREG_SCOPE_SIZE);
  assert.deepEqual(first.rows.map(row => row.queryId), [...first.rows.map(row => row.queryId)].sort((a, b) => a - b));
  assert.equal(first.snapshotHash, second.snapshotHash);
  assert.ok((first.exclusionCounts['NOT_RESERVABLE'] || 0) > 0);
  assert.ok((first.exclusionCounts['AUTHORITY_CURRENT_RETRIEVAL_SHAPE_FAILED'] || 0) > 0);
  assert.equal(first.specVersion, BENCHMARK_PREREG_SPEC_VERSION);
  assert.equal(first.baseCommit, BENCHMARK_PREREG_FROZEN_BASE_COMMIT);
  verifyPoolSnapshotHash(first);
  // Any post-hoc pool modification breaks verification.
  const tampered = { ...first, rows: first.rows.slice(1) };
  assert.throws(() => verifyPoolSnapshotHash(tampered), /BENCHMARK_PREREG_SNAPSHOT_MISMATCH/);
});

test('gates fail closed unless everything benchmark-relevant is off', () => {
  verifyBenchmarkGatesOff({});
  verifyBenchmarkGatesOff({ site_profiler_enabled: 'false', relationship_canary_kill_switch: 'true' });
  for (const key of ['site_profiler_enabled', 'frontier_trials_enabled', 'query_intelligence_paused']) {
    assert.throws(() => verifyBenchmarkGatesOff({ [key]: 'true' }), /BENCHMARK_PREREG_GATE_ENGAGED/);
  }
  assert.throws(
    () => verifyBenchmarkGatesOff({ relationship_canary_kill_switch: 'false' }),
    /BENCHMARK_PREREG_GATE_ENGAGED/
  );
});

test('execution record carries the full frozen provenance', () => {
  const now = new Date('2026-05-01T00:00:00.000Z');
  const rows = Array.from({ length: 5 }, (_, index) => eligibleRow(index + 1));
  const snapshot = buildPoolSnapshot({ rows, collectedAt: now, cooldownMinutes: 360, maxPrimaryUses: 2 });
  const record = buildExecutionRecord({
    runningCommit: 'test-commit',
    poolSnapshot: snapshot,
    configurationHash: computeConfigurationHash({ appSettings: [], maxMigrationVersion: 137, providerRegistry: [] }),
    maxMigrationVersion: 137,
    providerRegistry: [],
    appSettings: [{ setting_key: 'site_profiler_enabled', setting_value: 'false' }],
  });
  assert.equal(record.specVersion, 'benchmark-preregistration-v1');
  assert.equal(record.frozenBaseCommit, '4b49e0c01ac53eebf0080fae29bd6aaabb803cfc');
  assert.equal(record.designatedOpportunities.length, 5);
  assert.equal(record.designatedOpportunities[0].benchmarkOpportunityId, `benchmark-prereg-v1:pool:${snapshot.snapshotHash}:1`);
  assert.equal(record.status, 'PLANNED');
  assert.throws(
    () => buildExecutionRecord({
      runningCommit: 'test-commit', poolSnapshot: snapshot, configurationHash: 'x', maxMigrationVersion: 100, providerRegistry: [], appSettings: [],
    }),
    /BENCHMARK_PREREG_MIGRATIONS_BEHIND/
  );
});

test('runner script cannot substitute an unrelated benchmark', () => {
  const source = fs.readFileSync(new URL('../scripts/runBenchmarkPreregV1.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from '.*fastBenchmark/);
  assert.doesNotMatch(source, /from '.*evaluateBenchmark/);
  assert.doesNotMatch(source, /import.*semantic/i);
  // Scheduling is impossible without the explicit execute flag.
  assert.match(source, /--execute/);
  assert.match(source, /runAutonomousDiscoveryCycle/);
  assert.match(source, /buildFrozenBenchmarkRequest/);
  assert.match(source, /verifyFrozenBenchmarkVersions/);
  assert.match(source, /verifyBenchmarkGatesOff/);
});

test('planning cannot reach scheduling without the explicit execute mode', () => {
  const source = fs.readFileSync(new URL('../scripts/runBenchmarkPreregV1.ts', import.meta.url), 'utf8');
  const cliSource = fs.readFileSync(new URL('./benchmarkPreregCli.ts', import.meta.url), 'utf8');
  // Default mode is plan; only the literal --execute flag selects execute.
  assert.match(cliSource, /let mode: 'plan' \| 'execute' = 'plan'/);
  assert.match(cliSource, /if \(arg === '--execute'\) mode = 'execute'/);
  // The plan branch returns before any scheduling site.
  const planGuard = source.indexOf("if (mode === 'plan')");
  const scheduleSite = source.indexOf('runAutonomousDiscoveryCycle(row.country');
  const executeGuard = source.indexOf('BENCHMARK_PREREG_NO_PLAN');
  assert.ok(planGuard !== -1 && scheduleSite !== -1 && executeGuard !== -1);
  assert.ok(planGuard < scheduleSite, 'plan branch must precede scheduling');
  assert.ok(executeGuard < scheduleSite, 'execute guard must precede scheduling');
  assert.ok(source.slice(planGuard, scheduleSite).includes('return;'), 'plan path must early-return before scheduling');
  // Scheduling happens only after the frozen execution record is bound and
  // marked IN_PROGRESS (persisted), never from the plan path.
  const inProgressMark = source.indexOf("record.status = 'IN_PROGRESS'");
  assert.ok(inProgressMark !== -1 && inProgressMark < scheduleSite);
  assert.match(source, /verifyExecutionArtifactsBound\(record, snapshot\)/);
  // The engine import is dynamic and occurs only on the execute path.
  const dynamicImport = source.indexOf("await import('../server/autonomousDiscovery')");
  assert.ok(dynamicImport !== -1 && dynamicImport < scheduleSite);
});

test('pool eligibility is country-scoped like production', () => {
  const now = new Date('2026-05-01T00:00:00.000Z');
  const recent = new Date(now.getTime() - 60_000).toISOString();
  const rows: QueryRecord[] = [
    eligibleRow(1, { country: 'US', query: 'shared alpha query', last_executed: recent, times_executed: 1 }),
    eligibleRow(2, { country: 'US', query: 'shared alpha query', times_executed: 0, last_executed: null }),
    eligibleRow(3, { country: 'CA', query: 'shared alpha query', times_executed: 0, last_executed: null }),
  ];
  const snapshot = buildPoolSnapshot({ rows, collectedAt: now, cooldownMinutes: 360, maxPrimaryUses: 2 });
  const ids = snapshot.rows.map(row => row.queryId);
  // Row 2 shares normalized text with recently executed row 1 in the SAME
  // country: correctly cooled out. Row 3 shares the text across countries:
  // production scopes cooldown per country, so it must survive.
  assert.ok(!ids.includes(2));
  assert.ok(ids.includes(3));
  assert.ok((snapshot.exclusionCounts['IN_COOLDOWN'] || 0) >= 1);
});

test('inactive rows never consume designated slots', () => {
  const now = new Date('2026-05-01T00:00:00.000Z');
  const rows: QueryRecord[] = [
    eligibleRow(1),
    eligibleRow(2, { status: 'ARCHIVED' }),
  ];
  const snapshot = buildPoolSnapshot({ rows, collectedAt: now, cooldownMinutes: 360, maxPrimaryUses: 2 });
  assert.deepEqual(snapshot.rows.map(row => row.queryId), [1]);
  assert.equal(snapshot.exclusionCounts['NOT_ACTIVE'], 1);
});

test('undersized plans fail closed with a deterministic reason', async () => {
  const { assertFullScope } = await import('./benchmarkPreregV1');
  const now = new Date('2026-05-01T00:00:00.000Z');
  const small = buildPoolSnapshot({
    rows: [eligibleRow(1), eligibleRow(2)],
    collectedAt: now, cooldownMinutes: 360, maxPrimaryUses: 2,
  });
  assert.throws(() => assertFullScope(small), /BENCHMARK_PREREG_INSUFFICIENT_POOL.*eligible=2.*required=300/);
  const full = buildPoolSnapshot({
    rows: Array.from({ length: 320 }, (_, index) => eligibleRow(index + 1)),
    collectedAt: now, cooldownMinutes: 360, maxPrimaryUses: 2,
  });
  assertFullScope(full);
});

test('row accounting states distinguish every terminal outcome', async () => {
  const { isBenchmarkRowTerminal, classifyNoMatchOutcome, isScopeTerminallyAccounted } = await import('./benchmarkPreregV1');
  assert.equal(isBenchmarkRowTerminal('NOT_ATTEMPTED'), false);
  assert.equal(isBenchmarkRowTerminal('AWAITING_TERMINAL'), false);
  for (const terminal of ['OBSERVED_COMPLETE', 'OBSERVED_FAILED', 'EXCLUDED_ELIGIBILITY', 'EXCLUDED_NO_CAPACITY', 'EXCLUDED_SELECTED_ANOTHER', 'EXCLUDED_EXECUTION_FAILURE'] as const) {
    assert.equal(isBenchmarkRowTerminal(terminal), true);
  }
  // Genuine eligibility exclusion carries its gate code.
  assert.deepEqual(
    classifyNoMatchOutcome({ queuedCount: 5, remainingAutonomousQuota: 100, candidates: [{ disposition: 'SKIPPED', reasonCode: 'QUERY_INTELLIGENCE_AUTHORITY_REJECTED' }], extrasCount: 0 }),
    { state: 'EXCLUDED_ELIGIBILITY', reason: 'ELIGIBILITY:QUERY_INTELLIGENCE_AUTHORITY_REJECTED' }
  );
  // Quota exhaustion is capacity, not eligibility.
  assert.deepEqual(
    classifyNoMatchOutcome({ queuedCount: 0, remainingAutonomousQuota: 0, candidates: [], extrasCount: 0 }).state,
    'EXCLUDED_NO_CAPACITY'
  );
  // Scheduled-but-unmatched runs are selected-another, never silent.
  assert.deepEqual(
    classifyNoMatchOutcome({ queuedCount: 3, remainingAutonomousQuota: 100, candidates: [], extrasCount: 2 }).state,
    'EXCLUDED_SELECTED_ANOTHER'
  );
  // A declined free choice keeps its selected-another state even with zero
  // extras: the row's eligibility did not fail, the arm chose elsewhere.
  assert.deepEqual(
    classifyNoMatchOutcome({ queuedCount: 3, remainingAutonomousQuota: 100, candidates: [{ disposition: 'SKIPPED', reasonCode: 'SELECTED_ANOTHER_QUERY' }], extrasCount: 0 }),
    { state: 'EXCLUDED_SELECTED_ANOTHER', reason: 'SELECTED_ANOTHER_QUERY:SELECTED_ANOTHER_QUERY' }
  );
  // Scope completes only when nothing is pending or unattempted.
  assert.equal(isScopeTerminallyAccounted(['OBSERVED_COMPLETE', 'OBSERVED_FAILED', 'EXCLUDED_ELIGIBILITY']), true);
  assert.equal(isScopeTerminallyAccounted(['OBSERVED_COMPLETE', 'NOT_ATTEMPTED']), false);
  assert.equal(isScopeTerminallyAccounted(['OBSERVED_COMPLETE', 'AWAITING_TERMINAL']), false);
  assert.equal(isScopeTerminallyAccounted([]), false);
});

test('scheduled runs become observations only at terminal attribution', async () => {
  const { waitForTerminalObservation } = await import('./benchmarkPreregV1');
  let clock = 0;
  let calls = 0;
  const script: Array<{ status: string; attributed: boolean; completedAt: string | null }> = [
    { status: 'RUNNING', attributed: false, completedAt: null },
    { status: 'RUNNING', attributed: false, completedAt: null },
    { status: 'COMPLETED', attributed: false, completedAt: null },
    { status: 'COMPLETED', attributed: true, completedAt: new Date(5_000).toISOString() },
  ];
  const outcome = await waitForTerminalObservation(
    async () => script[Math.min(calls++, script.length - 1)],
    {
      deadlineMs: 10_000,
      nowMs: () => clock,
      sleepMs: async ms => { clock += ms; },
      pollIntervalMs: 1_000,
    }
  );
  assert.equal(outcome, 'OBSERVED_COMPLETE');
  assert.equal(calls, 4);
  assert.equal(clock, 3000);
  // A run that finished after the ceiling is rejected even if polled later.
  await assert.rejects(
    waitForTerminalObservation(
      async () => ({ status: 'COMPLETED', attributed: true, completedAt: new Date(20_000).toISOString() }),
      { deadlineMs: 10_000, nowMs: () => 30_000, sleepMs: async () => {}, pollIntervalMs: 1_000 }
    ),
    /BENCHMARK_PREREG_WALL_CLOCK_CEILING/
  );
  // Terminal status without attribution is not an observation yet.
  let ticks = 0;
  await assert.rejects(
    waitForTerminalObservation(
      async () => ({ status: 'FAILED', attributed: false, completedAt: null }),
      { deadlineMs: 500, nowMs: () => ticks, sleepMs: async ms => { ticks += ms; }, pollIntervalMs: 1_000 }
    ),
    /BENCHMARK_PREREG_WALL_CLOCK_CEILING/
  );
  // Kill-switch halts waiting without fabricating.
  await assert.rejects(
    waitForTerminalObservation(
      async () => ({ status: 'RUNNING', attributed: false, completedAt: null }),
      { deadlineMs: 60_000, nowMs: () => 0, sleepMs: async () => {}, pollIntervalMs: 1_000, isHalted: () => true }
    ),
    /BENCHMARK_PREREG_KILL_SWITCH/
  );
});

test('mid-execution drift fails closed with specifics', async () => {
  const { detectConfigurationDrift, effectiveBenchmarkKnobs } = await import('./benchmarkPreregV1');
  const knobsFor = (settings: Record<string, string>, env: Record<string, string | undefined> = {}) =>
    effectiveBenchmarkKnobs(settings, env);
  const baseSettings = { site_profiler_enabled: 'false', query_intelligence_query_cooldown_minutes: '360' };
  const base = {
    knobs: knobsFor(baseSettings),
    providerRegistry: [{ provider_key: 'youtube-search', mode: 'ACTIVE' }],
    maxMigrationVersion: 137,
  };
  const currentBase = {
    settings: { ...baseSettings },
    providerRegistry: [{ provider_key: 'youtube-search', mode: 'ACTIVE' }],
    maxMigrationVersion: 137,
  };
  assert.deepEqual(detectConfigurationDrift(base, structuredClone(currentBase), {}), []);
  const gateFlip = structuredClone(currentBase);
  gateFlip.settings['frontier_trials_enabled'] = 'true';
  assert.match(detectConfigurationDrift(base, gateFlip, {}).join(';'), /BENCHMARK_PREREG_GATE_ENGAGED/);
  const knobDrift = structuredClone(currentBase);
  knobDrift.settings['query_intelligence_query_cooldown_minutes'] = '30';
  assert.match(detectConfigurationDrift(base, knobDrift, {}).join(';'), /KNOB_DRIFT.*cooldown/);
  // An environment-backed setting that changes between plan and execute is
  // drift even though neither app_settings dump contains it: the plan stored
  // the resolved value, so the new resolution differs.
  assert.match(
    detectConfigurationDrift(base, { settings: {}, providerRegistry: base.providerRegistry, maxMigrationVersion: 137 }, { QUERY_INTELLIGENCE_EXPLORATION_RATIO: '0.9' }).join(';'),
    /KNOB_DRIFT.*exploration_ratio/
  );
  const registryDrift = structuredClone(currentBase);
  (registryDrift.providerRegistry as Array<Record<string, unknown>>).push({ provider_key: 'new-provider', mode: 'ACTIVE' });
  assert.match(detectConfigurationDrift(base, registryDrift, {}).join(';'), /PROVIDER_REGISTRY_DRIFT/);
  const migrationDrift = { ...structuredClone(currentBase), maxMigrationVersion: 138 };
  assert.match(detectConfigurationDrift(base, migrationDrift, {}).join(';'), /MIGRATION_DRIFT/);
  // Operational cursors are not treatment: they never count as drift.
  const cursorNoise = structuredClone(currentBase);
  cursorNoise.settings['qi_current_country_index'] = '7';
  cursorNoise.settings['country_native_materialization_cursor'] = '25';
  assert.deepEqual(detectConfigurationDrift(base, cursorNoise, {}), []);
  assert.equal(effectiveBenchmarkKnobs({}, {}).query_intelligence_query_cooldown_minutes, '360');
});

test('14-day anchor survives a process restart via the record', async () => {
  const { benchmarkDeadlineMs, isWallClockExceeded } = await import('./benchmarkPreregV1');
  const createdAt = '2026-05-01T00:00:00.000Z';
  const anchor = '2026-05-03T00:00:00.000Z';
  // Restart simulation: the anchor round-trips through JSON and still binds.
  const reloaded = JSON.parse(JSON.stringify({ firstObservedAt: anchor, createdAt })) as { firstObservedAt: string; createdAt: string };
  assert.equal(benchmarkDeadlineMs(reloaded.firstObservedAt, reloaded.createdAt), new Date('2026-05-17T00:00:00.000Z').getTime());
  assert.equal(isWallClockExceeded(new Date('2026-05-10T00:00:00.000Z').getTime(), reloaded.firstObservedAt, reloaded.createdAt), false);
  assert.equal(isWallClockExceeded(new Date('2026-05-18T00:00:00.000Z').getTime(), reloaded.firstObservedAt, reloaded.createdAt), true);
  // Before any observation the provisional anchor is record creation.
  assert.equal(benchmarkDeadlineMs(null, createdAt), new Date('2026-05-15T00:00:00.000Z').getTime());
});

test('resume adopts scheduled runs instead of duplicating them', async () => {
  const { planRowAttempt } = await import('./benchmarkPreregV1');
  assert.equal(planRowAttempt({ covered: true, matchedRunIds: ['run-1'] }), 'skip-covered');
  assert.equal(planRowAttempt({ covered: false, matchedRunIds: ['run-1'] }), 'adopt-recovered');
  assert.equal(planRowAttempt({ covered: false, matchedRunIds: [] }), 'schedule-attempt');
});

test('non-designated selections are declined, never scheduled, under benchmark scope', async () => {
  const fs = await import('node:fs');
  const source = fs.readFileSync(new URL('./autonomousDiscovery.ts', import.meta.url), 'utf8');
  // Arms choose freely; the output gate declines anything but the
  // designated row before scheduling, with a distinct skip reason.
  assert.match(source, /normalizedExperiment\?\.benchmark && selected\.queryRecord\.id !== normalizedExperiment\.benchmark\.poolRowId/);
  assert.match(source, /reasonCode: 'SELECTED_ANOTHER_QUERY'/);
  // Research/frontier/native allocations are declined on the same path.
  assert.match(source, /!normalizedExperiment\?\.benchmark/);
  assert.match(source, /Benchmark-designated attempt declines non-designated allocation/);
});

test('execution record is cryptographically bound to the loaded snapshot', async () => {
  const now = new Date('2026-05-01T00:00:00.000Z');
  const rows = Array.from({ length: 5 }, (_, index) => eligibleRow(index + 1));
  const snapshot = buildPoolSnapshot({ rows, collectedAt: now, cooldownMinutes: 360, maxPrimaryUses: 2 });
  const record = buildExecutionRecord({
    runningCommit: 'test-commit',
    poolSnapshot: snapshot,
    configurationHash: computeConfigurationHash({ appSettings: [], maxMigrationVersion: 137, providerRegistry: [] }),
    maxMigrationVersion: 137,
    providerRegistry: [],
    appSettings: [],
  });
  verifyExecutionArtifactsBound(record, snapshot);
  // A jointly edited record+snapshot pair with mismatched designated rows fails.
  const tamperedRecord = structuredClone(record);
  tamperedRecord.designatedOpportunities[0] = {
    ...tamperedRecord.designatedOpportunities[0],
    poolRowId: 999999,
    benchmarkOpportunityId: `benchmark-prereg-v1:pool:${snapshot.snapshotHash}:999999`,
  };
  assert.throws(() => verifyExecutionArtifactsBound(tamperedRecord, snapshot), /BENCHMARK_PREREG_RECORD_MISMATCH/);
  // A snapshot with different rows fails even when hashes are internally consistent.
  const other = buildPoolSnapshot({
    rows: Array.from({ length: 5 }, (_, index) => eligibleRow(index + 101)),
    collectedAt: now, cooldownMinutes: 360, maxPrimaryUses: 2,
  });
  assert.throws(() => verifyExecutionArtifactsBound(record, other), /BENCHMARK_PREREG_RECORD_MISMATCH/);
  // Planning provenance cannot silently change while rows/hash match: every
  // PoolSnapshot field is bound.
  for (const tamper of [
    (snap: typeof snapshot) => ({ ...snap, collectedAt: new Date('2026-06-01T00:00:00.000Z').toISOString() }),
    (snap: typeof snapshot) => ({ ...snap, cooldownMinutes: 30 }),
    (snap: typeof snapshot) => ({ ...snap, maxPrimaryUses: 9 }),
    (snap: typeof snapshot) => ({ ...snap, candidateRows: snap.candidateRows + 1 }),
    (snap: typeof snapshot) => ({ ...snap, exclusionCounts: { ...snap.exclusionCounts, TAMPERED: 1 } }),
  ]) {
    const tamperedSnapshot = tamper(structuredClone(snapshot));
    assert.throws(() => verifyExecutionArtifactsBound(record, tamperedSnapshot), /BENCHMARK_PREREG_RECORD_MISMATCH/);
  }
});

test('scheduling failures stay execution failures and later selections are not masked', async () => {
  const { classifyNoMatchOutcome } = await import('./benchmarkPreregV1');
  // FAILED scheduling diagnostics are execution failures, never eligibility.
  assert.deepEqual(
    classifyNoMatchOutcome({
      queuedCount: 0, remainingAutonomousQuota: 100,
      candidates: [{ disposition: 'FAILED', reasonCode: 'SCHEDULING_SQL_FAILURE' }],
      extrasCount: 0,
    }).state,
    'EXCLUDED_EXECUTION_FAILURE'
  );
  assert.deepEqual(
    classifyNoMatchOutcome({
      queuedCount: 0, remainingAutonomousQuota: 100,
      candidates: [{ disposition: 'FAILED', reasonCode: 'UNKNOWN_SCHEDULING_FAILURE' }],
      extrasCount: 0,
    }).state,
    'EXCLUDED_EXECUTION_FAILURE'
  );
  // An earlier skip cannot mask a later SELECTED_ANOTHER_QUERY.
  assert.deepEqual(
    classifyNoMatchOutcome({
      queuedCount: 3, remainingAutonomousQuota: 100,
      candidates: [
        { disposition: 'SKIPPED', reasonCode: 'QUERY_INTELLIGENCE_NO_ELIGIBLE_QUERY' },
        { disposition: 'SKIPPED', reasonCode: 'SELECTED_ANOTHER_QUERY' },
      ],
      extrasCount: 0,
    }),
    { state: 'EXCLUDED_SELECTED_ANOTHER', reason: 'SELECTED_ANOTHER_QUERY:SELECTED_ANOTHER_QUERY' }
  );
  // A FAILED diagnostic takes precedence over eligibility skips.
  assert.equal(
    classifyNoMatchOutcome({
      queuedCount: 3, remainingAutonomousQuota: 100,
      candidates: [
        { disposition: 'SKIPPED', reasonCode: 'QUERY_INTELLIGENCE_AUTHORITY_REJECTED' },
        { disposition: 'FAILED', reasonCode: 'QUERY_RUN_INSERTION_FAILURE' },
      ],
      extrasCount: 0,
    }).state,
    'EXCLUDED_EXECUTION_FAILURE'
  );
  // Queue-target exhaustion (zero queue, positive quota, empty candidates)
  // is capacity, never eligibility.
  assert.deepEqual(
    classifyNoMatchOutcome({ queuedCount: 0, remainingAutonomousQuota: 100, candidates: [], extrasCount: 0 }),
    { state: 'EXCLUDED_NO_CAPACITY', reason: 'NO_QUEUE_CAPACITY:queue-target-exhausted' }
  );
  // A genuine non-empty eligibility skip with positive quota stays eligibility.
  assert.deepEqual(
    classifyNoMatchOutcome({
      queuedCount: 0, remainingAutonomousQuota: 100,
      candidates: [{ disposition: 'SKIPPED', reasonCode: 'QUERY_INTELLIGENCE_NO_ELIGIBLE_QUERY' }],
      extrasCount: 0,
    }),
    { state: 'EXCLUDED_ELIGIBILITY', reason: 'ELIGIBILITY:QUERY_INTELLIGENCE_NO_ELIGIBLE_QUERY' }
  );
});

test('benchmark allocation release failures stop execution and committed races fail closed', async () => {
  const fs = await import('node:fs');
  const source = fs.readFileSync(new URL('./autonomousDiscovery.ts', import.meta.url), 'utf8');
  // Infrastructure failures in release are distinguishable and abort the run.
  assert.match(source, /BENCHMARK_ALLOCATION_RELEASE_FAILED/);
  assert.match(source, /\.catch\(error => \{\s*throw new Error\(`BENCHMARK_ALLOCATION_RELEASE_FAILED/);
  // COMMITTED is treated as stranded (unrelated work scheduled), not benign.
  assert.match(source, /\['RESERVED', 'COMMITTED'\]\.includes\(String\(releaseCheck\.rows\[0\]\.decision_status\)\)/);
});

test('benchmark honors the kill switch even with a target country', async () => {
  const fs = await import('node:fs');
  const cycle = fs.readFileSync(new URL('./autonomousDiscovery.ts', import.meta.url), 'utf8');
  assert.match(cycle, /hasBenchmarkScope/);
  assert.match(cycle, /shouldPauseDiscoveryCycle\(\{/);
  assert.match(cycle, /!input\.targetCountry \|\| input\.hasBenchmarkScope/);
  const script = fs.readFileSync(new URL('../scripts/runBenchmarkPreregV1.ts', import.meta.url), 'utf8');
  assert.match(script, /haltedByKillSwitch\(\)/);
  assert.match(script, /KILL_SWITCH_PAUSED/);
  assert.match(script, /record\.status = 'IN_PROGRESS'[\s\S]*writeFileSync\(recordPath/);
  assert.match(script, /INFRA_INCIDENT:LEDGER_UNREADABLE/);
  // The kill-switch read and the PAUSED abort are separate: the read has its
  // own try/catch that only handles read failures, and no message regex
  // distinguishes control flow.
  assert.match(script, /let killSwitchEngaged: boolean;/);
  assert.match(script, /killSwitchEngaged = await haltedByKillSwitch\(\);/);
  assert.match(script, /INFRA_INCIDENT:KILL_SWITCH_UNREADABLE/);
  assert.doesNotMatch(script, /KILL_SWITCH_PAUSED\|INCOMPLETE/);
});

test('v2 spec flows end to end without touching v1 behavior', () => {
  const v2 = BENCHMARK_PREREG_V2_SPEC;
  assert.equal(v2.specVersion, 'benchmark-preregistration-v2');
  assert.equal(v2.baseCommit, BENCHMARK_PREREG_V2_FROZEN_BASE_COMMIT);
  assert.equal(v2.scopeSize, 120);
  assert.equal(v2.poolPrefix, 'benchmark-prereg-v2:pool');
  assert.equal(v2.selectionExperimentId, 'benchmark-prereg-v2-selection');
  assert.equal(v2.orderingExperimentId, 'benchmark-prereg-v2-ordering');
  assert.equal(BENCHMARK_PREREG_V2_SPEC.baseCommit.length, 40);
  assert.throws(() => benchmarkPreregSpecForVersion('benchmark-preregistration-v99'), /BENCHMARK_PREREG_UNKNOWN_SPEC/);
  const rows = Array.from({ length: 130 }, (_, i) => eligibleRow(i + 1));
  const snapshot = buildPoolSnapshot(
    { rows, collectedAt: new Date('2026-10-08T12:00:00.000Z'), cooldownMinutes: 360, maxPrimaryUses: 2 },
    BENCHMARK_PREREG_V2_SPEC
  );
  assert.equal(snapshot.rows.length, 120);
  assert.equal(snapshot.specVersion, 'benchmark-preregistration-v2');
  assert.equal(snapshot.rulesVersion, 'pool-rules-benchmark-prereg-v2');
  const request = buildFrozenBenchmarkRequest(snapshot.snapshotHash, 7, BENCHMARK_PREREG_V2_SPEC);
  assert.equal(request.selection?.experimentId, 'benchmark-prereg-v2-selection');
  assert.equal(request.ordering?.experimentId, 'benchmark-prereg-v2-ordering');
  assert.equal(isFrozenBenchmarkConfiguration(request), true);
  assert.throws(() => assertFullScope({ ...snapshot, rows: snapshot.rows.slice(0, 119) }, BENCHMARK_PREREG_V2_SPEC), /required=120/);
  assert.equal(isSameUtcDayPlan(snapshot.collectedAt, new Date('2026-10-08T23:59:59.000Z')), true);
  assert.equal(isSameUtcDayPlan(snapshot.collectedAt, new Date('2026-10-09T00:00:01.000Z')), false);
  assert.equal(isSchedulerStoppedForBenchmark({ is_enabled: true, is_running: false }), true);
  assert.equal(isSchedulerStoppedForBenchmark({ is_enabled: false, is_running: false }), false);
  assert.equal(isSchedulerStoppedForBenchmark({ is_enabled: true, is_running: true }), false);
  assert.equal(isSchedulerStoppedForBenchmark({ is_enabled: false, is_running: true }), false);
  assert.equal(isSchedulerStoppedForBenchmark(null), false);
  assert.equal(isSchedulerStoppedForBenchmark({ is_enabled: true, is_running: false }, true), false);
  assert.equal(isSchedulerStoppedForBenchmark({ is_enabled: true, is_running: false }, false), true);
});

test('freshness gate applies to PLANNED start, never strands IN_PROGRESS recovery', () => {
  assert.doesNotThrow(() => requireFreshPlanForStatus('PLANNED', '2026-10-08T12:00:00.000Z', new Date('2026-10-08T23:00:00.000Z')));
  assert.throws(
    () => requireFreshPlanForStatus('PLANNED', '2026-10-08T12:00:00.000Z', new Date('2026-10-09T00:30:00.000Z')),
    /BENCHMARK_PREREG_PLAN_STALE/
  );
  assert.doesNotThrow(() => requireFreshPlanForStatus('IN_PROGRESS', '2026-10-08T12:00:00.000Z', new Date('2026-10-09T00:30:00.000Z')));
  assert.doesNotThrow(() => requireFreshPlanForStatus('IN_PROGRESS', '2026-10-08T12:00:00.000Z', new Date('2026-10-08T23:00:00.000Z')));
  assert.throws(() => requireFreshPlanForStatus('COMPLETE', '2026-10-08T12:00:00.000Z', new Date('2026-10-08T23:00:00.000Z')), /BENCHMARK_PREREG_PLAN_STALE/);
});

test('combined preflight rejects non-quiescent schedulers before any IN_PROGRESS transition', () => {
  const day = '2026-10-08T12:00:00.000Z';
  const now = new Date('2026-10-08T23:00:00.000Z');
  assert.doesNotThrow(() => assertExecutionPreflightReady({
    recordStatus: 'PLANNED', collectedAtIso: day,
    schedulerRow: { is_enabled: true, is_running: false }, liveRunning: false, now,
  }));
  assert.throws(
    () => assertExecutionPreflightReady({
      recordStatus: 'PLANNED', collectedAtIso: day,
      schedulerRow: { is_enabled: true, is_running: true }, liveRunning: false, now,
    }),
    /BENCHMARK_PREREG_SCHEDULER_NOT_STOPPED/
  );
  assert.throws(
    () => assertExecutionPreflightReady({
      recordStatus: 'PLANNED', collectedAtIso: day,
      schedulerRow: { is_enabled: false, is_running: false }, liveRunning: false, now,
    }),
    /BENCHMARK_PREREG_SCHEDULER_NOT_STOPPED/
  );
  assert.throws(
    () => assertExecutionPreflightReady({
      recordStatus: 'PLANNED', collectedAtIso: day,
      schedulerRow: { is_enabled: true, is_running: false }, liveRunning: true, now,
    }),
    /BENCHMARK_PREREG_SCHEDULER_NOT_STOPPED/
  );
  assert.throws(
    () => assertExecutionPreflightReady({
      recordStatus: 'PLANNED', collectedAtIso: '2026-10-07T12:00:00.000Z',
      schedulerRow: { is_enabled: true, is_running: false }, liveRunning: false, now,
    }),
    /BENCHMARK_PREREG_PLAN_STALE/
  );
  assert.doesNotThrow(() => assertExecutionPreflightReady({
    recordStatus: 'IN_PROGRESS', collectedAtIso: '2026-10-07T12:00:00.000Z',
    schedulerRow: { is_enabled: true, is_running: false }, liveRunning: false, now,
  }));
});