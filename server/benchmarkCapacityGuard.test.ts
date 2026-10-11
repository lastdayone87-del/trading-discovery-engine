import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  BENCHMARK_REQUIRED_QUEUE_DEPTH,
  assertBenchmarkExecutionArtifactsEligible,
  assertBenchmarkPlannedQueueDepth,
  assertBenchmarkQueueDepthEstablished,
  benchmarkValidatedQueueDepth,
  resolveBenchmarkQueueDepth,
} from './benchmarkCapacityGuard';
import {
  buildExecutionRecord,
  buildPoolSnapshot,
  computeConfigurationHash,
  effectiveBenchmarkKnobs,
  planRowAttempt,
} from './benchmarkPreregV1';
import type { QueryRecord } from '../src/types';
import {
  resolveCycleTargetQueueDepth,
  resolveDiscoveryTargetQueueDepth,
} from './autonomousDiscovery';

test('required benchmark queue depth is 30', () => {
  assert.equal(BENCHMARK_REQUIRED_QUEUE_DEPTH, 30);
});

test('explicit database value of 30 establishes the benchmark', () => {
  assert.deepEqual(resolveBenchmarkQueueDepth({ discovery_target_queue_depth: '30' }, {}), {
    resolved: '30',
    explicit: true,
  });
  assertBenchmarkQueueDepthEstablished({ discovery_target_queue_depth: '30' }, {}, 'plan');
  assertBenchmarkQueueDepthEstablished({ discovery_target_queue_depth: '30' }, {}, 'execute');
});

test('explicit environment value of 30 establishes the benchmark', () => {
  assert.deepEqual(
    resolveBenchmarkQueueDepth({}, { DISCOVERY_TARGET_QUEUE_DEPTH: '30' }),
    { resolved: '30', explicit: true }
  );
  assertBenchmarkQueueDepthEstablished({}, { DISCOVERY_TARGET_QUEUE_DEPTH: '30' }, 'plan');
});

test('absent value fails closed before plan or execute', () => {
  // Frozen fallback '15' would govern the record while the runtime operates
  // at 30: the exact divergence this guard exists to prevent.
  assert.deepEqual(resolveBenchmarkQueueDepth({}, {}), { resolved: '15', explicit: false });
  assert.throws(
    () => assertBenchmarkQueueDepthEstablished({}, {}, 'plan'),
    /BENCHMARK_QUEUE_DEPTH_UNESTABLISHED/
  );
  assert.throws(
    () => assertBenchmarkQueueDepthEstablished({}, {}, 'execute'),
    /BENCHMARK_QUEUE_DEPTH_UNESTABLISHED/
  );
});

test('explicit non-30 value fails closed', () => {
  assert.throws(
    () => assertBenchmarkQueueDepthEstablished({ discovery_target_queue_depth: '15' }, {}, 'plan'),
    /BENCHMARK_QUEUE_DEPTH_UNESTABLISHED/
  );
  assert.throws(
    () => assertBenchmarkQueueDepthEstablished({ discovery_target_queue_depth: '20' }, {}, 'execute'),
    /BENCHMARK_QUEUE_DEPTH_UNESTABLISHED/
  );
  assert.throws(
    () => assertBenchmarkQueueDepthEstablished({ discovery_target_queue_depth: 'abc' }, {}, 'plan'),
    /BENCHMARK_QUEUE_DEPTH_UNESTABLISHED/
  );
});

test('plan record must evidence 30 before it may execute', () => {
  assertBenchmarkPlannedQueueDepth({ discovery_target_queue_depth: '30' }, 'execute');
  // Equivalent valid representations round-trip: the frozen record builder
  // stores the raw string, so the record check uses the same numeric
  // comparison as the live guard.
  assertBenchmarkPlannedQueueDepth({ discovery_target_queue_depth: '30.0' }, 'execute');
  assert.throws(
    () => assertBenchmarkPlannedQueueDepth({ discovery_target_queue_depth: '15' }, 'execute'),
    /BENCHMARK_QUEUE_DEPTH_UNESTABLISHED/
  );
  assert.throws(
    () => assertBenchmarkPlannedQueueDepth({ discovery_target_queue_depth: '30.5' }, 'execute'),
    /BENCHMARK_QUEUE_DEPTH_UNESTABLISHED/
  );
  assert.throws(
    () => assertBenchmarkPlannedQueueDepth({}, 'execute'),
    /BENCHMARK_QUEUE_DEPTH_UNESTABLISHED/
  );
});

