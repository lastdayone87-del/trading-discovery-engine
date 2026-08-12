import assert from 'node:assert/strict';
import test from 'node:test';
import { assignStage2LimitedCanary, buildStage2LimitedCanaryDesign, STAGE2_LIMITED_CANARY_POLICY } from './stage2LimitedCanaryDesign';

test('limited canary remains disabled while kill switch is OFF', async () => {
  const result = await assignStage2LimitedCanary('channel-1', 'OFF');
  assert.equal(result.assigned, false);
  assert.equal(result.mode, 'OFF');
  assert.equal(result.servingAuthority, false);
});

test('limited canary assignment is deterministic and bounded at 5 percent', async () => {
  const reserve = async () => true;
  const a = await assignStage2LimitedCanary('channel-42', 'CANARY', reserve);
  const b = await assignStage2LimitedCanary('channel-42', 'CANARY', reserve);
  assert.equal(a.randomizationValue, b.randomizationValue);
  assert.equal(a.basisPoints, STAGE2_LIMITED_CANARY_POLICY.allocationBasisPoints);
  assert.equal(a.servingAuthority, false);
});

test('bucket hit fails closed without an atomic treatment-slot reservation', async () => {
  let bucketHit: Awaited<ReturnType<typeof assignStage2LimitedCanary>> | undefined;
  for (let i = 0; i < 5000; i += 1) {
    const result = await assignStage2LimitedCanary(`candidate-${i}`, 'CANARY');
    if (result.reason === 'ATOMIC_TREATMENT_SLOT_RESERVATION_REQUIRED') {
      bucketHit = result;
      break;
    }
  }
  assert.ok(bucketHit, 'expected to find at least one deterministic 5% bucket hit');
  assert.equal(bucketHit.assigned, false);
});

test('atomic reservation prevents a 51st treatment subject', async () => {
  const admitted = new Set<string>();
  const reserve = async (subjectKey: string, maximumTreatmentSubjects: number) => {
    if (admitted.has(subjectKey)) return true;
    if (admitted.size >= maximumTreatmentSubjects) return false;
    admitted.add(subjectKey);
    return true;
  };

  let capRejectionSeen = false;
  for (let i = 0; i < 10000; i += 1) {
    const subjectKey = `cap-candidate-${i}`;
    const result = await assignStage2LimitedCanary(subjectKey, 'CANARY', reserve);
    if (result.reason === 'TREATMENT_SUBJECT_CAP_REACHED') {
      capRejectionSeen = true;
      break;
    }
  }

  assert.equal(admitted.size, STAGE2_LIMITED_CANARY_POLICY.maximumTreatmentSubjects);
  assert.equal(capRejectionSeen, true, 'expected a 51st bucket hit to be rejected by the hard cap');
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
  assert.equal(report.allocation.maximumTreatmentSubjects, 50);
  assert.equal(report.allocation.hardCapEnforcement, 'ATOMIC_SLOT_RESERVATION_REQUIRED');
  assert.equal(report.promotionCriteria.maximumConfirmedGenuineFalseWithholds, 0);
});
