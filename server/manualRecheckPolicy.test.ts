import test from 'node:test';
import assert from 'node:assert/strict';
import { canContinueCommunityInspectionAfterDegradedManualClassification } from './manualRecheckPolicy';

test('already-confirmed trading creator can continue community inspection on classification coverage degradation', () => {
  assert.equal(canContinueCommunityInspectionAfterDegradedManualClassification({
    existingTradingStatus: 'TRADING_CONFIRMED',
    errorCode: 'MANUAL_RESCAN_CLASSIFICATION_DEGRADED'
  }), true);
});

test('uncertain or non-trading creator cannot bypass reliable reclassification', () => {
  for (const status of ['UNCERTAIN', 'NON_TRADING', 'NEEDS_REVIEW', 'HUMAN_REJECTED']) {
    assert.equal(canContinueCommunityInspectionAfterDegradedManualClassification({
      existingTradingStatus: status,
      errorCode: 'MANUAL_RESCAN_CLASSIFICATION_DEGRADED'
    }), false);
  }
});

test('confirmed creator does not bypass unrelated manual recheck failures', () => {
  for (const code of ['MANUAL_RESCAN_UPSTREAM_FAILURE', 'QUOTA_ALLOCATION_EXHAUSTED', 'MANUAL_RESCAN_OPERATIONAL_FAILURE']) {
    assert.equal(canContinueCommunityInspectionAfterDegradedManualClassification({
      existingTradingStatus: 'TRADING_CONFIRMED',
      errorCode: code
    }), false);
  }
});
