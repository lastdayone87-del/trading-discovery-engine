import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import type { QueryRecord } from '../src/types';
import {
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
