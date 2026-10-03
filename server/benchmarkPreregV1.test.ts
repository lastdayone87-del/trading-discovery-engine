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
  });
  assert.equal(record.specVersion, 'benchmark-preregistration-v1');
  assert.equal(record.frozenBaseCommit, '4b49e0c01ac53eebf0080fae29bd6aaabb803cfc');
  assert.equal(record.designatedOpportunities.length, 5);
  assert.equal(record.designatedOpportunities[0].benchmarkOpportunityId, `benchmark-prereg-v1:pool:${snapshot.snapshotHash}:1`);
  assert.equal(record.status, 'PLANNED');
  assert.throws(
    () => buildExecutionRecord({
      runningCommit: 'test-commit', poolSnapshot: snapshot, configurationHash: 'x', maxMigrationVersion: 100, providerRegistry: [],
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
