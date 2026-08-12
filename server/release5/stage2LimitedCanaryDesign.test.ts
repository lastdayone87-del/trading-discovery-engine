import assert from 'node:assert/strict';
import test from 'node:test';
import { assignStage2LimitedCanary, buildStage2LimitedCanaryDesign, STAGE2_LIMITED_CANARY_POLICY } from './stage2LimitedCanaryDesign';

test('limited canary remains disabled while kill switch is OFF', () => {
  const result = assignStage2LimitedCanary('channel-1', 'OFF');
  assert.equal(result.assigned, false);
  assert.equal(result.mode, 'OFF');
  assert.equal(result.servingAuthority, false);
});

test('limited canary assignment is deterministic and bounded at 5 percent', () => {
  const a = assignStage2LimitedCanary('channel-42', 'CANARY');
  const b = assignStage2LimitedCanary('channel-42', 'CANARY');
  assert.deepEqual(a, b);
  assert.equal(a.basisPoints, STAGE2_LIMITED_CANARY_POLICY.allocationBasisPoints);
  assert.equal(a.servingAuthority, false);
});

test('design fails closed when guarded gate is not ready', () => {
  const report = buildStage2LimitedCanaryDesign({ gateStatus: 'NOT_READY' });
  assert.equal(report.designStatus, 'BLOCKED');
  assert.equal(report.productionActivation, false);
});

test('ready design includes explicit kill switch and no automatic promotion', () => {
  const report: any = buildStage2LimitedCanaryDesign({
    gateStatus: 'READY_FOR_LIMITED_CANARY_DESIGN',
    datasetId: 'dataset-1',
    version: 'gate-v1',
    outputChecksum: 'abc'
  });
  assert.equal(report.designStatus, 'READY_FOR_EXPLICIT_ACTIVATION_IMPLEMENTATION');
  assert.equal(report.killSwitch.defaultMode, 'OFF');
  assert.equal(report.killSwitch.manualEnableRequired, true);
  assert.equal(report.automaticPromotion, false);
  assert.equal(report.productionActivation, false);
  assert.equal(report.allocation.basisPoints, 500);
  assert.equal(report.promotionCriteria.maximumConfirmedGenuineFalseWithholds, 0);
});
