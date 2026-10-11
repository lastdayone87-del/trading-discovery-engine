import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  SEARCH_WORKER_CONCURRENCY_DEFAULT,
  resolveSearchWorkerCount,
} from './queueManager';
import {
  DISCOVERY_TARGET_QUEUE_DEPTH_DEFAULT,
  resolveDiscoveryTargetQueueDepth,
} from './autonomousDiscovery';
import {
  BENCHMARK_PREREG_DRIFT_KNOBS,
  effectiveBenchmarkKnobs,
} from './benchmarkPreregV1';

test('search worker code default is 4 (permanent default)', () => {
  assert.equal(SEARCH_WORKER_CONCURRENCY_DEFAULT, 4);
});

test('unset SEARCH_WORKER_CONCURRENCY resolves to 4', () => {
  assert.equal(resolveSearchWorkerCount({}), 4);
  assert.equal(resolveSearchWorkerCount({ SEARCH_WORKER_CONCURRENCY: '' }), 4);
});

test('explicit SEARCH_WORKER_CONCURRENCY values keep prior validation', () => {
  assert.equal(resolveSearchWorkerCount({ SEARCH_WORKER_CONCURRENCY: '2' }), 2);
  assert.equal(resolveSearchWorkerCount({ SEARCH_WORKER_CONCURRENCY: '4' }), 4);
  // Zero is floored to one worker, exactly as before: the `|| DEFAULT`
  // fallback applies only when the variable is unset/empty, and
  // Math.max(1, …) still guards explicitly supplied values.
  assert.equal(resolveSearchWorkerCount({ SEARCH_WORKER_CONCURRENCY: '0' }), 1);
  // Non-numeric input yields NaN out of Number(); startWorkerPool clamps it
  // to one loop via `Math.floor(NaN) || 1`. Pinned here so the behavior is
  // documented, not silently changed by the refactor.
  assert.ok(Number.isNaN(resolveSearchWorkerCount({ SEARCH_WORKER_CONCURRENCY: 'abc' })));
});

test('startSearchWorkers consumes the resolver (not a hardcoded 1)', () => {
  const source = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
  assert.match(source, /startWorkerPool\('SEARCH_YOUTUBE', resolveSearchWorkerCount\(\)/);
});

test('queue-depth code fallback is 30', () => {
  assert.equal(DISCOVERY_TARGET_QUEUE_DEPTH_DEFAULT, 30);
});

test('queue-depth precedence: database over environment over fallback', () => {
  // Production holds an explicit database value of 30 (verified read-only);
  // it must keep winning regardless of environment or fallback. These tests
  // never touch the database — they exercise the pure precedence helper.
  assert.equal(resolveDiscoveryTargetQueueDepth('30', '15'), 30);
  assert.equal(resolveDiscoveryTargetQueueDepth('30', undefined), 30);
  assert.equal(resolveDiscoveryTargetQueueDepth(undefined, '20'), 20);
  assert.equal(resolveDiscoveryTargetQueueDepth(undefined, undefined), 30);
  assert.equal(resolveDiscoveryTargetQueueDepth('', ''), 30);
  // Validation preserved from numericSetting: garbage falls back to the
  // default and out-of-range values clamp to [1, 500].
  assert.equal(resolveDiscoveryTargetQueueDepth('abc', undefined), 30);
  assert.equal(resolveDiscoveryTargetQueueDepth('0', undefined), 1);
  assert.equal(resolveDiscoveryTargetQueueDepth('999', undefined), 500);
});

test('getDiscoveryConfig resolves depth through the precedence helper', () => {
  const source = readFileSync(new URL('./autonomousDiscovery.ts', import.meta.url), 'utf8');
  assert.match(source, /resolveDiscoveryTargetQueueDepth\(\s*await getAppSetting\('discovery_target_queue_depth'/);
  assert.doesNotMatch(source, /discovery_target_queue_depth', 'DISCOVERY_TARGET_QUEUE_DEPTH', 15/);
});

test('frozen benchmark fallback divergence is explicit (15 vs runtime 30)', () => {
  // server/benchmarkPreregV1.ts is frozen and must not be edited: its drift
  // table pins fallback '15' as a historical record. The runtime fallback is
  // now 30, and drift detection resolves plan and execute through the same
  // frozen table, so it cannot catch this divergence on environments without
  // an explicit value. Pin both sides here so a future runtime-default change
  // forces revisiting docs/operations-capacity-defaults.md instead of
  // silently misrepresenting effective configuration in benchmark records.
  const frozen = BENCHMARK_PREREG_DRIFT_KNOBS.find(knob => knob.setting === 'discovery_target_queue_depth');
  assert.ok(frozen, 'frozen drift table must still list discovery_target_queue_depth');
  assert.equal(frozen?.fallback, '15');
  assert.equal(String(DISCOVERY_TARGET_QUEUE_DEPTH_DEFAULT), '30');
  // The safe path works through the frozen table untouched: an explicit
  // database/environment value of 30 (production holds database 30) records
  // 30 at both plan and execute time.
  assert.equal(
    effectiveBenchmarkKnobs({ discovery_target_queue_depth: '30' }, {}).discovery_target_queue_depth,
    '30',
  );
});

test('historical readiness report keeps its 2026-07-29 values', () => {
  // docs/production-readiness-report.md is a historical snapshot dated
  // 2026-07-29: its defaults must stay as they were. Current defaults live
  // in docs/operations-capacity-defaults.md, Dockerfile, code, and
  // .env.example (pinned by the consistency test above).
  const report = readFileSync(new URL('../docs/production-readiness-report.md', import.meta.url), 'utf8');
  assert.match(report, /Date: 2026-07-29/);
  assert.match(report, /\| `DISCOVERY_TARGET_QUEUE_DEPTH` \| Optional autonomous queue watermark; default 15\. \|/);
  assert.match(report, /\| `SEARCH_WORKER_CONCURRENCY` \| Search worker count; default 1\. \|/);
});
test('Dockerfile, application, and .env.example defaults agree', () => {
  const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const baked = dockerfile.match(/^\s*SEARCH_WORKER_CONCURRENCY=(\d+)\s*$/m);
  assert.ok(baked, 'Dockerfile must bake SEARCH_WORKER_CONCURRENCY');
  assert.equal(Number(baked[1]), SEARCH_WORKER_CONCURRENCY_DEFAULT);
  const exampleWorker = example.match(/^SEARCH_WORKER_CONCURRENCY="(\d+)"\s*$/m);
  assert.ok(exampleWorker, '.env.example must document SEARCH_WORKER_CONCURRENCY');
  assert.equal(Number(exampleWorker[1]), SEARCH_WORKER_CONCURRENCY_DEFAULT);
  const exampleDepth = example.match(/^DISCOVERY_TARGET_QUEUE_DEPTH="(\d+)"\s*$/m);
  assert.ok(exampleDepth, '.env.example must document DISCOVERY_TARGET_QUEUE_DEPTH');
  assert.equal(Number(exampleDepth[1]), DISCOVERY_TARGET_QUEUE_DEPTH_DEFAULT);
});
