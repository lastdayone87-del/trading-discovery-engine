import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAdmissionQuarantineRecovery } from './queryAdmissionQuarantineRecovery';

test('productive historically quarantined queries are restored at the right collection tier', () => {
  assert.deepEqual(evaluateAdmissionQuarantineRecovery({ qualityChannelsFound: 666, uniqueChannelsFound: 291 }), {
    restore: true,
    collection: 'PROVEN',
    reason: 'HIGH_HISTORICAL_QUALITY',
  });
  assert.deepEqual(evaluateAdmissionQuarantineRecovery({ qualityChannelsFound: 55, uniqueChannelsFound: 54 }), {
    restore: true,
    collection: 'EXPERIMENTAL',
    reason: 'HISTORICAL_YIELD',
  });
  assert.deepEqual(evaluateAdmissionQuarantineRecovery({ qualityChannelsFound: 0, uniqueChannelsFound: 110 }), {
    restore: true,
    collection: 'EXPERIMENTAL',
    reason: 'HISTORICAL_YIELD',
  });
});

test('queries without historical yield stay rejected for manual review', () => {
  assert.deepEqual(evaluateAdmissionQuarantineRecovery({ qualityChannelsFound: 0, uniqueChannelsFound: 0 }), {
    restore: false,
    collection: null,
    reason: 'NO_HISTORICAL_YIELD',
  });
});