test('equivalent valid representations plan and execute under unchanged configuration', () => {
  // End-to-end through the real frozen resolver (the same function the
  // record builder uses): whatever string the plan accepts must produce a
  // record the execute check accepts, with settings and env unchanged.
  for (const value of ['30', '30.0', ' 30 ']) {
    const settings = { discovery_target_queue_depth: value };
    assertBenchmarkQueueDepthEstablished(settings, {}, 'plan');
    const recorded = effectiveBenchmarkKnobs(settings, {});
    assert.equal(recorded.discovery_target_queue_depth, value);
    assertBenchmarkPlannedQueueDepth(recorded, 'execute');
  }
  // Near-miss and divergent values fail at BOTH boundaries alike.
  for (const value of ['15', '20', '30.5', 'abc']) {
    const settings = { discovery_target_queue_depth: value };
    assert.throws(
      () => assertBenchmarkQueueDepthEstablished(settings, {}, 'plan'),
      /BENCHMARK_QUEUE_DEPTH_UNESTABLISHED/
    );
    assert.throws(
      () => assertBenchmarkPlannedQueueDepth(effectiveBenchmarkKnobs(settings, {}), 'execute'),
      /BENCHMARK_QUEUE_DEPTH_UNESTABLISHED/
    );
  }
});

test('empty database value counts as absent (runtime-consistent)', () => {
  // A stray empty database row must neither shadow an explicit environment
  // value nor fabricate explicitness — matching resolveDiscoveryTargetQueueDepth.
  assert.deepEqual(resolveBenchmarkQueueDepth({ discovery_target_queue_depth: '' }, { DISCOVERY_TARGET_QUEUE_DEPTH: '30' }), {
    resolved: '30',
    explicit: true,
  });
  assertBenchmarkQueueDepthEstablished({ discovery_target_queue_depth: '' }, { DISCOVERY_TARGET_QUEUE_DEPTH: '30' }, 'plan');
  assert.deepEqual(resolveBenchmarkQueueDepth({ discovery_target_queue_depth: '' }, {}), {
    resolved: '15',
    explicit: false,
  });
  assert.throws(
    () => assertBenchmarkQueueDepthEstablished({ discovery_target_queue_depth: '' }, {}, 'plan'),
    /BENCHMARK_QUEUE_DEPTH_UNESTABLISHED/
  );
});

test('empty database value fails planning before files, never at execution', () => {
  // Complete plan-to-execute path for DB '' + env '30': the live guard
  // normalizes the empty row as absent and passes, but the frozen record
  // builder preserves the raw empty string in plannedKnobs — so the plan
  // itself must be refused before any file is written, never at execution.
  const settings = { discovery_target_queue_depth: '' };
  const env = { DISCOVERY_TARGET_QUEUE_DEPTH: '30' };
  assertBenchmarkQueueDepthEstablished(settings, env, 'plan');
  const recorded = effectiveBenchmarkKnobs(settings, env);
  assert.equal(recorded.discovery_target_queue_depth, '');
  assert.throws(
    () => assertBenchmarkPlannedQueueDepth(recorded, 'plan'),
    /BENCHMARK_QUEUE_DEPTH_UNESTABLISHED/
  );
  // After remediation (empty row deleted), the full path plans and executes.
  const fixed = effectiveBenchmarkKnobs({}, env);
  assert.equal(fixed.discovery_target_queue_depth, '30');
  assertBenchmarkPlannedQueueDepth(fixed, 'plan');
  assertBenchmarkQueueDepthEstablished({}, env, 'execute');
  assertBenchmarkPlannedQueueDepth(fixed, 'execute');
});

test('pinned depth is validated against the 1..500 integer bounds', () => {
  assert.equal(resolveCycleTargetQueueDepth(20, 1), 1);
  assert.equal(resolveCycleTargetQueueDepth(20, 500), 500);
  assert.equal(resolveCycleTargetQueueDepth(20, 30), 30);
  for (const invalid of [Number.NaN, 30.5, 0, -5, 501, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => resolveCycleTargetQueueDepth(20, invalid),
      /BENCHMARK_PINNED_QUEUE_DEPTH_INVALID/
    );
  }
  // Absent pin preserves existing runtime behavior exactly, including live
  // values the runtime resolver itself produces (no live validation added).
  assert.equal(resolveCycleTargetQueueDepth(20, undefined), 20);
  assert.equal(resolveCycleTargetQueueDepth(30.5, undefined), 30.5);
});

