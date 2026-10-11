import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  BENCHMARK_REQUIRED_QUEUE_DEPTH,
  assertBenchmarkPlannedQueueDepth,
  assertBenchmarkQueueDepthEstablished,
  benchmarkValidatedQueueDepth,
  resolveBenchmarkQueueDepth,
} from './benchmarkCapacityGuard';
import { effectiveBenchmarkKnobs } from './benchmarkPreregV1';
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
  assert.match(script, /assertBenchmarkQueueDepthEstablished\(settings, process\.env, 'plan'\)/);
  assert.match(
    script,
    /benchmarkValidatedQueueDepth\(settings, process\.env, 'execute'\)[\s\S]*assertBenchmarkPlannedQueueDepth\(record\.plannedKnobs, 'execute'\)[\s\S]*record\.status = 'IN_PROGRESS'/
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
