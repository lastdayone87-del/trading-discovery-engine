import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateEnrichmentQuotaReserve } from './dbCore';

const productionShape = {
  dailyBudget: 580_000,
  actualUsed: 346_193,
  reservedTotal: 0,
  dueStage1: 5_784,
  dueStage2: 19,
  recentAutonomousUnits: 744_400,
  recentEnrichmentUnits: 54_093,
};

test('the reserve covers actual due demand while discovery keeps the rest', () => {
  const result = calculateEnrichmentQuotaReserve(productionShape);
  assert.equal(result.dueDemandUnits, 13_525);
  assert.equal(result.remainingUnits, 233_807);
  assert.equal(result.protectedShare, 0.1);
  assert.equal(result.reserveUnits, 13_525);
  assert.equal(result.discoveryAvailableUnits, 220_282);
  assert.ok(result.reserveUnits < result.remainingUnits / 2);
});

test('the reserve falls to zero when there is no due enrichment', () => {
  const result = calculateEnrichmentQuotaReserve({ ...productionShape, dueStage1: 0, dueStage2: 0 });
  assert.equal(result.reserveUnits, 0);
  assert.equal(result.discoveryAvailableUnits, result.remainingUnits);
});

test('a larger backlog raises the reserve but never takes more than half the remaining pool', () => {
  const result = calculateEnrichmentQuotaReserve({
    ...productionShape,
    dueStage1: 10_000,
    dueStage2: 1_000,
  });
  assert.equal(result.dueDemandUnits, 123_000);
  assert.equal(result.protectedShare, 0.1);
  assert.equal(result.reserveUnits, 23_380);
  assert.equal(result.discoveryAvailableUnits, 210_427);
});

test('recent enrichment consumption raises the protected share up to the fairness ceiling', () => {
  const result = calculateEnrichmentQuotaReserve({
    ...productionShape,
    dueStage1: 10_000,
    dueStage2: 1_000,
    recentAutonomousUnits: 100_000,
    recentEnrichmentUnits: 150_000,
  });
  assert.equal(result.protectedShare, 0.5);
  assert.equal(result.reserveUnits, 116_903);
  assert.equal(result.discoveryAvailableUnits, 116_904);
});

test('no consumption history uses the conservative ten-percent share, not a fixed unit reservation', () => {
  const result = calculateEnrichmentQuotaReserve({
    ...productionShape,
    recentAutonomousUnits: 0,
    recentEnrichmentUnits: 0,
  });
  assert.equal(result.protectedShare, 0.1);
  assert.equal(result.reserveUnits, 13_525);
  assert.ok(result.reasonCodes.includes('NO_RECENT_CONSUMPTION_HISTORY'));
});

test('a fully consumed budget protects nothing and leaves discovery at zero', () => {
  const result = calculateEnrichmentQuotaReserve({ ...productionShape, actualUsed: 580_000 });
  assert.equal(result.remainingUnits, 0);
  assert.equal(result.reserveUnits, 0);
  assert.equal(result.discoveryAvailableUnits, 0);
});
