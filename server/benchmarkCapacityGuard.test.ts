import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  BENCHMARK_REQUIRED_QUEUE_DEPTH,
  assertBenchmarkPlannedQueueDepth,
  assertBenchmarkQueueDepthEstablished,
  resolveBenchmarkQueueDepth,
} from './benchmarkCapacityGuard';

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
  assert.throws(
    () => assertBenchmarkPlannedQueueDepth({ discovery_target_queue_depth: '15' }, 'execute'),
    /BENCHMARK_QUEUE_DEPTH_UNESTABLISHED/
  );
  assert.throws(
    () => assertBenchmarkPlannedQueueDepth({}, 'execute'),
    /BENCHMARK_QUEUE_DEPTH_UNESTABLISHED/
  );
});

test('runner enforces the guard before plan files and before IN_PROGRESS', () => {
  const script = readFileSync(new URL('../scripts/runBenchmarkPreregV1.ts', import.meta.url), 'utf8');
  assert.match(script, /assertBenchmarkQueueDepthEstablished\(settings, process\.env, 'plan'\)/);
  assert.match(
    script,
    /assertBenchmarkQueueDepthEstablished\(settings, process\.env, 'execute'\)[\s\S]*assertBenchmarkPlannedQueueDepth\(record\.plannedKnobs, 'execute'\)[\s\S]*record\.status = 'IN_PROGRESS'/
  );
});
