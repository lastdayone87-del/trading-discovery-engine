import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_PROVEN_POLICY, resolveProvenPolicy } from './provenPolicy';

test('PROVEN policy preserves the production default when no setting exists', () => {
  assert.deepEqual(resolveProvenPolicy('', ''), { ...DEFAULT_PROVEN_POLICY });
  assert.deepEqual(resolveProvenPolicy(undefined, undefined), { ...DEFAULT_PROVEN_POLICY });
});

test('PROVEN policy rejects malformed or out-of-range settings', () => {
  assert.deepEqual(resolveProvenPolicy('0.05', '2'), { threshold: 0.05, minRuns: 2, source: 'setting' });
  assert.deepEqual(resolveProvenPolicy('-1', '0'), { ...DEFAULT_PROVEN_POLICY });
  // Out-of-range values fall back to the default instead of being clamped
  // into a policy that bans or promotes effectively every query.
  assert.equal(resolveProvenPolicy('999', '999').threshold, DEFAULT_PROVEN_POLICY.threshold);
  assert.equal(resolveProvenPolicy('999', '999').minRuns, DEFAULT_PROVEN_POLICY.minRuns);
  assert.equal(resolveProvenPolicy('0.0001', '1').threshold, DEFAULT_PROVEN_POLICY.threshold);
  assert.equal(resolveProvenPolicy('0.0001', '1').minRuns, 1);
  assert.equal(resolveProvenPolicy('1.5', '2').threshold, DEFAULT_PROVEN_POLICY.threshold);
  assert.equal(resolveProvenPolicy('0.5', '2.5').minRuns, DEFAULT_PROVEN_POLICY.minRuns);
  assert.equal(resolveProvenPolicy('not-a-number', '4').threshold, DEFAULT_PROVEN_POLICY.threshold);
  assert.equal(resolveProvenPolicy('not-a-number', '4').minRuns, 4);
});