test('guard errors name the requested operation', () => {
  assert.throws(
    () => assertBenchmarkQueueDepthEstablished({}, {}, 'plan'),
    /refusing to plan/
  );
  assert.throws(
    () => assertBenchmarkQueueDepthEstablished({}, {}, 'execute'),
    /refusing to execute/
  );
  assert.throws(
    () => benchmarkValidatedQueueDepth({}, {}, 'execute'),
    /refusing to execute/
  );
  assert.throws(
    () => assertBenchmarkPlannedQueueDepth({}, 'plan'),
    /refusing to plan/
  );
  assert.throws(
    () => assertBenchmarkPlannedQueueDepth({}, 'execute'),
    /refusing to execute/
  );
});
test('pinned depth survives a database change after validation', () => {
  // Validate against settings evidencing 30; the returned value is captured
  // once at preflight and threaded into every cycle.
  const validated = benchmarkValidatedQueueDepth({ discovery_target_queue_depth: '30' }, {}, 'execute');
  assert.equal(validated, 30);
  // The database changes before the cycle runs: live resolution now says 20
  // (proved through the real runtime resolver), but the cycle must still use
  // the validated 30 — otherwise the run would execute at a divergent depth
  // while the record stays valid.
  const liveAfterChange = resolveDiscoveryTargetQueueDepth('20', undefined);
  assert.equal(liveAfterChange, 20);
  assert.equal(resolveCycleTargetQueueDepth(liveAfterChange, validated), 30);
  // Without a pin, live resolution flows through unchanged (all existing
  // production callers pass nothing, preserving runtime behavior).
  assert.equal(resolveCycleTargetQueueDepth(liveAfterChange, undefined), 20);
  assert.equal(resolveCycleTargetQueueDepth(30, undefined), 30);
});

test('runner enforces the guard before plan files and before IN_PROGRESS', () => {
  const script = readFileSync(new URL('../scripts/runBenchmarkPreregV1.ts', import.meta.url), 'utf8');
  // Shared preflight names the requested operation (it runs in both modes).
  assert.match(script, /assertBenchmarkQueueDepthEstablished\(settings, process\.env, mode\)/);
  // Plan path refuses a non-evidencing record before any file is written.
  assert.match(
    script,
    /assertBenchmarkPlannedQueueDepth\(record\.plannedKnobs, 'plan'\)[\s\S]*?writeFileSync\(snapshotPath/
  );
  assert.match(
    script,
    /benchmarkValidatedQueueDepth\(settings, process\.env, 'execute'\)[\s\S]*?activeBenchmarkExecutionLock = acquireBenchmarkExecutionLock\(outDir\)[\s\S]*?record\.status = 'IN_PROGRESS'/
  );
  // Every benchmark cycle runs at the validated depth, never re-resolved.
  assert.match(
    script,
    /runAutonomousDiscoveryCycle\(row\.country, undefined, requestId, frozenRequest, \{ pinnedTargetQueueDepth: validatedQueueDepth \}\)/
  );
});

test('cycle applies the pinned depth over live configuration', () => {
  const source = readFileSync(new URL('./autonomousDiscovery.ts', import.meta.url), 'utf8');
  assert.match(
    source,
    /targetQueueDepth: resolveCycleTargetQueueDepth\(config\.targetQueueDepth, discoveryOptions\?\.pinnedTargetQueueDepth\)/
  );
});

function guardEligibleRow(id: number): QueryRecord {
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
  } as QueryRecord;
}

function guardArtifacts(
  appSettings: Array<{ setting_key: string; setting_value: string }> = [
    { setting_key: 'discovery_target_queue_depth', setting_value: '30' },
  ],
  collectedAt = new Date()
) {
  const snapshot = buildPoolSnapshot({
    rows: [guardEligibleRow(1), guardEligibleRow(2)],
    collectedAt,
    cooldownMinutes: 360,
    maxPrimaryUses: 2,
  });
  const record = buildExecutionRecord({
    runningCommit: 'test-commit',
    poolSnapshot: snapshot,
    configurationHash: computeConfigurationHash({ appSettings: [], maxMigrationVersion: 137, providerRegistry: [] }),
    maxMigrationVersion: 137,
    providerRegistry: [],
    appSettings,
  });
  return { record, snapshot };
}

test('eligible artifacts pass for planned and resumable records', () => {
  const { record, snapshot } = guardArtifacts();
  assert.equal(record.status, 'PLANNED');
  assertBenchmarkExecutionArtifactsEligible(record, snapshot, record.specVersion);
  const resumed = { ...record, status: 'IN_PROGRESS' as const };
  assertBenchmarkExecutionArtifactsEligible(resumed, snapshot, record.specVersion);
});

test('a completed record is rejected and can never be overwritten', () => {
  // Delayed-executor scenario: a stale PLANNED copy validates pre-lock, but
  // the freshly reloaded COMPLETE copy refuses post-lock — no mutation or
  // scheduling follows.
  const { record, snapshot } = guardArtifacts();
  assertBenchmarkExecutionArtifactsEligible(record, snapshot, record.specVersion);
  const completed = { ...record, status: 'COMPLETE' as const, stopReason: 'SCOPE_COVERED' };
  assert.throws(
    () => assertBenchmarkExecutionArtifactsEligible(completed, snapshot, record.specVersion),
    /BENCHMARK_PREREG_RECORD_MISMATCH/
  );
});

