import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fingerprintSamplingSalt } from './phaseBCollectionEpoch';
import { isValidRetrievalSamplingPolicy } from './phaseBObservationOutbox';

test('phase b sampling salt fingerprint uses the normalized effective salt', () => {
  assert.equal(fingerprintSamplingSalt(' deployment-salt '), fingerprintSamplingSalt('deployment-salt'));
  assert.equal(fingerprintSamplingSalt('   '), '');
});

test('retrieval sampling policy validation rejects malformed queued identities', () => {
  const base = {
    policyKey: 'protected-audit',
    version: 1,
    salt: 'deployment-salt',
    protectedAuditBasisPoints: 100,
    targetedAuditBasisPoints: 0,
  };
  assert.equal(isValidRetrievalSamplingPolicy(base), true);
  assert.equal(isValidRetrievalSamplingPolicy({ ...base, policyKey: '   ' }), false);
  assert.equal(isValidRetrievalSamplingPolicy({ ...base, salt: '   ' }), false);
  assert.equal(isValidRetrievalSamplingPolicy({ ...base, version: 0 }), false);
  assert.equal(isValidRetrievalSamplingPolicy({ ...base, version: '1' as unknown as number }), false);
});

test('queued invalid retrieval assignments are retired before execution instead of retried', () => {
  const source = readFileSync(new URL('./phaseBObservationOutbox.ts', import.meta.url), 'utf8');
  const validationIndex = source.indexOf("payload.type === 'RETRIEVAL_ASSIGNMENT' && !isValidRetrievalSamplingPolicy(payload.policy)");
  const processingIndex = source.indexOf("status='PROCESSING'");
  assert.ok(validationIndex >= 0, 'queued retrieval assignments must be revalidated');
  assert.ok(processingIndex > validationIndex, 'invalid retrieval assignments must retire before PROCESSING/attempt increment');
  assert.match(source, /INSERT INTO phase_b_observation_retirements/);
  assert.match(source, /INVALID_RETRIEVAL_SAMPLING_POLICY/);
  assert.match(source, /DELETE FROM phase_b_observation_outbox/);
});
