import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_PROVEN_POLICY, resolveProvenPolicy } from './provenPolicy';

test('PROVEN policy preserves the production default when no setting exists', () => {
  assert.deepEqual(resolveProvenPolicy('', ''), { ...DEFAULT_PROVEN_POLICY });
  assert.deepEqual(resolveProvenPolicy(undefined, undefined), { ...DEFAULT_PROVEN_POLICY });
});

test('PROVEN policy clamps malformed or extreme settings', () => {
  assert.deepEqual(resolveProvenPolicy('0.05', '2'), { threshold: 0.05, minRuns: 2, source: 'setting' });
  assert.deepEqual(resolveProvenPolicy('-1', '0'), { ...DEFAULT_PROVEN_POLICY });
  assert.equal(resolveProvenPolicy('999', '999').threshold, 100);
  assert.equal(resolveProvenPolicy('999', '999').minRuns, 20);
  assert.equal(resolveProvenPolicy('0.0001', '1').threshold, 0.001);
  assert.equal(resolveProvenPolicy('not-a-number', '4').threshold, DEFAULT_PROVEN_POLICY.threshold);
  assert.equal(resolveProvenPolicy('not-a-number', '4').minRuns, 4);
});
