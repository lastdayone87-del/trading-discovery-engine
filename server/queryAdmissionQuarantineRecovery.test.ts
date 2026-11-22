import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateAdmissionQuarantineRecovery } from './queryAdmissionQuarantineRecovery';

test('historically productive quarantined queries are restored to EXPERIMENTAL, never promoted directly to PROVEN', () => {
  for (const row of [
    { qualityChannelsFound: 666, uniqueChannelsFound: 291 },
    { qualityChannelsFound: 199, uniqueChannelsFound: 0 },
    { qualityChannelsFound: 200, uniqueChannelsFound: 0 },
    { qualityChannelsFound: 55, uniqueChannelsFound: 54 },
    { qualityChannelsFound: 1, uniqueChannelsFound: 0 },
    { qualityChannelsFound: 0, uniqueChannelsFound: 1 },
    { qualityChannelsFound: 0, uniqueChannelsFound: 110 },
  ]) {
    assert.deepEqual(evaluateAdmissionQuarantineRecovery(row), {
      restore: true,
      collection: 'EXPERIMENTAL',
      reason: 'HISTORICAL_YIELD',
    });
  }
});

test('queries without historical yield stay rejected for manual review', () => {
  assert.deepEqual(evaluateAdmissionQuarantineRecovery({ qualityChannelsFound: 0, uniqueChannelsFound: 0 }), {
    restore: false,
    collection: null,
    reason: 'NO_HISTORICAL_YIELD',
  });
});

test('apply is fenced by the exact reviewed hold and rejected status', () => {
  const script = readFileSync(new URL('../scripts/releaseAdmissionQuarantine.ts', import.meta.url), 'utf8');
  assert.match(script, /AND status='REJECTED'/);
  assert.match(script, /AND generation_metadata->'queryHold'=\$3::jsonb/);
  assert.match(script, /reasonCodes' \? 'ADMISSION_REJECTED_SHARE_HIGH'/);
  assert.match(script, /restoreCollection: decision\.collection/);
});