test('mismatched spec, snapshot, and freshness are rejected', () => {
  const { record, snapshot } = guardArtifacts();
  assert.throws(
    () => assertBenchmarkExecutionArtifactsEligible(record, snapshot, 'definitely-not-a-spec'),
    /BENCHMARK_PREREG_RECORD_MISMATCH/
  );
  const other = buildPoolSnapshot({
    rows: [guardEligibleRow(9)],
    collectedAt: new Date(),
    cooldownMinutes: 360,
    maxPrimaryUses: 2,
  });
  assert.throws(
    () => assertBenchmarkExecutionArtifactsEligible(record, other, record.specVersion),
    /BENCHMARK_PREREG_RECORD_MISMATCH/
  );
  const stale = guardArtifacts(
    [{ setting_key: 'discovery_target_queue_depth', setting_value: '30' }],
    new Date('2020-01-01T00:00:00.000Z')
  );
  assert.throws(
    () => assertBenchmarkExecutionArtifactsEligible(stale.record, stale.snapshot, stale.record.specVersion),
    /BENCHMARK_PREREG_PLAN_STALE/
  );
});

test('record evidencing non-30 depth is rejected with depth error', () => {
  const { record, snapshot } = guardArtifacts([
    { setting_key: 'discovery_target_queue_depth', setting_value: '' },
  ]);
  assert.equal(record.plannedKnobs.discovery_target_queue_depth, '');
  assert.throws(
    () => assertBenchmarkExecutionArtifactsEligible(record, snapshot, record.specVersion),
    /BENCHMARK_QUEUE_DEPTH_UNESTABLISHED/
  );
});

test('runner reloads and revalidates artifacts under lock before mutating', () => {
  const script = readFileSync(new URL('../scripts/runBenchmarkPreregV1.ts', import.meta.url), 'utf8');
  assert.match(
    script,
    /activeBenchmarkExecutionLock = acquireBenchmarkExecutionLock\(outDir\)[\s\S]*?record = JSON\.parse\(readFileSync\(recordPath[\s\S]*?snapshot = JSON\.parse\(readFileSync\(snapshotPath[\s\S]*?assertBenchmarkExecutionArtifactsEligible\(record, snapshot, spec\.specVersion\)[\s\S]*?record\.status = 'IN_PROGRESS'/
  );
  // The post-lock revalidation uses the shared helper (the pre-lock fast
  // fail keeps the original inline checks verbatim for the frozen structural
  // pin, so the helper appears exactly once in the runner).
  assert.equal(
    (script.match(/assertBenchmarkExecutionArtifactsEligible\(record, snapshot, spec\.specVersion\)/g) || []).length,
    1
  );
});

test('plan lock follows the reloaded snapshot; planning holds the lock through writes', () => {
  const script = readFileSync(new URL('../scripts/runBenchmarkPreregV1.ts', import.meta.url), 'utf8');
  // Execute: the global plan lock is keyed on the freshly reloaded snapshot
  // via the database advisory lock shared by every copy of the plan
  // (directories, tmpdirs, and hosts on that database), acquired after
  // revalidation and before any mutation.
  assert.match(
    script,
    /assertBenchmarkExecutionArtifactsEligible\(record, snapshot, spec\.specVersion\)[\s\S]*?activeBenchmarkPlanLock = await acquireBenchmarkPlanLock\(db, snapshot\.snapshotHash\)[\s\S]*?record\.status = 'IN_PROGRESS'/
  );
  // Plan: the execution lock is acquired before the slow planning queries
  // and released before the normal return (throws release via top-level
  // catch), so a --force replan can never write under a live executor. The
  // directory is created before acquisition so fresh --plan targets work.
  assert.match(
    script,
    /refuseActiveBenchmarkExecution\(outDir\);[\s\S]*?mkdirSync\(outDir, \{ recursive: true \}\);[\s\S]*?activeBenchmarkExecutionLock = acquireBenchmarkExecutionLock\(outDir\);[\s\S]*?const libraryRows = /
  );
  assert.match(
    script,
    /releaseActiveBenchmarkExecutionLock\(\);[\s\S]*?await db\.end\(\).catch\(\(\) => undefined\);\s*\n\s*return;/
  );
});

test('a copied plan adopts ledger runs instead of duplicating them', () => {
  // Two executors running copies of one plan share opportunity IDs (derived
  // from the snapshot hash) and the same ledger. A second executor that
  // observes the first executor's runs adopts them rather than scheduling
  // duplicates; only a ledger read that predates all scheduling may still
  // race, which the same-plan execution lock closes on one host.
  assert.equal(planRowAttempt({ covered: false, matchedRunIds: ['run-1'] }), 'adopt-recovered');
  assert.equal(planRowAttempt({ covered: true, matchedRunIds: ['run-1'] }), 'skip-covered');
  assert.equal(planRowAttempt({ covered: false, matchedRunIds: [] }), 'schedule-attempt');
});
