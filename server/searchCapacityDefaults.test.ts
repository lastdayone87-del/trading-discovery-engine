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
