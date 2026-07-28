import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveUncertainLifecycle } from './enrichmentLifecycle';

test('first uncertain classification schedules enrichment instead of completing', () => {
  assert.deepEqual(resolveUncertainLifecycle(false), {
    scanStatus: 'ENRICHMENT_PENDING',
    tradingStatus: 'UNCERTAIN',
    shouldEnqueue: true
  });
});

test('uncertain after enrichment becomes a reviewable terminal decision', () => {
  assert.deepEqual(resolveUncertainLifecycle(true), {
    scanStatus: 'NEEDS_REVIEW',
    tradingStatus: 'NEEDS_REVIEW',
    shouldEnqueue: false
  });
});
